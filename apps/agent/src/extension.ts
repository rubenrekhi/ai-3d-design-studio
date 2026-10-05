import type {
  ExtensionAPI,
  InlineExtension,
} from '@earendil-works/pi-coding-agent'
import type { BuildReport, Manifest } from '@repo/shared'
import { buildScene, hasScene } from './build'
import { hashTree } from './manifest'
import { lastAssistant } from './messages'
import { runBlenderTool } from './tools'

/**
 * How many build errors one run gets fed back before the harness stops
 * feeding them. Without a limit a model that cannot fix its scene would loop
 * until the context ran out.
 */
const MAX_GUARD_ROUNDS = 5

export interface StudioExtensionOptions {
  /** Each build the guard runs. Builds the model asks for arrive as tool results. */
  onBuild?: (build: BuildReport) => void
}

export function studioExtension(opts: StudioExtensionOptions): InlineExtension {
  return { name: 'studio', factory: (pi) => install(pi, opts) }
}

function install(pi: ExtensionAPI, opts: StudioExtensionOptions): void {
  let inRun = false
  let lastGoodBuild: Manifest | undefined
  let guardRounds = 0

  // Pi starts a fresh loop for every continuation — the guard's follow-up, a
  // retry, a compaction — and a run is the whole of them, so only the first
  // start after a settle begins one.
  pi.on('agent_start', () => {
    if (inRun) return
    inRun = true
    guardRounds = 0
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
    if (guardRounds > MAX_GUARD_ROUNDS) return
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

  pi.on('agent_settled', () => {
    inRun = false
  })
}

function sameManifest(a: Manifest, b: Manifest): boolean {
  const paths = Object.keys(a)
  return (
    paths.length === Object.keys(b).length &&
    paths.every((path) => a[path]?.hash === b[path]?.hash)
  )
}
