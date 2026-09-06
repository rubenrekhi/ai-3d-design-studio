import { afterEach, describe, expect, it } from 'vitest'
import { userText } from './test/context'
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
    const script = inOrder([
      { text: 'hi' },
      write('scene.py', GOOD_SCENE),
      { text: 'fixed' },
    ])
    f = await fixture((context) => {
      seen.push(userText(context, 'last'))
      return script(context)
    })
    await f.write('scene.py', BROKEN_SCENE)
    await f.runtime.session.prompt('say hi')

    expect(seen[1]).toContain('scene.py does not build')
    expect(seen[1]).toContain('boom')
    expect(f.builds.map((build) => build.ok)).toEqual([false, true])
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
    f = await fixture(
      inOrder([
        write('scene.py', GOOD_SCENE),
        call('run_blender'),
        { text: 'done' },
      ]),
    )
    await f.runtime.session.prompt('make a cube')
    expect(f.builds).toEqual([])
    expect(toolResults(f, 'run_blender').map((r) => r.isError)).toEqual([false])
  }, 60_000)
})
