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
import { BufferGeometry, Mesh, Object3D, Quaternion, Vector3 } from 'three'
import type { SceneViewerInfo, SpawnDescription } from './types'

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
  info: SceneViewerInfo
}

export function prepareScene(source: Object3D): PreparedScene {
  const visual = cloneVisual(source)
  visual.updateMatrixWorld(true)

  const colliders: ColliderDescription[] = []
  const settings: Object3D[] = []
  const spawns: Object3D[] = []
  let hasLights = false

  visual.traverse((node) => {
    const name = sourceName(node.name, node.userData)
    if (name === SCENE_SETTINGS_NAME) settings.push(node)
    if (name === PLAYER_SPAWN_NAME) spawns.push(node)
    if (node.type.endsWith('Light')) hasLights = true

    const kind = collisionKind(name)
    if (kind === undefined) return
    if (!(node instanceof Mesh) || !(node.geometry instanceof BufferGeometry)) {
      throw new Error(`${name} declares collision but is not a mesh`)
    }
    colliders.push(colliderFromMesh(node, name, kind))
    if (collisionIsHidden(kind)) node.visible = false
  })

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
    hasLights,
    info: {
      kind,
      contractVersion,
      colliderCount: colliders.length,
      hasSpawn: spawn !== undefined,
    },
  }
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
