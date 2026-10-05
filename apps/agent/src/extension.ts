import type {
  AgentSessionServices,
  ExtensionAPI,
  InlineExtension,
} from '@earendil-works/pi-coding-agent'
import type { BuildReport, Commit, Manifest } from '@repo/shared'
import { buildScene, hasScene } from './build'
import { stubConversation, stubImages } from './images'
import { diff, hashTree } from './manifest'
import { lastAssistant, messagesOf, toolResultIds } from './messages'
import { assetBuilderTool } from './subagent'
import { runBlenderTool } from './tools'

/**
 * How many build errors one run gets fed back before the harness stops
 * feeding them. A run that uses them all settles as an error, so nothing is
 * committed from it; without a limit a model that cannot fix its scene would
 * loop until the context ran out.
 */
const MAX_GUARD_ROUNDS = 5

/**
 * How many `run_blender` calls one run gets. Past it the call is refused and
 * the model is told to finish; the guard still builds whatever it leaves.
 */
const MAX_BUILDS_PER_RUN = 10

export interface StudioExtensionOptions {
  /** Awaited, and its errors surface through pi's extension error channel. */
  onCommit?: (commit: Commit) => Promise<void>
  /** Each build the guard runs. Builds the model asks for arrive as tool results. */
  onBuild?: (build: BuildReport) => void
  /** The services this extension's own session was built from, once they exist. */
  services: () => AgentSessionServices
}

export function studioExtension(opts: StudioExtensionOptions): InlineExtension {
  return { name: 'studio', factory: (pi) => install(pi, opts) }
}

function install(pi: ExtensionAPI, opts: StudioExtensionOptions): void {
  let inRun = false
  let before: Manifest = {}
  let earlierResults = new Set<string>()
  let lastGoodBuild: Manifest | undefined
  let builds = 0
  let guardRounds = 0
  let guardError: string | undefined

  pi.registerTool(assetBuilderTool(opts.services))

  // Pi starts a fresh loop for every continuation — the guard's follow-up, a
  // retry, a compaction — and a run is the whole of them, so only the first
  // start after a settle begins one.
  pi.on('agent_start', async (_event, ctx) => {
    if (inRun) return
    inRun = true
    builds = 0
    guardRounds = 0
    guardError = undefined
    earlierResults = toolResultIds(ctx.sessionManager.getEntries())
    before = await hashTree(ctx.cwd)
  })

  pi.on('context', (event) => ({
    messages: event.messages.map((message) =>
      message.role === 'toolResult' && earlierResults.has(message.toolCallId)
        ? stubImages(message)
        : message,
    ),
  }))

  pi.on('tool_call', (event) => {
    if (event.toolName !== runBlenderTool.name) return
    if (builds >= MAX_BUILDS_PER_RUN) {
      return {
        block: true,
        reason: `This run has used all ${MAX_BUILDS_PER_RUN} of its run_blender builds. Finish now: the scene is built once more when you stop, and any error comes back to you.`,
      }
    }
    builds += 1
  })

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === runBlenderTool.name && !event.isError) {
      lastGoodBuild = await hashTree(ctx.cwd)
    }
  })

  pi.on('agent_end', async (event, ctx) => {
    const last = lastAssistant(event.messages)
    if (last?.stopReason === 'error' || last?.stopReason === 'aborted') return
    if (!(await hasScene(ctx.cwd))) return
    const now = await hashTree(ctx.cwd)
    if (lastGoodBuild !== undefined && sameManifest(now, lastGoodBuild)) return

    const build = await buildScene(ctx.cwd, { signal: ctx.signal })
    opts.onBuild?.(
      build.ok
        ? { ok: true, durationMs: build.durationMs }
        : { ok: false, durationMs: build.durationMs, error: build.error },
    )
    if (build.ok) {
      lastGoodBuild = await hashTree(ctx.cwd)
      guardRounds = 0
      return
    }

    guardRounds += 1
    if (guardRounds > MAX_GUARD_ROUNDS) {
      guardError = build.error
      return
    }
    pi.sendMessage(
      {
        customType: 'build-error',
        content: `scene.py does not build. Fix it before you finish.\n\n${build.error}`,
        display: true,
        details: { round: guardRounds },
      },
      { deliverAs: 'followUp', triggerTurn: true },
    )
  })

  pi.on('agent_settled', async (_event, ctx) => {
    if (!inRun) return
    inRun = false
    if (opts.onCommit === undefined) return

    const entries = ctx.sessionManager.getEntries()
    const last = lastAssistant(messagesOf(entries))
    const base = {
      workdir: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      entryId: ctx.sessionManager.getLeafId(),
      conversation: stubConversation(ctx.sessionManager.getHeader(), entries),
    }

    let commit: Commit
    if (guardError !== undefined) {
      commit = { ...base, status: 'error', error: guardError }
    } else if (last?.stopReason === 'aborted' || last?.stopReason === 'error') {
      commit = { ...base, status: last.stopReason, error: last.errorMessage }
    } else {
      const after = await hashTree(ctx.cwd)
      commit = {
        ...base,
        status: 'ok',
        manifest: after,
        changed: diff(before, after),
      }
    }
    await opts.onCommit(commit)
  })
}

function sameManifest(a: Manifest, b: Manifest): boolean {
  const paths = Object.keys(a)
  return (
    paths.length === Object.keys(b).length &&
    paths.every((path) => a[path]?.hash === b[path]?.hash)
  )
}
