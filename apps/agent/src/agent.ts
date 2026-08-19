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
   * infers it from the process. The conversation lives at `<workdir>/.pi/session.jsonl`.
   */
  workdir: string
}

/**
 * The harness: pi, wired to keep its conversation inside the workspace.
 *
 * Returns pi's runtime rather than a bare session because the interactive TUI
 * needs it; product callers read `runtime.session`. Later phases add the system
 * prompt, the 3D tools, and the studio extension here.
 */
export async function createStudioAgent(
  opts: StudioAgentOptions,
): Promise<AgentSessionRuntime> {
  const agentDir = getAgentDir()
  const sessionManager = SessionManager.open(
    join(opts.workdir, '.pi', 'session.jsonl'),
    undefined,
    opts.workdir,
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
