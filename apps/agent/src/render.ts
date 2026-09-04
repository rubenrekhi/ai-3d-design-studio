import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lastLines, runBlender } from './blender'

export const SCENE_GLB = 'scene.glb'
export const WHOLE_SCENE = 'scene'
export const ASSETS_DIR = 'assets'

/** An asset name becomes a Python module name, so it has to be an identifier. */
export const ASSET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const RENDER_DIR = '.renders'
const SCENE_WIDTH = 800
const SCENE_HEIGHT = 600
const SHEET_WIDTH = 400
const SHEET_HEIGHT = 300

export interface View {
  /** Degrees around the subject: 0 front, 90 right, 180 back, 270 left. */
  azimuth: number
  /** Degrees above the horizon: 0 eye level, 90 straight down. */
  elevation: number
  /** An object name, or `WHOLE_SCENE`. */
  framing: string
}

export interface Shot {
  label: string
  view: View
  /** Base64 PNG. Never written anywhere durable: a view is rebuilt, not stored. */
  png: string
}

export interface RenderOptions {
  /**
   * Names this call's scratch files. Pi hands tools their call id, and two
   * renders running at once must not read each other's parameters.
   */
  id: string
  signal?: AbortSignal
}

/**
 * The four views a contact sheet takes. Fixed, so `preview_asset` needs only a
 * name and its stub stays one line.
 */
export const ASSET_SHEET: { label: string; view: View }[] = [
  { label: 'the front', view: view(0, 10) },
  { label: 'three-quarters', view: view(45, 25) },
  { label: 'the side', view: view(90, 10) },
  { label: 'above', view: view(0, 85) },
]

/**
 * One line naming everything a view needs to be taken again. It is what the
 * model reads beside the image, and the recipe a stub leaves behind once the
 * image is gone.
 */
export function describeView(view: View): string {
  const subject =
    view.framing === WHOLE_SCENE ? 'the whole scene' : `"${view.framing}"`
  return `${subject} in ${SCENE_GLB} at ${angles(view)}`
}

export function describeShot(name: string, shot: Shot): string {
  return `"${name}" from ${shot.label} (${angles(shot.view)})`
}

export async function renderScene(
  workdir: string,
  view: View,
  opts: RenderOptions,
): Promise<{ png: string; durationMs: number }> {
  const glb = join(workdir, SCENE_GLB)
  if (!(await exists(glb))) {
    throw new Error(
      `There is no ${SCENE_GLB} to look at yet. Run run_blender first.`,
    )
  }

  const render = await runViews(workdir, opts, {
    glb,
    module: null,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    views: [{ label: 'view', view }],
  })
  const [shot] = render.shots
  if (shot === undefined) throw new Error('Blender rendered nothing.')
  return { png: shot.png, durationMs: render.durationMs }
}

/**
 * Builds the asset from its module into an empty scene, exports it, and looks
 * at that export rather than at the live scene — so what the agent judges is
 * what `scene.py` will get when it imports the same module.
 */
export async function renderAsset(
  workdir: string,
  name: string,
  opts: RenderOptions,
): Promise<{ shots: Shot[]; durationMs: number }> {
  if (!ASSET_NAME.test(name)) {
    throw new Error(
      `"${name}" is not an asset name. A name is a Python identifier: letters, digits, and underscores, not starting with a digit.`,
    )
  }
  const module = join(workdir, ASSETS_DIR, `${name}.py`)
  if (!(await exists(module))) {
    throw new Error(`There is no ${ASSETS_DIR}/${name}.py to preview.`)
  }

  return runViews(workdir, opts, {
    glb: join(workdir, RENDER_DIR, `${scratchName(opts.id)}.glb`),
    module: name,
    width: SHEET_WIDTH,
    height: SHEET_HEIGHT,
    views: ASSET_SHEET,
  })
}

interface RenderSpec {
  glb: string
  module: string | null
  width: number
  height: number
  views: { label: string; view: View }[]
}

async function runViews(
  workdir: string,
  opts: RenderOptions,
  spec: RenderSpec,
): Promise<{ shots: Shot[]; durationMs: number }> {
  const dir = join(workdir, RENDER_DIR)
  const name = scratchName(opts.id)
  const script = join(dir, `${name}.py`)
  const params = join(dir, `${name}.json`)
  const outputs = spec.views.map((_, i) => join(dir, `${name}-${i}.png`))
  // The GLB is ours to delete only when we built it from a module. On the scene
  // path it is `scene.glb`, which the manifest tracks and the run depends on.
  const scratch = [script, params, ...outputs]
  if (spec.module !== null) scratch.push(spec.glb)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(script, RENDER_SCRIPT)
    await writeFile(
      params,
      JSON.stringify(
        {
          workdir,
          glb: spec.glb,
          module: spec.module,
          width: spec.width,
          height: spec.height,
          views: spec.views.map((entry, i) => ({
            ...entry.view,
            output: outputs[i],
          })),
        },
        null,
        2,
      ),
    )

    const render = await runBlender(workdir, {
      script: `${RENDER_DIR}/${name}.py`,
      signal: opts.signal,
    })
    if (!render.ok) {
      throw new Error(`The render failed.\n\n${lastLines(render.stderr)}`)
    }

    const shots: Shot[] = []
    for (const [i, entry] of spec.views.entries()) {
      const png = await readFile(outputs[i] as string)
      shots.push({ ...entry, png: png.toString('base64') })
    }
    return { shots, durationMs: render.durationMs }
  } finally {
    await Promise.all(scratch.map((path) => rm(path, { force: true })))
  }
}

