import { join } from 'node:path'
import {
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { BuildReport, Commit } from '@repo/shared'
import { studioExtension } from './extension'
import { SCENE_BUILDER_PROMPT } from './prompt'
import { inspectSceneTool, previewAssetTool, runBlenderTool } from './tools'

/**
 * `bash` is deliberately absent. The harness has to be able to promise that a
 * finished run builds, and it cannot promise that through an invocation of
 * Blender it does not own. Pi's `ls`, `find`, and `grep` cover the exploring
 * that bash would otherwise be reached for.
 */
const STUDIO_TOOLS = [
  'read',
  'write',
  'edit',
  'ls',
  'find',
  'grep',
  runBlenderTool.name,
  inspectSceneTool.name,
  previewAssetTool.name,
  'spawn_asset_builder',
]

export interface StudioAgentOptions {
  /**
   * Absolute path to the workspace. The caller resolves it; the harness never
   * infers it from the process. Conversations live in `<workdir>/.pi`.
   */
  workdir: string
  /**
   * Conversation to continue, as a path the caller already resolved. Absent
   * starts a new one. Finding a file from an id is a listing and a prefix
   * match, which is the caller's job for the same reason `workdir` is.
   */
  sessionFile?: string
  /** The model to run. Absent, pi's own default applies. */
  model?: CreateAgentSessionFromServicesOptions['model']
  /**
   * Called once per run after it settles, with the workspace diff on success
   * and the conversation either way. Awaited; without it the agent stands
   * alone, which is the fastest loop there is.
   */
  onCommit?: (commit: Commit) => Promise<void>
  /** Called for each build the guard runs at the end of a run. */
  onBuild?: (build: BuildReport) => void
}

/**
 * The harness: pi with the scene-building prompt, the three Blender tools,
 * and one extension that guards the build, hashes the workspace, and hands the
 * result to `onCommit`.
 *
 * Returns pi's runtime rather than a bare session because the interactive TUI
 * needs it; product callers read `runtime.session`.
 */
export async function createStudioAgent(
  opts: StudioAgentOptions,
): Promise<AgentSessionRuntime> {
  const agentDir = getAgentDir()

  // Pi otherwise writes to `~/.pi/agent/sessions/<encoded-cwd>/`, which puts the
  // conversation outside the workspace and points `/resume` at every project on
  // the machine instead of this one.
  const sessionDir = join(opts.workdir, '.pi')
  const sessionManager =
    opts.sessionFile === undefined
      ? SessionManager.create(opts.workdir, sessionDir)
      : SessionManager.open(opts.sessionFile, sessionDir, opts.workdir)

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    let services: AgentSessionServices | undefined
    const extension = studioExtension({
      onCommit: opts.onCommit,
      onBuild: opts.onBuild,
      services: () => {
        if (services === undefined) throw new Error('services not built yet')
        return services
      },
    })
    services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        systemPrompt: SCENE_BUILDER_PROMPT,
        extensionFactories: [extension],
      },
    })
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: opts.model,
      tools: STUDIO_TOOLS,
      customTools: [runBlenderTool, inspectSceneTool, previewAssetTool],
    })
    return { ...created, services, diagnostics: services.diagnostics }
  }

  return createAgentSessionRuntime(createRuntime, {
    cwd: opts.workdir,
    agentDir,
    sessionManager,
  })
}
