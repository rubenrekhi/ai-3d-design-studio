import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isExcludedPath } from '@repo/shared'
import { diff, hashTree } from './manifest'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'manifest-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function write(rel: string, content: string) {
  const abs = join(dir, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

describe('hashTree', () => {
  it('records a content hash and byte size for each file', async () => {
    await write('scene.py', 'hello')
    const manifest = await hashTree(dir)
    expect(manifest).toEqual({
      'scene.py': {
        hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        size: 5,
      },
    })
  })

  it('keeps posix separators for nested files and sorts keys', async () => {
    await write('scene.py', 'a')
    await write('assets/chair.py', 'b')
    await write('assets/lamp.py', 'c')
    const manifest = await hashTree(dir)
    expect(Object.keys(manifest)).toEqual([
      'assets/chair.py',
      'assets/lamp.py',
      'scene.py',
    ])
  })

  it('is deterministic for an unchanged tree', async () => {
    await write('scene.py', 'x')
    await write('assets/chair.py', 'y')
    expect(await hashTree(dir)).toEqual(await hashTree(dir))
  })

  it('hashes empty files', async () => {
    await write('empty.py', '')
    const manifest = await hashTree(dir)
    expect(manifest['empty.py']).toEqual({
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      size: 0,
    })
  })

  it('never includes .pi/ in a manifest', async () => {
    await write('scene.py', 'x')
    await write('.pi/session.jsonl', '{"role":"user"}\n')
    await write('.pi/nested/more.json', '{}')
    const manifest = await hashTree(dir)
    expect(Object.keys(manifest)).toEqual(['scene.py'])
    expect(Object.keys(manifest).some((p) => p.startsWith('.pi'))).toBe(false)
  })

  it('excludes render output under .renders/', async () => {
    await write('scene.glb', 'GLB')
    await write('.renders/contact-sheet.png', 'PNG')
    const manifest = await hashTree(dir)
    expect(Object.keys(manifest)).toEqual(['scene.glb'])
  })

  it('excludes the bytecode Python writes beside an imported asset', async () => {
    await write('scene.py', 'x')
    await write('assets/chair.py', 'y')
    await write('assets/__pycache__/chair.cpython-311.pyc', 'BYTECODE')
    const manifest = await hashTree(dir)
    expect(Object.keys(manifest)).toEqual(['assets/chair.py', 'scene.py'])
  })
})

describe('diff', () => {
  it('classifies created, modified, and deleted files', async () => {
    await write('keep.py', 'same')
    await write('change.py', 'before')
    await write('remove.py', 'gone')
    const a = await hashTree(dir)

    await write('change.py', 'after')
    await write('add.py', 'new')
    await rm(join(dir, 'remove.py'))
    const b = await hashTree(dir)

    const changes = diff(a, b)
    expect(changes.created.map((c) => c.path)).toEqual(['add.py'])
    expect(changes.modified.map((c) => c.path)).toEqual(['change.py'])
    expect(changes.deleted).toEqual(['remove.py'])
  })

  it('carries the new hash and size on created and modified entries', async () => {
    const a = await hashTree(dir)
    await write('scene.py', 'hello')
    const b = await hashTree(dir)
    expect(diff(a, b).created).toEqual([
      {
        path: 'scene.py',
        hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
        size: 5,
      },
    ])
  })

  it('reports nothing for identical manifests', async () => {
    await write('scene.py', 'x')
    const a = await hashTree(dir)
    expect(diff(a, a)).toEqual({ created: [], modified: [], deleted: [] })
  })
})

describe('isExcludedPath', () => {
  it('excludes the .pi and .renders roots and everything beneath them', () => {
    expect(isExcludedPath('.pi')).toBe(true)
    expect(isExcludedPath('.pi/session.jsonl')).toBe(true)
    expect(isExcludedPath('.renders')).toBe(true)
    expect(isExcludedPath('.renders/contact-sheet.png')).toBe(true)
  })

  it('includes scene sources and treats a nested .renders as content', () => {
    expect(isExcludedPath('scene.py')).toBe(false)
    expect(isExcludedPath('assets/chair.py')).toBe(false)
    expect(isExcludedPath('assets/.renders/x.png')).toBe(false)
  })

  it('excludes __pycache__ at any depth, unlike the root-anchored entries', () => {
    expect(isExcludedPath('__pycache__/scene.cpython-311.pyc')).toBe(true)
    expect(isExcludedPath('assets/__pycache__/chair.cpython-311.pyc')).toBe(
      true,
    )
    expect(isExcludedPath('assets/parts/__pycache__/leg.pyc')).toBe(true)
    expect(isExcludedPath('assets/pycache/chair.py')).toBe(false)
  })
})
