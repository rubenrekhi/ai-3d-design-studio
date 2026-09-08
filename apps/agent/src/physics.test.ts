import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildScene } from './build'
import { renderPhysicsScene } from './render'
import { GOOD_SCENE, hasBlender } from './test/fixture'

const workdirs: string[] = []

afterEach(async () => {
  await Promise.all(
    workdirs
      .splice(0)
      .map((workdir) => rm(workdir, { recursive: true, force: true })),
  )
})

async function build(script: string) {
  const workdir = await mkdtemp(join(tmpdir(), 'studio-physics-'))
  workdirs.push(workdir)
  await writeFile(join(workdir, 'scene.py'), script)
  return buildScene(workdir)
}

function environment(extra = ''): string {
  return `import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(location=(0, 0, -0.1), scale=(3, 3, 0.1))
bpy.context.object.name = "Floor-col"

settings = bpy.data.objects.new("__studio_scene_settings__", None)
settings["studio_contract_version"] = 1
settings["studio_scene_kind"] = "environment"
bpy.context.scene.collection.objects.link(settings)

spawn = bpy.data.objects.new("__studio_player_spawn__", None)
spawn.location = (0, 0, 0)
bpy.context.scene.collection.objects.link(spawn)

${extra}

bpy.ops.export_scene.gltf(
    filepath="scene.glb", export_apply=True, export_extras=True
)
`
}

describe.skipIf(!hasBlender)('playable scene validation', () => {
  it('accepts asset scenes and valid walkable environments', async () => {
    const asset = await build(GOOD_SCENE)
    expect(asset).toMatchObject({
      ok: true,
      physics: { kind: 'asset', colliderCount: 0, hasSpawn: false },
    })

    const room = await build(environment())
    expect(room).toMatchObject({
      ok: true,
      physics: { kind: 'environment', colliderCount: 1, hasSpawn: true },
    })
    const workdir = workdirs.at(-1)
    if (workdir === undefined) throw new Error('missing test workspace')
    const overlay = await renderPhysicsScene(
      workdir,
      { azimuth: 35, elevation: 30, framing: 'scene' },
      { id: 'physics-test' },
    )
    expect(Buffer.from(overlay.png, 'base64').byteLength).toBeGreaterThan(1_000)
  }, 30_000)

  it('rejects an environment without a spawn', async () => {
    const result = await build(
      environment().replace(
        /spawn = bpy\.data\.objects\.new[\s\S]*?collection\.objects\.link\(spawn\)\n/,
        '',
      ),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(
      'environment scenes require exactly one __studio_player_spawn__ Empty',
    )
  })

  it('rejects auto-suffixed colliders and obstructed spawns', async () => {
    const duplicate = await build(
      environment(`bpy.ops.mesh.primitive_cube_add(location=(2, 2, 0.5))
bpy.context.object.name = "Crate-col.001"`),
    )
    expect(duplicate.ok).toBe(false)
    if (!duplicate.ok) {
      expect(duplicate.error).toContain('collision name')
      expect(duplicate.error).toContain('was auto-suffixed')
    }

    const blocked = await build(
      environment(`bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.9), scale=(0.2, 0.2, 0.9))
bpy.context.object.name = "SpawnBlock-convcolonly"`),
    )
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error).toContain('is obstructed')
  }, 30_000)
})
