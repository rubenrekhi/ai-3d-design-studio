import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stdin } from 'node:process'
import {
  InteractiveMode,
  type SessionInfo,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { createStudioAgent } from './agent'
import { select, text } from './ask'

const USAGE =
  'usage: studio-agent [--workdir <path> | --project <name> [--home <path>]] [--session <id>]'

const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const NAME_RULE =
  "a name may hold letters, digits, '.', '_', and '-', and must start and end with a letter or digit"

interface CliArgs {
  workdir?: string
  home?: string
  project?: string
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
    if (
      flag === '--workdir' ||
      flag === '--home' ||
      flag === '--project' ||
      flag === '--session'
    ) {
      const value = argv[i + 1]
      if (value === undefined) fail(`${flag} requires a value`)
      if (flag === '--workdir') args.workdir = value
      else if (flag === '--home') args.home = value
      else if (flag === '--project') args.project = value
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
 * The home defaults to the machine's home directory — never the process cwd,
 * which is `apps/agent` under `pnpm agent`.
 */
function resolveHome(home: string | undefined): string {
  return resolve(
    expandTilde(
      home ?? process.env.STUDIO_AGENT_HOME ?? join(homedir(), '.studio-agent'),
    ),
  )
}

function workspaceIn(home: string, name: string): string {
  return join(home, 'projects', name, 'workspace')
}

function listProjects(home: string): string[] {
  try {
    return readdirSync(join(home, 'projects'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function listSessions(workdir: string): Promise<SessionInfo[]> {
  return SessionManager.list(workdir, join(workdir, '.pi'))
}

function describe(session: SessionInfo): string {
  const summary =
    session.name ?? session.firstMessage.replace(/\s+/g, ' ').trim()
  const label = summary.length > 60 ? `${summary.slice(0, 59)}…` : summary
  return label === '' ? '(empty)' : label
}

/**
 * Pi's ids are UUIDv7, so sessions made in the same project share a long
 * timestamp prefix. Show the shortest prefix that is unambiguous here, which
 * keeps what is on screen usable as `--session`.
 */
function shortId(id: string, all: string[]): string {
  for (let length = 4; length < id.length; length++) {
    const prefix = id.slice(0, length)
    if (all.filter((other) => other.startsWith(prefix)).length === 1) {
      return prefix
    }
  }
  return id
}

function checkName(name: string): string | undefined {
  if (name === '') return 'a name is required'
  return PROJECT_NAME.test(name) ? undefined : NAME_RULE
}

async function chooseWorkspace(home: string): Promise<string> {
  const projects = listProjects(home)
  const action = await select('What would you like to do?', [
    ...(projects.length === 0
      ? []
      : [{ label: 'Open an existing project', value: 'open' as const }]),
    { label: 'Create a new project', value: 'create' as const },
  ])

  if (action === 'open') {
    const name = await select(
      'Project',
      projects.map((project) => ({ label: project, value: project })),
    )
    return workspaceIn(home, name)
  }

  const name = await text('Project name', checkName)
  const root = await select('Location', [
    { label: 'Default', hint: join(home, 'projects'), value: home },
    { label: 'Custom parent directory', value: undefined },
  ])
  if (root !== undefined) return workspaceIn(root, name)

  const parent = await text('Parent directory', (value) =>
    value === '' ? 'a directory is required' : undefined,
  )
  return workspaceIn(resolve(expandTilde(parent)), name)
}

async function chooseSession(workdir: string): Promise<string | undefined> {
  const sessions = (await listSessions(workdir)).sort(
    (a, b) => b.modified.getTime() - a.modified.getTime(),
  )
  if (sessions.length === 0) return undefined
  const ids = sessions.map((session) => session.id)
  return select('Conversation', [
    { label: 'New conversation', value: undefined },
    ...sessions.map((session) => ({
      label: describe(session),
      hint: shortId(session.id, ids),
      value: session.path as string | undefined,
    })),
  ])
}

/**
 * A project name maps to a path with no search. Conversation ids are pi's, so
 * this one is a lookup over the project's own `.pi` and nothing wider.
 */
async function findSession(workdir: string, id: string): Promise<string> {
  if (id === '') fail('--session requires a conversation id')
  const sessions = await listSessions(workdir)
  const exact = sessions.find((session) => session.id === id)
  if (exact !== undefined) return exact.path

  const matches = sessions.filter((session) => session.id.startsWith(id))
  const [only] = matches
  if (only === undefined) {
    fail(`no conversation in this project matches: ${id}`)
  }
  if (matches.length > 1) {
    const ids = matches.map((session) => session.id)
    fail(
      [`${id} matches ${matches.length} conversations:`, ...ids].join('\n  '),
    )
  }
  return only.path
}

/**
 * Pi merges `<workdir>/.pi/settings.json` over its global settings, so this
 * quiets the startup banner for our workspaces without touching the settings
 * of any other pi on the machine. Written once, then it is the person's.
 */
function seedSettings(workdir: string): void {
  const path = join(workdir, '.pi', 'settings.json')
  if (existsSync(path)) return
  mkdirSync(join(workdir, '.pi'), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ quietStartup: true }, null, 2)}\n`)
}

async function main(): Promise<void> {
  // The banner tells you to run `pi update`, which cannot move a version this
  // package pins exactly.
  process.env.PI_SKIP_VERSION_CHECK = '1'

  const args = parseArgs(process.argv.slice(2))
  if (
    args.session !== undefined &&
    args.workdir === undefined &&
    args.project === undefined
  ) {
    fail(`--session needs --project or --workdir\n${USAGE}`)
  }

  let workdir: string
  let sessionFile: string | undefined

  if (args.workdir !== undefined) {
    workdir = resolve(expandTilde(args.workdir))
  } else if (args.project !== undefined) {
    const problem = checkName(args.project)
    if (problem !== undefined) {
      fail(`invalid project name: ${args.project}\n${problem}`)
    }
    workdir = workspaceIn(resolveHome(args.home), args.project)
  } else {
    if (stdin.isTTY !== true) fail(USAGE)
    workdir = await chooseWorkspace(resolveHome(args.home))
  }

  mkdirSync(workdir, { recursive: true })
  seedSettings(workdir)

  if (args.session !== undefined) {
    sessionFile = await findSession(workdir, args.session)
  } else if (args.workdir === undefined && args.project === undefined) {
    sessionFile = await chooseSession(workdir)
  }

  const runtime = await createStudioAgent({ workdir, sessionFile })

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
