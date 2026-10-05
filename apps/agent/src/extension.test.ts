import type { Context } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { imageCount, userText } from './test/context'
import {
  BROKEN_SCENE,
  type Fixture,
  fixture,
  GOOD_SCENE,
  hasBlender,
} from './test/fixture'
import { inOrder, type Turn } from './test/scripted'

let f: Fixture | undefined

afterEach(async () => {
  await f?.dispose()
  f = undefined
})

const write = (path: string, content: string): Turn => ({
  calls: [{ name: 'write', args: { path, content } }],
})
const call = (name: string, args: Record<string, unknown> = {}): Turn => ({
  calls: [{ name, args }],
})

function toolResults(f: Fixture, toolName: string) {
  return f.runtime.session.sessionManager
    .getEntries()
    .flatMap((entry) =>
      entry.type === 'message' &&
      entry.message.role === 'toolResult' &&
      entry.message.toolName === toolName
        ? [entry.message]
        : [],
    )
}

describe.skipIf(!hasBlender)('build guard', () => {
  it('feeds a broken build back and settles once it is green', async () => {
    const seen: string[] = []
    const built: string[] = []
    const script = inOrder([
      { text: 'hi' },
      write('scene.py', GOOD_SCENE),
      { text: 'fixed' },
    ])
    f = await fixture(
      (context) => {
        seen.push(userText(context, 'last'))
        return script(context)
      },
      { onSceneBuilt: (workdir) => built.push(workdir) },
    )
    await f.write('scene.py', BROKEN_SCENE)
    await f.runtime.session.prompt('say hi')

    expect(seen[1]).toContain('scene.py does not build')
    expect(seen[1]).toContain('boom')
    expect(f.builds.map((build) => build.ok)).toEqual([false, true])
    expect(built).toEqual([f.workdir])
    expect(f.events.filter((e) => e.type === 'agent_settled')).toHaveLength(1)
    expect(f.events.at(-1)?.type).toBe('agent_settled')

    const entries = f.runtime.session.sessionManager.getEntries()
    const injected = entries.filter((entry) => entry.type === 'custom_message')
    expect(injected.map((entry) => entry.customType)).toEqual(['build-error'])
    const fromUser = entries.filter(
      (entry) => entry.type === 'message' && entry.message.role === 'user',
    )
    expect(fromUser).toHaveLength(1)
  }, 60_000)

  it('stops feeding errors back after five rounds', async () => {
    f = await fixture(() => ({ text: 'looks fine to me' }))
    await f.write('scene.py', BROKEN_SCENE)
    await f.runtime.session.prompt('build something')

    expect(f.builds).toHaveLength(6)
    expect(f.builds.every((build) => !build.ok)).toBe(true)
    expect(f.events.filter((e) => e.type === 'agent_settled')).toHaveLength(1)
  }, 90_000)

  it('leaves a workspace with no scene alone', async () => {
    f = await fixture(inOrder([{ text: 'hi' }]))
    await f.runtime.session.prompt('say hi')
    expect(f.builds).toEqual([])
  })

  it('does not rebuild a scene the model built and then left alone', async () => {
    const built: string[] = []
    f = await fixture(
      inOrder([
        write('scene.py', GOOD_SCENE),
        call('run_blender'),
        { text: 'done' },
      ]),
      { onSceneBuilt: (workdir) => built.push(workdir) },
    )
    await f.runtime.session.prompt('make a cube')
    expect(f.builds).toEqual([])
    expect(toolResults(f, 'run_blender').map((r) => r.isError)).toEqual([false])
    expect(built).toEqual([f.workdir])
  }, 60_000)
})

describe('interactive commands', () => {
  it('does not expose render without an interactive host', async () => {
    f = await fixture(() => ({ text: 'done' }))
    expect(
      f.runtime.session.extensionRunner.getCommand('render'),
    ).toBeUndefined()
  })

  it('registers render only when a human preview callback is present', async () => {
    f = await fixture(() => ({ text: 'done' }), {
      onRender: async () => ({
        url: 'http://127.0.0.1:1234',
        opened: true,
        reused: false,
      }),
    })
    expect(
      f.runtime.session.extensionRunner.getCommand('render'),
    ).toMatchObject({
      name: 'render',
      description: 'Open the current scene in the playable web viewer',
    })
  })
})

describe.skipIf(!hasBlender)('build cap', () => {
  it('refuses the eleventh run_blender of a run and lets the model finish', async () => {
    f = await fixture(
      inOrder([
        write('scene.py', GOOD_SCENE),
        ...Array.from({ length: 11 }, () => call('run_blender')),
        { text: 'done' },
      ]),
    )
    await f.runtime.session.prompt('build it again and again')

    const results = toolResults(f, 'run_blender')
    expect(results.map((r) => r.isError)).toEqual([
      ...Array.from({ length: 10 }, () => false),
      true,
    ])
    expect(JSON.stringify(results.at(-1)?.content)).toContain(
      'all 10 of its run_blender builds',
    )
    expect(f.builds).toEqual([])
    expect(f.events.at(-1)?.type).toBe('agent_settled')
  }, 90_000)
})

