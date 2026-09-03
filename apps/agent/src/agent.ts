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

export interface StudioAgentOptions {
  /**
   * Absolute path to the workspace. The caller resolves it; the harness never
   * infers it from the process. Conversations live in `<workdir>/.pi`.
   */
  workdir: string
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
  const sessionManager = SessionManager.create(
    opts.workdir,
    join(opts.workdir, '.pi'),
  )

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({ cwd, agentDir })
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })
    return { ...created, services, diagnostics: services.diagnostics }
  }

  return createAgentSessionRuntime(createRuntime, {
    cwd: opts.workdir,
    agentDir,
    sessionManager,
  })
}
