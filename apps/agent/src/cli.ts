import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { InteractiveMode } from '@earendil-works/pi-coding-agent'
import { createStudioAgent } from './agent'

const USAGE =
  'usage: studio-agent (--workdir <path> | --session <slug> [--home <path>])'

interface CliArgs {
  workdir?: string
  home?: string
  session?: string
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--workdir' || flag === '--home' || flag === '--session') {
      const value = argv[i + 1]
      if (value === undefined) fail(`${flag} requires a value`)
      if (flag === '--workdir') args.workdir = value
      else if (flag === '--home') args.home = value
      else args.session = value
      i++
    } else {
      fail(`unknown argument: ${flag}\n${USAGE}`)
    }
  }
  return args
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * `--workdir` bypasses the home entirely. Otherwise the workspace is
 * `<home>/sessions/<slug>/workspace`, where the home defaults to the machine's
 * home directory — never the process cwd, which is `apps/agent` under `pnpm agent`.
 */
function resolveWorkspace(args: CliArgs): string {
  if (args.workdir !== undefined) {
    return resolve(expandTilde(args.workdir))
  }
  if (args.session === undefined) {
    fail(USAGE)
  }
  const home =
    args.home ??
    process.env.STUDIO_AGENT_HOME ??
    join(homedir(), '.studio-agent')
  return join(resolve(expandTilde(home)), 'sessions', args.session, 'workspace')
}

async function main(): Promise<void> {
  const workdir = resolveWorkspace(parseArgs(process.argv.slice(2)))
  mkdirSync(workdir, { recursive: true })

  const runtime = await createStudioAgent({ workdir })

  const errors = runtime.diagnostics.filter((d) => d.type === 'error')
  if (errors.length > 0) {
    for (const d of errors) console.error(`Error: ${d.message}`)
    process.exit(1)
  }

  const mode = new InteractiveMode(runtime, {
    modelFallbackMessage: runtime.modelFallbackMessage,
  })
  await mode.run()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
