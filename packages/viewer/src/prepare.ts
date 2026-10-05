import {
  collisionIsHidden,
  collisionKind,
  PLAYER_SPAWN_NAME,
  readContractVersion,
  readPlayerController,
  readSceneKind,
  SCENE_CONTRACT_VERSION,
  SCENE_SETTINGS_NAME,
  sourceName,
  type CollisionKind,
  type SceneKind,
} from '@repo/scene-contract'
import {
  Box3,
  BufferGeometry,
  DirectionalLight,
  Light,
  Mesh,
  Object3D,
  PointLight,
  Quaternion,
  Sphere,
  SpotLight,
  Vector3,
} from 'three'
import type { SceneViewerInfo, SpawnDescription } from './types'

const SHADOW_MAP_SIZE = 2048

export interface ColliderDescription {
  name: string
  kind: CollisionKind
  vertices: Float32Array
  indices: Uint32Array
}

export interface PreparedScene {
  visual: Object3D
  colliders: ColliderDescription[]
  spawn?: SpawnDescription
  kind?: SceneKind
  contractVersion?: number
  hasLights: boolean
  bounds: Sphere
  info: SceneViewerInfo
}

export function prepareScene(source: Object3D): PreparedScene {
  const visual = cloneVisual(source)
  visual.updateMatrixWorld(true)

  const colliders: ColliderDescription[] = []
  const settings: Object3D[] = []
  const spawns: Object3D[] = []
  const lights: Light[] = []

  visual.traverse((node) => {
    const name = sourceName(node.name, node.userData)
    if (name === SCENE_SETTINGS_NAME) settings.push(node)
    if (name === PLAYER_SPAWN_NAME) spawns.push(node)
    if (node instanceof Light) lights.push(node)
    if (node instanceof Mesh) {
      node.castShadow = true
      node.receiveShadow = true
    }

    const kind = collisionKind(name)
    if (kind === undefined) return
    if (!(node instanceof Mesh) || !(node.geometry instanceof BufferGeometry)) {
      throw new Error(`${name} declares collision but is not a mesh`)
    }
    colliders.push(colliderFromMesh(node, name, kind))
    // A hidden proxy is skipped by the shadow pass along with everything else
    // invisible, so its blocking volume never darkens the room it stands in.
    if (collisionIsHidden(kind)) node.visible = false
  })

  const bounds = boundsOf(visual)
  for (const light of lights) castShadows(light, bounds, visual)
  visual.updateMatrixWorld(true)

  if (settings.length > 1) {
    throw new Error(`Found ${settings.length} ${SCENE_SETTINGS_NAME} nodes`)
  }
  if (spawns.length > 1) {
    throw new Error(`Found ${spawns.length} ${PLAYER_SPAWN_NAME} nodes`)
  }

  const settingsNode = settings[0]
  const kind = settingsNode && readSceneKind(settingsNode.userData)
  const contractVersion =
    settingsNode && readContractVersion(settingsNode.userData)
  if (
    contractVersion !== undefined &&
    contractVersion !== SCENE_CONTRACT_VERSION
  ) {
    throw new Error(
      `Unsupported scene contract ${contractVersion}; this viewer supports ${SCENE_CONTRACT_VERSION}`,
    )
  }

  const spawnNode = spawns[0]
  if (kind === 'environment' && spawnNode === undefined) {
    throw new Error(
      `${SCENE_SETTINGS_NAME} declares an environment with no spawn`,
    )
  }

  let spawn: SpawnDescription | undefined
  if (spawnNode !== undefined) {
    const player = readPlayerController(spawnNode.userData)
    if (player.errors.length > 0) {
      throw new Error(player.errors.join('; '))
    }
    const position = spawnNode.getWorldPosition(new Vector3())
    const quaternion = spawnNode.getWorldQuaternion(new Quaternion())
    spawn = {
      position: position.toArray(),
      quaternion: quaternion.toArray(),
      controller: player.config,
    }
  }

  return {
    visual,
    colliders,
    spawn,
    kind,
    contractVersion,
    hasLights: lights.length > 0,
    bounds,
    info: {
      kind,
      contractVersion,
      colliderCount: colliders.length,
      hasSpawn: spawn !== undefined,
    },
  }
}