describe('commit hook', () => {
  it('fires once per run, with that run’s changes', async () => {
    f = await fixture(
      inOrder([
        write('notes.txt', 'one'),
        { text: 'wrote one' },
        write('more.txt', 'two'),
        { text: 'wrote two' },
      ]),
    )
    await f.runtime.session.prompt('write one')
    await f.runtime.session.prompt('write two')

    expect(f.commits.map((c) => c.status)).toEqual(['ok', 'ok'])
    const [first, second] = f.commits
    if (first?.status !== 'ok' || second?.status !== 'ok') return
    expect(first.changed.created.map((c) => c.path)).toEqual(['notes.txt'])
    expect(second.changed.created.map((c) => c.path)).toEqual(['more.txt'])
    expect(second.changed.modified).toEqual([])
    expect(Object.keys(second.manifest)).toEqual(['more.txt', 'notes.txt'])
    expect(second.conversation.length).toBeGreaterThan(
      first.conversation.length,
    )
  })

  it('commits no files from an aborted run but still hands over the conversation', async () => {
    f = await fixture(
      inOrder([write('scene.py', GOOD_SCENE), { abort: 'cancelled' }]),
    )
    await f.runtime.session.prompt('make a cube')

    expect(f.builds).toEqual([])
    const [commit] = f.commits
    expect(commit?.status).toBe('aborted')
    expect(commit).not.toHaveProperty('manifest')
    expect(commit).not.toHaveProperty('changed')
    expect(commit?.conversation[0]).toMatchObject({ type: 'session' })
    expect(commit?.entryId).toBe(f.runtime.session.sessionManager.getLeafId())
    expect(commit?.sessionId).toBe(f.runtime.session.sessionId)
  })
})

describe.skipIf(!hasBlender)('commit hook after the guard', () => {
  it('commits the scene the guard had repaired', async () => {
    f = await fixture(
      inOrder([{ text: 'hi' }, write('scene.py', GOOD_SCENE), { text: 'ok' }]),
    )
    await f.write('scene.py', BROKEN_SCENE)
    await f.runtime.session.prompt('say hi')

    const [commit] = f.commits
    expect(commit?.status).toBe('ok')
    if (commit?.status !== 'ok') return
    expect(commit.changed.modified.map((c) => c.path)).toEqual(['scene.py'])
    expect(commit.changed.created.map((c) => c.path)).toEqual(['scene.glb'])
    expect(Object.keys(commit.manifest)).toEqual(['scene.glb', 'scene.py'])
    expect(JSON.stringify(commit.conversation)).toContain('build-error')
  }, 60_000)

  it('commits nothing from a run that gave up on its build', async () => {
    f = await fixture(() => ({ text: 'looks fine to me' }))
    await f.write('scene.py', BROKEN_SCENE)
    await f.runtime.session.prompt('build something')

    const [commit] = f.commits
    expect(commit?.status).toBe('error')
    if (commit?.status !== 'error') return
    expect(commit.error).toContain('boom')
    expect(commit).not.toHaveProperty('manifest')
  }, 90_000)
})

describe.skipIf(!hasBlender)('renders from an earlier run', () => {
  it('reach the model as stubs while this run’s stay images', async () => {
    const contexts: Context[] = []
    const script = inOrder([
      write('scene.py', GOOD_SCENE),
      call('run_blender'),
      call('inspect_scene', { azimuth: 0, elevation: 20, framing: 'scene' }),
      call('inspect_scene', { azimuth: 90, elevation: 10, framing: 'Cube' }),
      call('inspect_scene', { azimuth: 180, elevation: 30, framing: 'scene' }),
      { text: 'done' },
      { text: 'hi again' },
    ])
    f = await fixture((context) => {
      contexts.push(context)
      return script(context)
    })

    await f.runtime.session.prompt('look around')
    const endOfRunOne = contexts[5]
    expect(endOfRunOne && imageCount(endOfRunOne)).toBe(3)

    await f.runtime.session.prompt('say hi')
    const runTwo = contexts[6]
    expect(runTwo && imageCount(runTwo)).toBe(0)
    const sent = (runTwo?.messages ?? [])
      .flatMap((message) =>
        message.role === 'toolResult'
          ? message.content.flatMap((block) =>
              block.type === 'text' ? [block.text] : [],
            )
          : [],
      )
      .join('\n')
    expect(sent).toContain(
      '[render — the whole scene in scene.glb at azimuth 0°, elevation 20°. Re-run inspect_scene to look again.]',
    )
    expect(sent).toContain(
      '[render — "Cube" in scene.glb at azimuth 90°, elevation 10°. Re-run inspect_scene to look again.]',
    )
    expect(JSON.stringify(runTwo?.messages).length).toBeLessThan(
      JSON.stringify(endOfRunOne?.messages).length / 10,
    )
    const stored = toolResults(f, 'inspect_scene').filter((message) =>
      message.content.some((block) => block.type === 'image'),
    )
    expect(stored).toHaveLength(3)
  }, 90_000)
})
