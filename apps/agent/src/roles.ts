import {
  type AgentSession,
  type AgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { ASSET_BUILDER_PROMPT, CRITIC_PROMPT } from './prompt'
import { inspectPhysicsTool } from './tools/inspect-physics'
import { inspectSceneTool } from './tools/inspect-scene'
import { previewAssetTool } from './tools/preview-asset'

export type Role = 'asset_builder' | 'critic'

/**
 * What each role is told and may touch. Neither gets `run_blender`, because
 * the scene is the parent's to build, and neither writes what the other
 * reads: a builder shapes one module and previews it alone, a critic looks
 * at the built scene and changes nothing.
 */
export const ROLES: Record<Role, { prompt: string; tools: string[] }> = {
  asset_builder: {
    prompt: ASSET_BUILDER_PROMPT,
    tools: [
      'read',
      'write',
      'edit',
      'ls',
      'find',
      'grep',
      previewAssetTool.name,
    ],
  },
  critic: {
    prompt: CRITIC_PROMPT,
    tools: [
      'read',
      'ls',
      'find',
      'grep',
      inspectSceneTool.name,
      inspectPhysicsTool.name,
    ],
  },
}

export type OpenSubagent = (
  ctx: Pick<ExtensionContext, 'cwd' | 'model' | 'thinkingLevel'>,
  role: Role,
) => Promise<AgentSession>

/**
 * Subagents run in this process on sessions of their own. A separate message
 * list, system prompt, and tool set is all the isolation a task needs, and
 * an in-memory session means a dozen renders never reach the parent. They
 * share the parent's model runtime and settings, so what the parent can
 * call, they can call.
 */
export function subagentOpener(
  parent: () => AgentSessionServices,
): OpenSubagent {
  const services = new Map<Role, Promise<AgentSessionServices>>()
  return async (ctx, role) => {
    const own = parent()
    let ready = services.get(role)
    if (ready === undefined) {
      ready = createAgentSessionServices({
        cwd: ctx.cwd,
        agentDir: own.agentDir,
        modelRuntime: own.modelRuntime,
        settingsManager: own.settingsManager,
        resourceLoaderOptions: {
          systemPrompt: ROLES[role].prompt,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      })
      services.set(role, ready)
    }
    const { session } = await createAgentSessionFromServices({
      services: await ready,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      tools: ROLES[role].tools,
      customTools: [previewAssetTool, inspectSceneTool, inspectPhysicsTool],
    })
    return session
  }
}
