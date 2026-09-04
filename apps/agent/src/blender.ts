import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const MACOS_BLENDER = '/Applications/Blender.app/Contents/MacOS/Blender'
const DEFAULT_SCRIPT = 'scene.py'
const DEFAULT_TIMEOUT_MS = 120_000

export interface RunBlenderOptions {
  script?: string
  timeoutMs?: number
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
    const child = spawn(binary, args, { cwd: workdir })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const finish = (result: BlenderResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
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
      finish({ ok: code === 0, stdout, stderr, durationMs })
    })
  })
}
