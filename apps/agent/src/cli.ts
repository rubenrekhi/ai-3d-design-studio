import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { InteractiveMode } from '@earendil-works/pi-coding-agent'
import { createStudioAgent } from './agent'

const USAGE =
  'usage: studio-agent (--workdir <path> | --project <name> [--home <path>])'

/** Pi's own session-id rule. A project name becomes a directory name. */
const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

interface CliArgs {
  workdir?: string
  home?: string
  project?: string
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--workdir' || flag === '--home' || flag === '--project') {
      const value = argv[i + 1]
      if (value === undefined) fail(`${flag} requires a value`)
      if (flag === '--workdir') args.workdir = value
      else if (flag === '--home') args.home = value
      else args.project = value
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
 * `<home>/projects/<name>/workspace`, where the home defaults to the machine's
 * home directory — never the process cwd, which is `apps/agent` under `pnpm agent`.
 */
function resolveWorkspace(args: CliArgs): string {
  if (args.workdir !== undefined) {
    return resolve(expandTilde(args.workdir))
  }
  if (args.project === undefined) {
    fail(USAGE)
  }
  // The name is joined into a path, so an unchecked one escapes the home.
  if (!PROJECT_NAME.test(args.project)) {
    fail(
      `invalid project name: ${args.project}\n` +
        "a name may hold letters, digits, '.', '_', and '-', and must start and end with a letter or digit",
    )
  }
  const home =
    args.home ??
    process.env.STUDIO_AGENT_HOME ??
    join(homedir(), '.studio-agent')
  return join(resolve(expandTilde(home)), 'projects', args.project, 'workspace')
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
