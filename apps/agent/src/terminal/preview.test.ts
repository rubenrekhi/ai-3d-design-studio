import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalPreview, type LocalPreview } from './preview'

const roots: string[] = []
const previews: LocalPreview[] = []

afterEach(async () => {
  await Promise.all(previews.splice(0).map((preview) => preview.close()))
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function files() {
  const root = await mkdtemp(join(tmpdir(), 'studio-preview-'))
  const workdir = join(root, 'workspace')
  const assetsDir = join(root, 'viewer')
  roots.push(root)
  await mkdir(join(assetsDir, 'assets'), { recursive: true })
  await mkdir(workdir, { recursive: true })
  await writeFile(join(assetsDir, 'index.html'), '<main>viewer</main>')
  await writeFile(join(assetsDir, 'assets', 'app.js'), 'window.viewer = true')
  return { root, workdir, assetsDir }
}

describe('local preview', () => {
  it('requires a built scene before starting a server', async () => {
    const { workdir, assetsDir } = await files()
    const preview = createLocalPreview({
      assetsDir,
      port: 0,
      openBrowser: async () => true,
    })
    previews.push(preview)
    await expect(preview.show(workdir)).rejects.toThrow(
      'Build the scene before using /render',
    )
  })

  it('serves only the viewer and scene, reuses its host, and reloads', async () => {
    const { root, workdir, assetsDir } = await files()
    const scene = Buffer.from('glTF-test-scene')
    await writeFile(join(workdir, 'scene.glb'), scene)
    await writeFile(join(workdir, 'secret.txt'), 'not public')
    await writeFile(join(root, 'outside.txt'), 'also not public')
    const openBrowser = vi.fn(async () => false)
    const preview = createLocalPreview({ assetsDir, port: 0, openBrowser })
    previews.push(preview)

    const first = await preview.show(workdir)
    expect(first).toMatchObject({ opened: false, reused: false })
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?live=1/)
    expect(await fetch(first.url).then((response) => response.text())).toBe(
      '<main>viewer</main>',
    )
    const artifact = await fetch(new URL('/scene.glb', first.url))
    expect(artifact.headers.get('cache-control')).toBe('no-store')
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(scene)
    expect((await fetch(new URL('/secret.txt', first.url))).status).toBe(404)
    expect(
      (await fetch(new URL('/%2e%2e%2foutside.txt', first.url))).status,
    ).toBe(404)

    const events = await fetch(new URL('/events', first.url))
    const reader = events.body?.getReader()
    if (reader === undefined) throw new Error('missing event stream')
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toContain(
      'event: ready',
    )
    preview.sceneBuilt(workdir)
    const reload = decoder.decode((await reader.read()).value)
    expect(reload).toContain('event: reload')
    expect(reload).toContain('data: 1')
    await reader.cancel()

    const second = await preview.show(workdir)
    expect(second.reused).toBe(true)
    expect(new URL(second.url).origin).toBe(new URL(first.url).origin)
    expect(openBrowser).toHaveBeenCalledTimes(2)
  })

  it('falls back to a free port when the preferred one is occupied', async () => {
    const { workdir, assetsDir } = await files()
    await writeFile(join(workdir, 'scene.glb'), 'glTF')
    const blocker = createServer()
    await new Promise<void>((done) => blocker.listen(0, '127.0.0.1', done))
    const address = blocker.address()
    if (address === null || typeof address === 'string') {
      throw new Error('missing blocker port')
    }
    const preview = createLocalPreview({
      assetsDir,
      port: address.port,
      openBrowser: async () => true,
    })
    previews.push(preview)
    try {
      const launch = await preview.show(workdir)
      expect(Number(new URL(launch.url).port)).not.toBe(address.port)
    } finally {
      await new Promise<void>((done, reject) =>
        blocker.close((error) => (error ? reject(error) : done())),
      )
    }
  })
})
