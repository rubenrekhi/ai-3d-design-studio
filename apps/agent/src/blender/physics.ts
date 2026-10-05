import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COLLISION_SUFFIXES,
  CONTRACT_VERSION_EXTRA,
  DEFAULT_PLAYER_CONTROLLER,
  PLAYER_CONTROLLER_EXTRA_KEYS,
  PLAYER_CONTROLLER_LIMITS,
  PLAYER_SPAWN_NAME,
  SCENE_CONTRACT_VERSION,
  SCENE_KIND_EXTRA,
  SCENE_SETTINGS_NAME,
  SOURCE_NAME_EXTRA,
  type PlayerControllerConfig,
  type SceneKind,
} from '@repo/scene-contract'
import { lastLines, runBlender } from './run'
import { SCENE_GLB } from './render'

const RENDER_DIR = '.renders'
const REPORT_MARKER = 'STUDIO_PHYSICS_REPORT:'

export interface PhysicsReport {
  kind: SceneKind
  colliderCount: number
  hiddenColliderCount: number
  triangleCount: number
  hasSpawn: boolean
  controller?: PlayerControllerConfig
}

export type PhysicsValidation =
  | { ok: true; durationMs: number; report: PhysicsReport }
  | { ok: false; durationMs: number; error: string }

export async function validateScenePhysics(
  workdir: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PhysicsValidation> {
  const dir = join(workdir, RENDER_DIR)
  const scriptName = `validate-${randomUUID()}.py`
  const script = join(dir, scriptName)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(script, VALIDATION_SCRIPT)
    const result = await runBlender(workdir, {
      script: `${RENDER_DIR}/${scriptName}`,
      signal: opts.signal,
    })
    if (!result.ok) {
      return {
        ok: false,
        durationMs: result.durationMs,
        error: lastLines(result.stderr),
      }
    }

    const reportLine = result.stdout
      .split('\n')
      .findLast((line) => line.startsWith(REPORT_MARKER))
    if (reportLine === undefined) {
      return {
        ok: false,
        durationMs: result.durationMs,
        error: 'Blender validated the GLB but returned no physics report.',
      }
    }

    try {
      return {
        ok: true,
        durationMs: result.durationMs,
        report: JSON.parse(reportLine.slice(REPORT_MARKER.length)),
      }
    } catch {
      return {
        ok: false,
        durationMs: result.durationMs,
        error: 'Blender returned an unreadable physics report.',
      }
    }
  } finally {
    await rm(script, { force: true })
  }
}

/**
 * Written into the workspace on each call for the same reason as the render
 * script: the agent is bundled to a single file and Blender needs a real path.
 */
