import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COLLISION_SUFFIXES,
  DEFAULT_PLAYER_CONTROLLER,
  PLAYER_CONTROLLER_EXTRA_KEYS,
  PLAYER_SPAWN_NAME,
  SOURCE_NAME_EXTRA,
} from '@repo/scene-contract'
import { lastLines, runBlender } from './run'

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

export function describeShot(
  name: string,
  shot: Pick<Shot, 'label' | 'view'>,
): string {
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
    physics: false,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    views: [{ label: 'view', view }],
  })
  const [shot] = render.shots
  if (shot === undefined) throw new Error('Blender rendered nothing.')
  return { png: shot.png, durationMs: render.durationMs }
}

export async function renderPhysicsScene(
  workdir: string,
  view: View,
  opts: RenderOptions,
): Promise<{ png: string; durationMs: number }> {
  const glb = join(workdir, SCENE_GLB)
  if (!(await exists(glb))) {
    throw new Error(
      `There is no ${SCENE_GLB} to inspect yet. Run run_blender first.`,
    )
  }

  const render = await runViews(workdir, opts, {
    glb,
    module: null,
    physics: true,
    width: SCENE_WIDTH,
    height: SCENE_HEIGHT,
    views: [{ label: 'physics', view }],
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
  opts: RenderOptions & { physics?: boolean },
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
    physics: opts.physics ?? false,
    width: SHEET_WIDTH,
    height: SHEET_HEIGHT,
    views: ASSET_SHEET,
  })
}

interface RenderSpec {
  glb: string
  module: string | null
  physics: boolean
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
          physics: spec.physics,
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
COLLISION_SUFFIXES = ${JSON.stringify(Object.values(COLLISION_SUFFIXES))}
HIDDEN_COLLISION_SUFFIXES = ${JSON.stringify([
  COLLISION_SUFFIXES.hiddenTrimesh,
  COLLISION_SUFFIXES.hiddenConvex,
])}
SPAWN_NAME = ${JSON.stringify(PLAYER_SPAWN_NAME)}
SOURCE_NAME_KEY = ${JSON.stringify(SOURCE_NAME_EXTRA)}
CONTROLLER_KEYS = ${JSON.stringify(PLAYER_CONTROLLER_EXTRA_KEYS)}
CONTROLLER_DEFAULTS = ${JSON.stringify(DEFAULT_PLAYER_CONTROLLER)}

with open(os.path.splitext(os.path.abspath(__file__))[0] + ".json") as handle:
    params = json.load(handle)

width = params["width"]
height = params["height"]
physics = params["physics"]

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
    bpy.ops.export_scene.gltf(
        filepath=params["glb"],
        export_apply=True,
        export_extras=True,
        export_lights=True,
        export_import_convert_lighting_mode="COMPAT",
    )
    bpy.ops.wm.read_factory_settings(use_empty=True)

bpy.ops.import_scene.gltf(filepath=params["glb"])

scene = bpy.context.scene


def source_name(obj):
    return obj.get(SOURCE_NAME_KEY, obj.name)


def collision_suffix(obj):
    name = source_name(obj)
    return next((suffix for suffix in COLLISION_SUFFIXES if name.endswith(suffix)), None)


def set_colour(obj, colour):
    obj.color = (*colour, 1.0)


def add_cylinder_between(name, start, end, radius, colour, vertices=12):
    delta = end - start
    if delta.length <= 0.0001:
        return None
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=delta.length,
        location=(start + end) / 2,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = delta.to_track_quat("Z", "Y").to_euler()
    set_colour(obj, colour)
    return obj


def add_spawn_debug(spawn):
    origin = spawn.matrix_world.translation
    rotation = spawn.matrix_world.to_quaternion()
    player_height = float(spawn.get(CONTROLLER_KEYS["height"], CONTROLLER_DEFAULTS["height"]))
    radius = float(spawn.get(CONTROLLER_KEYS["radius"], CONTROLLER_DEFAULTS["radius"]))
    eye_height = float(spawn.get(CONTROLLER_KEYS["eyeHeight"], CONTROLLER_DEFAULTS["eyeHeight"]))
    colour = (1.0, 0.08, 0.65)
    wire_radius = max(radius * 0.045, 0.008)
    for index, z in enumerate((radius, player_height / 2, player_height - radius)):
        bpy.ops.mesh.primitive_torus_add(
            major_segments=32,
            minor_segments=6,
            location=origin + Vector((0, 0, z)),
            major_radius=radius,
            minor_radius=wire_radius,
        )
        ring = bpy.context.object
        ring.name = "__studio_debug_capsule_ring_%d" % index
        set_colour(ring, colour)
    low = origin.z + radius
    high = origin.z + player_height - radius
    for index, (x, y) in enumerate(((radius, 0), (-radius, 0), (0, radius), (0, -radius))):
        add_cylinder_between(
            "__studio_debug_capsule_side_%d" % index,
            Vector((origin.x + x, origin.y + y, low)),
            Vector((origin.x + x, origin.y + y, high)),
            wire_radius,
            colour,
            8,
        )
    arrow_start = origin + Vector((0, 0, eye_height))
    forward = rotation @ Vector((0, 1, 0))
    forward.z = 0
    if forward.length <= 0.0001:
        forward = Vector((0, 1, 0))
    forward.normalize()
    arrow_end = arrow_start + forward * max(0.9, radius * 3)
    add_cylinder_between(
        "__studio_debug_spawn_facing",
        arrow_start,
        arrow_end,
        wire_radius * 1.6,
        (1.0, 0.72, 0.05),
        10,
    )
    bpy.ops.mesh.primitive_cone_add(
        vertices=16,
        radius1=radius * 0.22,
        radius2=0,
        depth=radius * 0.5,
        location=arrow_end + forward * radius * 0.2,
    )
    arrow = bpy.context.object
    arrow.name = "__studio_debug_spawn_arrow"
    arrow.rotation_euler = forward.to_track_quat("Z", "Y").to_euler()
    set_colour(arrow, (1.0, 0.72, 0.05))


if physics:
    colours = {
        ${JSON.stringify(COLLISION_SUFFIXES.visibleTrimesh)}: (0.12, 0.9, 0.3),
        ${JSON.stringify(COLLISION_SUFFIXES.hiddenTrimesh)}: (0.05, 0.58, 1.0),
        ${JSON.stringify(COLLISION_SUFFIXES.hiddenConvex)}: (1.0, 0.35, 0.05),
    }
    for obj in list(scene.objects):
        if obj.type != "MESH":
            continue
        suffix = collision_suffix(obj)
        set_colour(obj, colours.get(suffix, (0.32, 0.34, 0.38)))
    spawns = [obj for obj in scene.objects if source_name(obj) == SPAWN_NAME]
    if spawns:
        add_spawn_debug(spawns[0])
else:
    for obj in scene.objects:
        if collision_suffix(obj) in HIDDEN_COLLISION_SUFFIXES:
            obj.hide_render = True

scene.render.engine = "BLENDER_WORKBENCH"
scene.render.resolution_x = width
scene.render.resolution_y = height
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"

shading = scene.display.shading
shading.light = "STUDIO"
shading.color_type = "OBJECT" if physics else "MATERIAL"
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
        targets = [obj for obj in scene.objects if obj.type == "MESH" and not obj.hide_render]
        if not targets:
            raise RuntimeError("there are no meshes to look at")
    else:
        targets = [obj for obj in scene.objects if source_name(obj) == framing and not obj.hide_render]
        if not targets:
            names = ", ".join(sorted(source_name(obj) for obj in scene.objects if not obj.hide_render)) or "(none)"
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
