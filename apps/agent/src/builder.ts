import {
  type AgentSession,
  type AgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { ASSET_BUILDER_PROMPT } from './prompt'
import { previewAssetTool } from './tools/preview-asset'

/**
 * What a builder may touch: its module, and a preview of it. No `run_blender`,
 * because the scene is not its to build, and no `inspect_scene`, because
 * nothing of its is placed yet.
 */
const BUILDER_TOOLS = [
  'read',
  'write',
  'edit',
  'ls',
  'find',
  'grep',
  previewAssetTool.name,
]

export type OpenBuilder = (
  ctx: Pick<ExtensionContext, 'cwd' | 'model' | 'thinkingLevel'>,
) => Promise<AgentSession>

/**
 * Builders run in this process on sessions of their own. A separate message
 * list, system prompt, and tool set is all the isolation an asset needs, and
 * an in-memory session means a dozen contact sheets never reach the parent.
 * They share the parent's model runtime and settings, so what the parent can
 * call, they can call.
 */
export function builderOpener(parent: () => AgentSessionServices): OpenBuilder {
  let services: Promise<AgentSessionServices> | undefined
  return async (ctx) => {
    const own = parent()
    services ??= createAgentSessionServices({
      cwd: ctx.cwd,
      agentDir: own.agentDir,
      modelRuntime: own.modelRuntime,
      settingsManager: own.settingsManager,
      resourceLoaderOptions: {
        systemPrompt: ASSET_BUILDER_PROMPT,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    })
    const { session } = await createAgentSessionFromServices({
      services: await services,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      tools: BUILDER_TOOLS,
      customTools: [previewAssetTool],
    })
    return session
  }
}