const VALIDATION_SCRIPT = `import json
import math
import re

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

SCENE_GLB = ${JSON.stringify(SCENE_GLB)}
SETTINGS_NAME = ${JSON.stringify(SCENE_SETTINGS_NAME)}
SPAWN_NAME = ${JSON.stringify(PLAYER_SPAWN_NAME)}
KIND_KEY = ${JSON.stringify(SCENE_KIND_EXTRA)}
VERSION_KEY = ${JSON.stringify(CONTRACT_VERSION_EXTRA)}
CONTRACT_VERSION = ${SCENE_CONTRACT_VERSION}
COLLISION_SUFFIXES = ${JSON.stringify(Object.values(COLLISION_SUFFIXES))}
HIDDEN_SUFFIXES = ${JSON.stringify([
  COLLISION_SUFFIXES.hiddenTrimesh,
  COLLISION_SUFFIXES.hiddenConvex,
])}
CONVEX_SUFFIX = ${JSON.stringify(COLLISION_SUFFIXES.hiddenConvex)}
CONTROLLER_KEYS = ${JSON.stringify(PLAYER_CONTROLLER_EXTRA_KEYS)}
CONTROLLER_DEFAULTS = ${JSON.stringify(DEFAULT_PLAYER_CONTROLLER)}
CONTROLLER_LIMITS = ${JSON.stringify(PLAYER_CONTROLLER_LIMITS)}
REPORT_MARKER = ${JSON.stringify(REPORT_MARKER)}
SOURCE_NAME_KEY = ${JSON.stringify(SOURCE_NAME_EXTRA)}
MAX_PROXY_TRIANGLES = 5000


def fail(message):
    raise RuntimeError("Playable scene contract: " + message)


def source_name(obj):
    return obj.get(SOURCE_NAME_KEY, obj.name)


def finite_transform(obj):
    return all(math.isfinite(value) for row in obj.matrix_world for value in row)


def mesh_triangles(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def world_bvh(obj):
    vertices = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    polygons = [list(polygon.vertices) for polygon in obj.data.polygons]
    if not vertices or not polygons:
        fail("collision object '%s' has no usable mesh faces" % source_name(obj))
    return BVHTree.FromPolygons(vertices, polygons, all_triangles=False)


def validate_convex(obj):
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00001)
        if any(len(edge.link_faces) != 2 for edge in bm.edges):
            fail("convex collision object '%s' must be a closed manifold mesh" % source_name(obj))
        original_volume = abs(bm.calc_volume(signed=False))
        if original_volume <= 1e-8:
            fail("convex collision object '%s' has no enclosed volume" % source_name(obj))
        hull = bmesh.new()
        try:
            for vertex in bm.verts:
                hull.verts.new(vertex.co)
            hull.verts.ensure_lookup_table()
            bmesh.ops.convex_hull(hull, input=list(hull.verts), use_existing_faces=False)
            hull_volume = abs(hull.calc_volume(signed=False))
        finally:
            hull.free()
        if hull_volume > original_volume * 1.25 + 1e-8:
            fail("convex collision object '%s' is strongly concave (mesh volume %.4f, hull volume %.4f); split it into simple convex proxies" % (source_name(obj), original_volume, hull_volume))
    finally:
        bm.free()


def controller_from(spawn):
    config = dict(CONTROLLER_DEFAULTS)
    for field, key in CONTROLLER_KEYS.items():
        if key not in spawn:
            continue
        value = spawn[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            fail("%s on %s must be a finite number" % (key, SPAWN_NAME))
        low, high = CONTROLLER_LIMITS[field]
        if value < low or value > high:
            fail("%s on %s must be between %s and %s" % (key, SPAWN_NAME, low, high))
        config[field] = float(value)
    if config["radius"] * 2 >= config["height"]:
        fail("player radius must be less than half the player height")
    if config["eyeHeight"] > config["height"]:
        fail("player eye height cannot exceed player height")
    if config["runSpeed"] < config["walkSpeed"]:
        fail("player run speed cannot be lower than walk speed")
    return config


def validate_spawn(spawn, colliders, config):
    if not finite_transform(spawn):
        fail("%s has a non-finite transform" % SPAWN_NAME)
    point = spawn.matrix_world.translation
    bvhs = [world_bvh(obj) for obj in colliders]

    support = None
    origin = point + Vector((0, 0, 0.5))
    for bvh in bvhs:
        hit = bvh.ray_cast(origin, Vector((0, 0, -1)), max(1.5, config["height"]))
        if hit[0] is None or hit[1] is None or hit[1].z < 0.45:
            continue
        if support is None or hit[3] < support:
            support = hit[3]
    if support is None:
        fail("%s has no walkable collision surface directly beneath it" % SPAWN_NAME)
    if support > 0.65:
        fail("%s is %.2fm above its collision floor; place it at feet level" % (SPAWN_NAME, support - 0.5))

    clearance_radius = config["radius"] * 0.8
    heights = (config["radius"], config["height"] * 0.5, config["height"] - config["radius"])
    for height in heights:
        sample = point + Vector((0, 0, height))
        for bvh in bvhs:
            nearest = bvh.find_nearest(sample, clearance_radius)
            if nearest[0] is not None and nearest[3] < clearance_radius:
                fail("%s is obstructed; move it so a %.2fm radius, %.2fm tall player capsule is clear" % (SPAWN_NAME, config["radius"], config["height"]))


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SCENE_GLB)
objects = list(bpy.context.scene.objects)

for obj in objects:
    name = source_name(obj)
    if re.search(r"(?:-col|-colonly|-convcolonly)\\.\\d+$", name):
        fail("collision name '%s' was auto-suffixed; pass a unique instance_name so the collision suffix remains final" % name)

settings = [obj for obj in objects if source_name(obj) == SETTINGS_NAME]
if len(settings) != 1:
    fail("expected exactly one %s Empty, found %d" % (SETTINGS_NAME, len(settings)))
settings = settings[0]
if settings.type != "EMPTY":
    fail("%s must be an Empty" % SETTINGS_NAME)
kind = settings.get(KIND_KEY)
if kind not in ("asset", "environment"):
    fail("%s must set %s to 'asset' or 'environment'" % (SETTINGS_NAME, KIND_KEY))
version = settings.get(VERSION_KEY)
if version != CONTRACT_VERSION:
    fail("%s must set %s to %d" % (SETTINGS_NAME, VERSION_KEY, CONTRACT_VERSION))

spawns = [obj for obj in objects if source_name(obj) == SPAWN_NAME]
if len(spawns) > 1:
    fail("expected at most one %s Empty, found %d" % (SPAWN_NAME, len(spawns)))
if kind == "environment" and len(spawns) != 1:
    fail("environment scenes require exactly one %s Empty" % SPAWN_NAME)
if spawns and spawns[0].type != "EMPTY":
    fail("%s must be an Empty" % SPAWN_NAME)

colliders = []
hidden_count = 0
triangle_count = 0
for obj in objects:
    name = source_name(obj)
    suffix = next((suffix for suffix in COLLISION_SUFFIXES if name.endswith(suffix)), None)
    if suffix is None:
        continue
    if obj.type != "MESH":
        fail("collision object '%s' must be a mesh" % name)
    if not finite_transform(obj):
        fail("collision object '%s' has a non-finite transform" % name)
    triangles = mesh_triangles(obj)
    if triangles == 0:
        fail("collision object '%s' has no triangles" % name)
    if suffix in HIDDEN_SUFFIXES:
        hidden_count += 1
        if triangles > MAX_PROXY_TRIANGLES:
            fail("collision proxy '%s' has %d triangles; simplify it below %d" % (name, triangles, MAX_PROXY_TRIANGLES))
    if suffix == CONVEX_SUFFIX:
        validate_convex(obj)
    triangle_count += triangles
    colliders.append(obj)

if kind == "environment" and not colliders:
    fail("environment scenes require at least one collision mesh ending in -col, -colonly, or -convcolonly")

controller = None
if spawns:
    controller = controller_from(spawns[0])
    if kind == "environment":
        validate_spawn(spawns[0], colliders, controller)

report = {
    "kind": kind,
    "colliderCount": len(colliders),
    "hiddenColliderCount": hidden_count,
    "triangleCount": triangle_count,
    "hasSpawn": bool(spawns),
}
if controller is not None:
    report["controller"] = controller
print(REPORT_MARKER + json.dumps(report, separators=(",", ":")))
`
