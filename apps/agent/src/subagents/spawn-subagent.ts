import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentSessionServices,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { Gate } from './gate'
import { lastAssistant, textOf } from '../conversation/messages'
import { ASSET_NAME, ASSETS_DIR } from '../blender/render'
import { type Role, subagentOpener } from './roles'

/** Blender is a process per render, so this is bounded by cores, not by pi. */
const MAX_CONCURRENT_SUBAGENTS = 4

export function spawnSubagentTool(services: () => AgentSessionServices) {
  const open = subagentOpener(services)
  const gate = new Gate(MAX_CONCURRENT_SUBAGENTS)

  return defineTool({
    name: 'spawn_subagent',
    label: 'Delegate',
    description: `Hand a task to a subagent that works on its own session and reports back in text; its renders never enter your context. An asset_builder task makes exactly one object or architectural component, never a room or area, in ${ASSETS_DIR}/<name>.py and uses visual and physics previews as needed to refine its render geometry and collision representation until they are high fidelity. A critic looks at the built scene and its physics from angles it chooses and reports what is wrong against the request; build with run_blender first. Spawn separate builders together to run them in parallel.`,
    promptSnippet:
      'hand a task to an asset builder or a critic on its own session',
    executionMode: 'parallel',
    parameters: Type.Object({
      role: Type.Union(
        [Type.Literal('asset_builder'), Type.Literal('critic')],
        {
          description: 'asset_builder or critic.',
        },
      ),
      task: Type.String({
        description:
          'For asset_builder, a self-contained brief for exactly one object: its dimensions in metres, proportions, construction details, materials and colours, style, orientation, origin, adjacent dimensions it must match, unique instance naming, whether it is solid or penetrable, its simplified collision shape when solid, and the required high-poly fidelity. Never brief a room, area, or collection. For critic, what was asked for and what visual and playable physics to judge.',
      }),
      name: Type.Optional(
        Type.String({
          description: `asset_builder only: the module to write, as ${ASSETS_DIR}/<name>.py, a Python identifier.`,
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const role: Role = params.role
      const name = params.name
      if (
        role === 'asset_builder' &&
        (name === undefined || !ASSET_NAME.test(name))
      ) {
        throw new Error(
          `An asset_builder needs a name for its module: a Python identifier, as ${ASSETS_DIR}/<name>.py.`,
        )
      }
      const label = name ?? role
      const release = await gate.acquire(signal)
      try {
        const session = await open(ctx, role)
        const abort = () => void session.abort()
        signal?.addEventListener('abort', abort, { once: true })
        try {
          let toolCalls = 0
          session.subscribe((event) => {
            if (event.type !== 'tool_execution_start') return
            toolCalls += 1
            onUpdate?.({
              content: [
                {
                  type: 'text',
                  text: `${label}: ${event.toolName} (${toolCalls} tool calls so far)`,
                },
              ],
              details: { role, name, toolCalls },
            })
          })
          await session.prompt(
            role === 'asset_builder'
              ? `Build ${ASSETS_DIR}/${name}.py.\n\n${params.task}`
              : params.task,
          )

          const last = lastAssistant(session.messages)
          const report = last === undefined ? '' : textOf(last)
          if (last?.stopReason === 'aborted' || last?.stopReason === 'error') {
            throw new Error(
              `The ${label} subagent ${last.stopReason === 'aborted' ? 'was cancelled' : 'failed'}: ${last.errorMessage ?? report}`,
            )
          }
          if (role === 'asset_builder') {
            const module = await readFile(
              join(ctx.cwd, ASSETS_DIR, `${name}.py`),
              'utf8',
            ).catch(() => undefined)
            if (module === undefined) {
              throw new Error(
                `The builder finished without writing ${ASSETS_DIR}/${name}.py.\n\n${report}`,
              )
            }
            if (!/^def build\(/m.test(module)) {
              throw new Error(
                `${ASSETS_DIR}/${name}.py defines no build().\n\n${report}`,
              )
            }
          } else if (report === '') {
            throw new Error('The critic finished without a report.')
          }
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  role === 'asset_builder'
                    ? `${ASSETS_DIR}/${name}.py is ready.\n\n${report}`
                    : report,
              },
            ],
            details: { role, name, toolCalls },
          }
        } finally {
          signal?.removeEventListener('abort', abort)
          session.dispose()
        }
      } finally {
        release()
      }
    },
  })
}
