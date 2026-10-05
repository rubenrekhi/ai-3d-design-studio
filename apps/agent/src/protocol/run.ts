import type { HarnessEvent, RunStatus } from '@repo/shared'
import { createStudioAgent } from '../agent'
import { toHarnessEvents } from './events'

export interface ProtocolRun {
  workdir: string
  sessionFile?: string
  prompt: string
  emit: (event: HarnessEvent) => void
}

/**
 * One run, start to settle, as a line-per-event stream. Exit codes: 0 when the
 * run committed, 2 when it settled on an error or an abort, 1 when it never
 * ran at all.
 */
export async function runProtocol(run: ProtocolRun): Promise<number> {
  let status: RunStatus | undefined
  let error: string | undefined
  const runtime = await createStudioAgent({
    workdir: run.workdir,
    sessionFile: run.sessionFile,
    onBuild: (build) => run.emit({ type: 'build', ...build }),
    onCommit: async (commit) => {
      status = commit.status
      error = commit.status === 'ok' ? undefined : commit.error
      run.emit({ type: 'commit', commit })
    },
  })

  try {
    for (const diagnostic of runtime.diagnostics) {
      if (diagnostic.type === 'error') {
        run.emit({ type: 'error', message: diagnostic.message })
      } else {
        console.error(`${diagnostic.type}: ${diagnostic.message}`)
      }
    }
    if (runtime.diagnostics.some((d) => d.type === 'error')) return 1

    const session = runtime.session
    await session.bindExtensions({
      mode: 'json',
      onError: (err) => {
        console.error(`Extension error (${err.extensionPath}): ${err.error}`)
      },
    })
    run.emit({
      type: 'session',
      id: session.sessionId,
      ...(session.sessionFile === undefined
        ? {}
        : { file: session.sessionFile }),
    })
    session.subscribe((event) => {
      for (const mapped of toHarnessEvents(event)) run.emit(mapped)
    })

    run.emit({ type: 'run_start' })
    try {
      await session.prompt(run.prompt)
    } catch (cause) {
      run.emit({ type: 'error', message: messageOf(cause) })
      return 1
    }
    if (status === undefined) {
      run.emit({
        type: 'error',
        message: 'The run ended without settling, so nothing was committed.',
      })
      return 1
    }
    run.emit({
      type: 'run_end',
      status,
      ...(error === undefined ? {} : { error }),
    })
    return status === 'ok' ? 0 : 2
  } finally {
    await runtime.dispose()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
