import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const MACOS_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender'
const DEFAULT_SCRIPT = 'scene.py'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_REPORT_LINES = 40

export interface RunBlenderOptions {
  script?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface BlenderResult {
  ok: boolean
  stdout: string
  stderr: string
  durationMs: number
}

function blenderBinary(): string {
  const fromEnv = process.env.BLENDER_PATH
  return fromEnv && fromEnv.length > 0 ? fromEnv : MACOS_BLENDER
}

function withNote(stderr: string, note: string): string {
  const sep = stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : ''
  return `${stderr}${sep}${note}\n`
}

/**
 * Blender is loud. A failure is a Python traceback at the end of it, and a
 * successful build's own prints are at the end too.
 */
export function lastLines(text: string, count = MAX_REPORT_LINES): string {
  const lines = text.trim().split('\n')
  return lines.slice(-count).join('\n')
}

export function runBlender(
  workdir: string,
  opts: RunBlenderOptions = {},
): Promise<BlenderResult> {
  const script = resolve(workdir, opts.script ?? DEFAULT_SCRIPT)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const binary = blenderBinary()

  // Blender returns 0 even when a --python script raises, SyntaxError included. --python-exit-code
  // turns a Python failure into a nonzero exit, which is the only thing that makes `ok` trustworthy.
  const args = ['--background', '--python-exit-code', '1', '--python', script]

  return new Promise((settle) => {
    const start = performance.now()

    // An AbortSignal never replays: a listener added after the fact is silent.
    if (opts.signal?.aborted === true) {
      settle({
        ok: false,
        stdout: '',
        stderr: 'Blender was not started: the run was cancelled.\n',
        durationMs: 0,
      })
      return
    }

    const child = spawn(binary, args, { cwd: workdir })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const abort = () => {
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', abort, { once: true })

    const finish = (result: BlenderResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      settle(result)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      finish({
        ok: false,
        stdout,
        stderr: withNote(
          stderr,
          `Could not launch Blender at "${binary}": ${err.message}`,
        ),
        durationMs: Math.round(performance.now() - start),
      })
    })

    child.on('close', (code) => {
      const durationMs = Math.round(performance.now() - start)
      if (timedOut) {
        finish({
          ok: false,
          stdout,
          stderr: withNote(
            stderr,
            `Blender killed after exceeding the ${timeoutMs}ms timeout.`,
          ),
          durationMs,
        })
        return
      }
      if (opts.signal?.aborted === true) {
        finish({
          ok: false,
          stdout,
          stderr: withNote(stderr, 'Blender killed: the run was cancelled.'),
          durationMs,
        })
        return
      }
      finish({ ok: code === 0, stdout, stderr, durationMs })
    })
  })
}
