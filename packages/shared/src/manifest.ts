export type FileEntry = { hash: string; size: number }

export type Manifest = Record<string, FileEntry>

export type ChangedFile = FileEntry & { path: string }

export type ChangedFiles = {
  created: ChangedFile[]
  modified: ChangedFile[]
  deleted: string[]
}

// The hasher (apps/agent) and materialize (apps/web) are inverses over this set, and materialize
// deletes anything a manifest omits. If their exclusion logic ever diverged, a reconcile would erase
// the excluded files — e.g. .pi/, the conversation. They must not drift, so the set and the matcher
// live here as the single source of truth: apps/web cannot import apps/agent, and this is the only
// package both can reach.

/** Matched at the workspace root only; a nested `.pi/` or `.renders/` is content. */
export const EXCLUDED_ROOT_DIRS: readonly string[] = ['.pi', '.renders']

/**
 * Matched at any depth. Python writes `__pycache__` beside every module it
 * imports, so one appears in `assets/` the first time `scene.py` imports an
 * asset. It is derivable, it churns on every build, and Blender ignores
 * `PYTHONDONTWRITEBYTECODE`, so keeping it out of manifests is the only lever.
 */
export const EXCLUDED_ANY_DIRS: readonly string[] = ['__pycache__']

export function isExcludedPath(relPath: string): boolean {
  const segments = relPath.replace(/\\/g, '/').split('/')
  const [first = ''] = segments
  return (
    EXCLUDED_ROOT_DIRS.includes(first) ||
    segments.some((segment) => EXCLUDED_ANY_DIRS.includes(segment))
  )
}
