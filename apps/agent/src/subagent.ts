import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type AgentSessionServices,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { builderOpener } from './builder'
import { Gate } from './gate'
import { lastAssistant, textOf } from './messages'
import { ASSET_NAME, ASSETS_DIR } from './render'

/** Blender is a process per preview, so this is bounded by cores, not by pi. */
const MAX_CONCURRENT_BUILDERS = 4

export function assetBuilderTool(services: () => AgentSessionServices) {
  const open = builderOpener(services)
  const gate = new Gate(MAX_CONCURRENT_BUILDERS)

  return defineTool({
    name: 'spawn_asset_builder',
    label: 'Delegate',
    description: `Hand one asset to a builder that works on its own and reports back in one line. It writes ${ASSETS_DIR}/<name>.py with a build() for the scene to import, previews it from four sides until it reads well, and never touches scene.py. Its renders stay out of your context. Spawn several in one message to build them at once.`,
    promptSnippet:
      'hand one asset to a builder that works alone and reports back in one line',
    executionMode: 'parallel',
    parameters: Type.Object({
      name: Type.String({
        description: `The module to write, as ${ASSETS_DIR}/<name>.py: a Python identifier.`,
      }),
      brief: Type.String({
        description:
          'Everything the builder needs and cannot see: what the thing is, its size in metres, proportions, materials and colours, how much detail, and where its origin should sit.',
      }),
    }),
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      if (!ASSET_NAME.test(params.name)) {
        throw new Error(
          `"${params.name}" is not an asset name. A name is a Python identifier: letters, digits, and underscores, not starting with a digit.`,
        )
      }
      const release = await gate.acquire(signal)
      try {
        const session = await open(ctx)
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
                  text: `${params.name}: ${event.toolName} (${toolCalls} tool calls so far)`,
                },
              ],
              details: { name: params.name, toolCalls },
            })
          })
          await session.prompt(
            `Build ${ASSETS_DIR}/${params.name}.py.\n\n${params.brief}`,
          )

          const last = lastAssistant(session.messages)
          const report = last === undefined ? '' : textOf(last)
          if (last?.stopReason === 'aborted' || last?.stopReason === 'error') {
            throw new Error(
              `The builder for "${params.name}" ${last.stopReason === 'aborted' ? 'was cancelled' : 'failed'}: ${last.errorMessage ?? report}`,
            )
          }
          const module = await readFile(
            join(ctx.cwd, ASSETS_DIR, `${params.name}.py`),
            'utf8',
          ).catch(() => undefined)
          if (module === undefined) {
            throw new Error(
              `The builder finished without writing ${ASSETS_DIR}/${params.name}.py.\n\n${report}`,
            )
          }
          if (!/^def build\(/m.test(module)) {
            throw new Error(
              `${ASSETS_DIR}/${params.name}.py defines no build().\n\n${report}`,
            )
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `${ASSETS_DIR}/${params.name}.py is ready.\n\n${report}`,
              },
            ],
            details: { name: params.name, toolCalls },
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