export function boundsOf(root: Object3D): Sphere {
  const box = new Box3().setFromObject(root)
  const sphere = box.isEmpty()
    ? new Sphere(new Vector3(), 1)
    : box.getBoundingSphere(new Sphere())
  sphere.radius = Math.max(sphere.radius, 1)
  return sphere
}

/**
 * A Blender sun carries only a direction, so it exports at whatever origin it
 * was left at — usually inside the room it lights, where an orthographic shadow
 * camera sees almost none of the scene. Walking the light back along its own
 * aim puts the whole scene in front of it without changing how anything is lit.
 * A point or spot lamp stands where a real fixture does, so it is only given a
 * far plane wide enough to reach the far wall.
 */
export function castShadows(
  light: Light,
  bounds: Sphere,
  root: Object3D,
): void {
  // Ambient and hemisphere light has no direction to cast from and no shadow
  // camera to configure.
  if (!(
    light instanceof DirectionalLight ||
    light instanceof PointLight ||
    light instanceof SpotLight
  )) {
    return
  }

  light.castShadow = true
  light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
  light.shadow.normalBias = 0.02

  if (!(light instanceof DirectionalLight)) {
    light.shadow.camera.far = bounds.radius * 4
    light.shadow.camera.updateProjectionMatrix()
    return
  }

  // Read the aim before moving anything: a directional light points from its
  // own position at its target, so once both are ours the node's rotation stops
  // mattering. Both move to the root, where the bounds were measured.
  const aim = new Vector3(0, 0, -1)
    .applyQuaternion(light.getWorldQuaternion(new Quaternion()))
    .normalize()
  const distance = bounds.radius * 2
  const target = new Object3D()
  target.position.copy(bounds.center)
  root.add(target)
  root.add(light)
  light.target = target
  light.position.copy(bounds.center).addScaledVector(aim, -distance)

  const camera = light.shadow.camera
  camera.left = -bounds.radius
  camera.right = bounds.radius
  camera.top = bounds.radius
  camera.bottom = -bounds.radius
  camera.near = bounds.radius * 0.5
  camera.far = distance + bounds.radius * 2
  camera.updateProjectionMatrix()
}

export function disposePreparedScene(scene: PreparedScene): void {
  scene.visual.traverse((node) => {
    if (!(node instanceof Mesh)) return
    node.geometry.dispose()
    const materials = Array.isArray(node.material)
      ? node.material
      : [node.material]
    for (const material of materials) material.dispose()
  })
}

function cloneVisual(source: Object3D): Object3D {
  const clone = source.clone(true)
  clone.traverse((node) => {
    if (!(node instanceof Mesh)) return
    node.geometry = node.geometry.clone()
    node.material = Array.isArray(node.material)
      ? node.material.map((material) => material.clone())
      : node.material.clone()
  })
  return clone
}

function colliderFromMesh(
  mesh: Mesh,
  name: string,
  kind: CollisionKind,
): ColliderDescription {
  const position = mesh.geometry.getAttribute('position')
  if (position === undefined || position.itemSize !== 3 || position.count < 3) {
    throw new Error(`${name} has no usable position geometry`)
  }

  const vertices = new Float32Array(position.count * 3)
  const point = new Vector3()
  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld)
    point.toArray(vertices, index * 3)
  }

  const geometryIndex = mesh.geometry.getIndex()
  const indexCount = geometryIndex?.count ?? position.count
  if (indexCount < 3 || indexCount % 3 !== 0) {
    throw new Error(`${name} does not contain complete triangles`)
  }
  const indices = new Uint32Array(indexCount)
  for (let index = 0; index < indexCount; index++) {
    indices[index] = geometryIndex?.getX(index) ?? index
  }

  return { name, kind, vertices, indices }
}
