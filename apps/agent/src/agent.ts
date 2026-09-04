import { join } from 'node:path'
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { SCENE_BUILDER_PROMPT } from './prompt'
import { runBlenderTool } from './tools'

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
}

/**
 * The harness: pi, wired to keep its conversations inside the workspace.
 *
 * Returns pi's runtime rather than a bare session because the interactive TUI
 * needs it; product callers read `runtime.session`. Later phases add the system
 * prompt, the 3D tools, and the studio extension here.
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
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: { systemPrompt: SCENE_BUILDER_PROMPT },
    })
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: STUDIO_TOOLS,
      customTools: [runBlenderTool],
    })
    return { ...created, services, diagnostics: services.diagnostics }
  }

  return createAgentSessionRuntime(createRuntime, {
    cwd: opts.workdir,
    agentDir,
    sessionManager,
  })
}