function view(azimuth: number, elevation: number): View {
  return { azimuth, elevation, framing: WHOLE_SCENE }
}

function angles(view: View): string {
  return `azimuth ${degrees(view.azimuth)}, elevation ${degrees(view.elevation)}`
}

function degrees(value: number): string {
  return `${Math.round(value)}°`
}

/**
 * A tool call id reaches us from the provider, so it is not trusted to be a
 * filename.
 */
function scratchName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return safe === '' ? randomUUID() : safe
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Written into the workspace on each call rather than shipped beside the code,
 * because the agent is bundled to a single file and Blender needs a real path.
 * `.renders/` is excluded from manifests, so nothing here is ever committed.
 *
 * The script reads its parameters from its own name with the extension
 * swapped, which is what lets one call's copy sit beside another's.
 *
 * It renders an exported GLB and not the live scene, which is what keeps the
 * image derivable: the same GLB and the same view rebuild it in a browser.
 */
const RENDER_SCRIPT = `import importlib
import json
import math
import os
import sys

import bpy
from mathutils import Vector

LENS_FOV = math.radians(40)
MARGIN = 1.1

with open(os.path.splitext(os.path.abspath(__file__))[0] + ".json") as handle:
    params = json.load(handle)

width = params["width"]
height = params["height"]

bpy.ops.wm.read_factory_settings(use_empty=True)

module_name = params["module"]
if module_name:
    # Blender puts neither the cwd nor the script's directory on sys.path.
    sys.path.insert(0, params["workdir"])
    try:
        module = importlib.import_module("${ASSETS_DIR}." + module_name)
    except Exception as exc:
        raise RuntimeError(
            "could not import ${ASSETS_DIR}/%s.py: %s" % (module_name, exc)
        )
    build = getattr(module, "build", None)
    if build is None:
        raise RuntimeError(
            "${ASSETS_DIR}/%s.py defines no build(). A preview calls build() with no "
            "arguments in an empty scene." % module_name
        )
    build()
    bpy.ops.export_scene.gltf(filepath=params["glb"])
    bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.import_scene.gltf(filepath=params["glb"])

scene = bpy.context.scene
scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x = width
scene.render.resolution_y = height
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"

shading = scene.display.shading
shading.light = "STUDIO"
shading.color_type = "MATERIAL"
# Workbench renders its backdrop from the world and ignores the viewport colour, and an
# empty file has no world, so without this every image comes back on pure black.
shading.background_type = "WORLD"
world = bpy.data.worlds.new("inspect")
world.color = (0.22, 0.22, 0.22)
scene.world = world

camera_data = bpy.data.cameras.new("inspect")
camera_data.angle = LENS_FOV
camera = bpy.data.objects.new("inspect", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera

# Fit the bounding sphere in the narrower of the two fields of view, so it fits in both.
vertical_fov = 2 * math.atan(math.tan(LENS_FOV / 2) * height / width)


def bounds(framing):
    if framing == "${WHOLE_SCENE}":
        targets = [obj for obj in scene.objects if obj.type == "MESH"]
        if not targets:
            raise RuntimeError("there are no meshes to look at")
    else:
        targets = [obj for obj in scene.objects if obj.name == framing]
        if not targets:
            names = ", ".join(sorted(obj.name for obj in scene.objects)) or "(none)"
            raise RuntimeError("no object named '%s'. Found: %s" % (framing, names))
    corners = [
        obj.matrix_world @ Vector(corner) for obj in targets for corner in obj.bound_box
    ]
    low = Vector(
        (min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners))
    )
    high = Vector(
        (max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners))
    )
    return (low + high) / 2, max((high - low).length / 2, 0.001)


for entry in params["views"]:
    center, radius = bounds(entry["framing"])
    azimuth = math.radians(entry["azimuth"])
    elevation = math.radians(entry["elevation"])
    # Azimuth 0 puts the camera on -Y, which is Blender's front view, and turns towards +X.
    offset = Vector(
        (
            math.sin(azimuth) * math.cos(elevation),
            -math.cos(azimuth) * math.cos(elevation),
            math.sin(elevation),
        )
    )
    distance = radius / math.sin(vertical_fov / 2) * MARGIN
    camera.location = center + offset * distance
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.clip_start = distance / 1000
    camera_data.clip_end = (distance + radius) * 10
    scene.render.filepath = entry["output"]
    bpy.ops.render.render(write_still=True)
`
