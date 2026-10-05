import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { lastLines, runBlender } from './blender'
import { type PhysicsReport, validateScenePhysics } from './physics'
import { SCENE_GLB } from './render'

export const SCENE_SCRIPT = 'scene.py'

export type Build =
  | {
      ok: true
      durationMs: number
      size: number
      printed: string
      physics: PhysicsReport
    }
  | { ok: false; durationMs: number; error: string }

/**
 * Runs `scene.py` and checks that it exported a GLB. Both the tool and the
 * build guard judge a build by this, so they cannot disagree about one.
 */
export async function buildScene(
  workdir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Build> {
  const build = await runBlender(workdir, { signal: opts.signal })
  if (!build.ok) {
    return {
      ok: false,
      durationMs: build.durationMs,
      error: lastLines(build.stderr),
    }
  }

  const size = await sizeOf(join(workdir, SCENE_GLB))
  if (size === undefined) {
    return {
      ok: false,
      durationMs: build.durationMs,
      error: `${SCENE_SCRIPT} ran without error but wrote no ${SCENE_GLB}. It must end by exporting one: bpy.ops.export_scene.gltf(filepath="${SCENE_GLB}").`,
    }
  }

  const validation = await validateScenePhysics(workdir, opts)
  if (!validation.ok) {
    return {
      ok: false,
      durationMs: build.durationMs + validation.durationMs,
      error: validation.error,
    }
  }

  return {
    ok: true,
    durationMs: build.durationMs + validation.durationMs,
    size,
    printed: lastLines(build.stdout),
    physics: validation.report,
  }
}

export async function hasScene(workdir: string): Promise<boolean> {
  return (await sizeOf(join(workdir, SCENE_SCRIPT))) !== undefined
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}
