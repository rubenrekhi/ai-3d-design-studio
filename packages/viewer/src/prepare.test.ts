import { readFile } from 'node:fs/promises'
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import {
  CONTRACT_VERSION_EXTRA,
  PLAYER_CONTROLLER_EXTRA_KEYS,
  PLAYER_SPAWN_NAME,
  SCENE_CONTRACT_VERSION,
  SCENE_KIND_EXTRA,
  SCENE_SETTINGS_NAME,
} from '@repo/scene-contract'
import { disposePreparedScene, prepareScene } from './prepare'

function environment(withSpawn = true): Group {
  const scene = new Group()
  const settings = new Object3D()
  settings.name = SCENE_SETTINGS_NAME
  settings.userData = {
    [CONTRACT_VERSION_EXTRA]: SCENE_CONTRACT_VERSION,
    [SCENE_KIND_EXTRA]: 'environment',
  }
  scene.add(settings)

  if (withSpawn) {
    const spawn = new Object3D()
    spawn.name = PLAYER_SPAWN_NAME
    spawn.position.set(1, 0, 2)
    spawn.userData = { [PLAYER_CONTROLLER_EXTRA_KEYS.jumpSpeed]: 6 }
    scene.add(spawn)
  }

  const floor = new Mesh(new BoxGeometry(8, 0.2, 8))
  floor.name = 'Floor-col'
  scene.add(floor)

  const couch = new Mesh(new BoxGeometry(2, 1, 0.8), new MeshStandardMaterial())
  couch.name = 'Couch-convcolonly'
  couch.position.set(2, 0.5, -1)
  scene.add(couch)

  const decoration = new Mesh(new BoxGeometry(0.1, 1, 0.1))
  decoration.name = 'PlantStem'
  scene.add(decoration)
  return scene
}

describe('prepareScene', () => {
  it('extracts declared colliders, hides proxies, and reads the spawn', () => {
    const prepared = prepareScene(environment())
    expect(prepared.info).toMatchObject({
      kind: 'environment',
      contractVersion: SCENE_CONTRACT_VERSION,
      colliderCount: 2,
      hasSpawn: true,
    })
    // The toolbar seeds its sliders from what the scene authored.
    expect(prepared.info.controller?.jumpSpeed).toBe(6)
    expect(prepared.colliders.map((collider) => collider.kind)).toEqual([
      'visibleTrimesh',
      'hiddenConvex',
    ])
    expect(prepared.spawn?.position).toEqual([1, 0, 2])
    expect(prepared.spawn?.controller.jumpSpeed).toBe(6)
    expect(prepared.visual.getObjectByName('Couch-convcolonly')?.visible).toBe(
      false,
    )
    expect(prepared.visual.getObjectByName('PlantStem')?.visible).toBe(true)
    disposePreparedScene(prepared)
  })

  it('rejects an environment without a spawn', () => {
    expect(() => prepareScene(environment(false))).toThrow(
      'declares an environment with no spawn',
    )
  })

  it('rejects a scene built against a contract it cannot read', () => {
    const scene = environment()
    const settings = scene.getObjectByName(SCENE_SETTINGS_NAME)
    if (settings === undefined) throw new Error('missing settings node')
    settings.userData[CONTRACT_VERSION_EXTRA] = SCENE_CONTRACT_VERSION + 1
    expect(() => prepareScene(scene)).toThrow('Unsupported scene contract')
  })

  it('bakes collider geometry into world space', () => {
    const scene = new Group()
    const room = new Group()
    room.position.set(10, 0, -4)
    const slab = new Mesh(new BoxGeometry(2, 2, 2))
    slab.name = 'Slab-colonly'
    room.add(slab)
    scene.add(room)

    const prepared = prepareScene(scene)
    const collider = prepared.colliders[0]
    if (collider === undefined) throw new Error('missing collider')
    const xs = collider.vertices.filter((_, index) => index % 3 === 0)
    const zs = collider.vertices.filter((_, index) => index % 3 === 2)
    expect(Math.min(...xs)).toBeCloseTo(9)
    expect(Math.max(...xs)).toBeCloseTo(11)
    expect(Math.min(...zs)).toBeCloseTo(-5)
    expect(Math.max(...zs)).toBeCloseTo(-3)
    expect(collider.indices.length % 3).toBe(0)
    disposePreparedScene(prepared)
  })

  it('makes every mesh take part in shadows', () => {
    const prepared = prepareScene(environment())
    const floor = prepared.visual.getObjectByName('Floor-col')
    if (!(floor instanceof Mesh)) throw new Error('missing floor')
    expect(floor.castShadow).toBe(true)
    expect(floor.receiveShadow).toBe(true)
    disposePreparedScene(prepared)
  })

  it('aims a sun at the scene from outside it', () => {
    const scene = environment()
    const source = new DirectionalLight()
    source.name = 'Sun'
    source.rotation.set(-Math.PI / 3, 0, 0)
    scene.add(source)

    const prepared = prepareScene(scene)
    expect(prepared.hasLights).toBe(true)
    // prepareScene works on a clone, so the caller's own GLTF scene is untouched.
    expect(source.castShadow).toBe(false)

    const sun = prepared.visual.getObjectByName('Sun')
    if (!(sun instanceof DirectionalLight)) throw new Error('missing sun')
    expect(sun.castShadow).toBe(true)

    const distance = sun
      .getWorldPosition(new Vector3())
      .distanceTo(prepared.bounds.center)
    expect(distance).toBeGreaterThan(prepared.bounds.radius)
    expect(sun.target.position).toEqual(prepared.bounds.center)
    expect(sun.shadow.camera.right).toBeCloseTo(prepared.bounds.radius)
    expect(sun.shadow.camera.far).toBeGreaterThan(distance)
    disposePreparedScene(prepared)
  })

  it('leaves a light with nothing to cast from alone', () => {
    const scene = environment()
    const ambient = new AmbientLight()
    ambient.name = 'Ambient'
    scene.add(ambient)

    const prepared = prepareScene(scene)
    expect(prepared.hasLights).toBe(true)
    expect(prepared.visual.getObjectByName('Ambient')?.castShadow).toBe(false)
    disposePreparedScene(prepared)
  })

  it('reads the Blender-exported fixture contract', async () => {
    const file = await readFile(
      new URL('../../../apps/preview/fixture/scene.glb', import.meta.url),
    )
    const bytes = file.buffer.slice(
      file.byteOffset,
      file.byteOffset + file.byteLength,
    ) as ArrayBuffer
    const gltf = await new Promise<GLTF>((resolve, reject) => {
      new GLTFLoader().parse(bytes, '', resolve, reject)
    })
    const prepared = prepareScene(gltf.scene)
    expect(prepared.kind).toBe('environment')
    expect(prepared.hasLights).toBe(true)
    expect(prepared.spawn?.position[1]).toBeCloseTo(0)
    expect(prepared.colliders.map((collider) => collider.name)).toEqual(
      expect.arrayContaining([
        'DemoFloor-col',
        'DemoCouch-convcolonly',
        'StairRamp-colonly',
      ]),
    )
    disposePreparedScene(prepared)
  })
})
