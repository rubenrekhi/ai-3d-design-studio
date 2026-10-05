import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { imageCount, userText } from '../test/context'
import {
  assetModule,
  type Fixture,
  fixture,
  GOOD_SCENE,
  hasBlender,
} from '../test/fixture'
import type { Turn } from '../test/scripted'

let f: Fixture | undefined

afterEach(async () => {
  await f?.dispose()
  f = undefined
})

const spawn = (args: Record<string, unknown>) => ({
  name: 'spawn_subagent',
  args,
})

function toolResults(f: Fixture) {
  return f.runtime.session.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === 'message' && entry.message.role === 'toolResult'
        ? [entry.message]
        : [],
    )
}

const isBuilder = (context: Context) =>
  context.systemPrompt?.startsWith('You build one asset') === true
const isCritic = (context: Context) =>
  context.systemPrompt?.startsWith('You judge') === true

describe.skipIf(!hasBlender)('asset builders', () => {
  it('build two assets at once and keep their renders out of the parent', async () => {
    const childTurns = new Map<string, number>()
    const childContexts = new Map<string, Context[]>()
    let active = 0
    let mostActive = 0
    let parentTurn = 0

    f = await fixture((context): Turn => {
      if (isBuilder(context)) {
        const name =
          /Build assets\/(\w+)\.py/.exec(userText(context, 'first'))?.[1] ??
          'unknown'
        const turn = childTurns.get(name) ?? 0
        childTurns.set(name, turn + 1)
        childContexts.set(name, [...(childContexts.get(name) ?? []), context])
        if (turn === 0) {
          active += 1
          mostActive = Math.max(mostActive, active)
          return {
            calls: [
              {
                name: 'write',
                args: { path: `assets/${name}.py`, content: assetModule(name) },
              },
            ],
          }
        }
        if (turn === 1) {
          return { calls: [{ name: 'preview_asset', args: { name } }] }
        }
        active -= 1
        return {
          text: `assets/${name}.py: build(location=(0, 0, 0)) returns the root. 1 × 1 × 1 m.`,
        }
      }

      parentTurn += 1
      if (parentTurn === 1) {
        return {
          calls: [
            spawn({
              role: 'asset_builder',
              name: 'crate',
              task: 'A wooden crate, a 1 m cube.',
            }),
            spawn({
              role: 'asset_builder',
              name: 'barrel',
              task: 'An oak barrel, 1 m tall.',
            }),
          ],
        }
      }
      return { text: 'Both assets are ready to place.' }
    })

    await f.runtime.session.prompt('build a crate and a barrel')

    expect(await f.read('assets/crate.py')).toContain('def build(')
    expect(await f.read('assets/barrel.py')).toContain('def build(')
    expect(mostActive).toBe(2)
    for (const name of ['crate', 'barrel']) {
      const last = childContexts.get(name)?.at(-1)
      expect(last && imageCount(last)).toBe(4)
    }

    const entries = f.runtime.session.sessionManager.getEntries()
    expect(JSON.stringify(entries)).not.toContain('"type":"image"')
    const results = toolResults(f)
    expect(results.map((r) => r.toolName)).toEqual([
      'spawn_subagent',
      'spawn_subagent',
    ])
    expect(results.every((r) => !r.isError)).toBe(true)
    const reported = JSON.stringify(results)
    expect(reported).toContain('assets/crate.py is ready')
    expect(reported).toContain('assets/barrel.py is ready')
    expect(reported).toContain('build(location=(0, 0, 0)) returns the root')

    const renders = join(f.workdir, '.renders')
    expect(existsSync(renders) ? readdirSync(renders) : []).toEqual([])

    const [commit] = f.commits
    expect(commit?.status).toBe('ok')
    if (commit?.status !== 'ok') return
    expect(commit.changed.created.map((c) => c.path)).toEqual([
      'assets/barrel.py',
      'assets/crate.py',
    ])
  }, 120_000)

  it('report a builder that never wrote its module as an error', async () => {
    f = await fixture((context): Turn => {
      if (isBuilder(context)) return { text: 'I could not think of anything.' }
      const done = context.messages.some((m) => m.role === 'toolResult')
      return done
        ? { text: 'The builder failed.' }
        : {
            calls: [
              spawn({ role: 'asset_builder', name: 'lamp', task: 'A lamp.' }),
            ],
          }
    })
    await f.runtime.session.prompt('build a lamp')

    const results = toolResults(f)
    expect(results).toHaveLength(1)
    expect(results[0]?.isError).toBe(true)
    expect(JSON.stringify(results[0]?.content)).toContain(
      'without writing assets/lamp.py',
    )
    expect(f.commits[0]?.status).toBe('ok')
  })
})

describe.skipIf(!hasBlender)('critics', () => {
  it('look at the built scene and hand back only their report', async () => {
    const criticContexts: Context[] = []
    let parentTurn = 0
    f = await fixture((context): Turn => {
      if (isCritic(context)) {
        criticContexts.push(context)
        if (criticContexts.length === 1) {
          return {
            calls: [
              {
                name: 'inspect_scene',
                args: { azimuth: 45, elevation: 25, framing: 'scene' },
              },
              {
                name: 'inspect_scene',
                args: { azimuth: 0, elevation: 85, framing: 'Cube' },
              },
            ],
          }
        }
        return { text: '1. Cube: sits on the origin as asked. Nothing wrong.' }
      }
      parentTurn += 1
      if (parentTurn === 1) {
        return {
          calls: [
            { name: 'write', args: { path: 'scene.py', content: GOOD_SCENE } },
          ],
        }
      }
      if (parentTurn === 2)
        return { calls: [{ name: 'run_blender', args: {} }] }
      if (parentTurn === 3) {
        return {
          calls: [
            spawn({
              role: 'critic',
              task: 'The request was a 1 m cube. Judge it.',
            }),
          ],
        }
      }
      return { text: 'The critic found nothing wrong.' }
    })
    await f.runtime.session.prompt('make a cube and have it checked')

    expect(criticContexts).toHaveLength(2)
    expect(criticContexts[1] && imageCount(criticContexts[1])).toBe(2)
    expect(userText(criticContexts[0] as Context, 'first')).toContain(
      'The request was a 1 m cube.',
    )

    const entries = f.runtime.session.sessionManager.getEntries()
    expect(JSON.stringify(entries)).not.toContain('"type":"image"')
    const verdict = toolResults(f).find((r) => r.toolName === 'spawn_subagent')
    expect(verdict?.isError).toBe(false)
    expect(JSON.stringify(verdict?.content)).toContain(
      '1. Cube: sits on the origin as asked.',
    )
    expect(verdict?.details).toMatchObject({ role: 'critic', toolCalls: 2 })
  }, 120_000)
})

describe('spawn_subagent', () => {
  it('refuses an asset_builder with no module name', async () => {
    f = await fixture((context): Turn => {
      const done = context.messages.some((m) => m.role === 'toolResult')
      return done
        ? { text: 'I will name it next time.' }
        : { calls: [spawn({ role: 'asset_builder', task: 'A chair.' })] }
    })
    await f.runtime.session.prompt('build a chair')
    const [result] = toolResults(f)
    expect(result?.isError).toBe(true)
    expect(JSON.stringify(result?.content)).toContain('needs a name')
  })
})
