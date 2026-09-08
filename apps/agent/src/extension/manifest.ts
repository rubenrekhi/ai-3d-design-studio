import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  isExcludedPath,
  type ChangedFile,
  type ChangedFiles,
  type FileEntry,
  type Manifest,
} from '@repo/shared'

export async function hashTree(workdir: string): Promise<Manifest> {
  const paths: string[] = []
  await collect(workdir, '', paths)
  paths.sort()
  const manifest: Manifest = {}
  for (const path of paths) {
    manifest[path] = await hashFile(join(workdir, path))
  }
  return manifest
}

export function diff(a: Manifest, b: Manifest): ChangedFiles {
  const created: ChangedFile[] = []
  const modified: ChangedFile[] = []
  const deleted: string[] = []

  for (const [path, entry] of Object.entries(b)) {
    const before = a[path]
    if (before === undefined) created.push({ path, ...entry })
    else if (before.hash !== entry.hash) modified.push({ path, ...entry })
  }
  for (const path of Object.keys(a)) {
    if (b[path] === undefined) deleted.push(path)
  }

  const byPath = (x: ChangedFile, y: ChangedFile) =>
    x.path < y.path ? -1 : x.path > y.path ? 1 : 0
  created.sort(byPath)
  modified.sort(byPath)
  deleted.sort()
  return { created, modified, deleted }
}

async function collect(dir: string, rel: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (isExcludedPath(childRel)) continue
    if (entry.isDirectory()) await collect(join(dir, entry.name), childRel, out)
    else if (entry.isFile()) out.push(childRel)
  }
}

async function hashFile(absPath: string): Promise<FileEntry> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(absPath)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { hash: hash.digest('hex'), size }
}
