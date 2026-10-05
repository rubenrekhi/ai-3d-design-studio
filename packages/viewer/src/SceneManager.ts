/// <reference path="./n8ao.d.ts" />
// n8ao ships no types. The reference pulls the declaration into every program
// that compiles this file, not only the one that lists this package's `src`.
import {
  AgXToneMapping,
  Clock,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  PCFShadowMap,
  PerspectiveCamera,
  Ray,
  SRGBColorSpace,
  Scene,
  Triangle,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { N8AOPass } from 'n8ao'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'
import { Capsule } from 'three/addons/math/Capsule.js'
import { Octree } from 'three/addons/math/Octree.js'
import { Sky } from 'three/addons/objects/Sky.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { PMREMGenerator } from 'three'
import type { PreparedScene } from './prepare'
import { disposePreparedScene } from './prepare'
import type { PlayerTuning, ViewerMode } from './types'

const EXPOSURE = 0.8
const MAX_PIXEL_RATIO = 2
const ORBIT_DAMPING = 0.075
const POINTER_SPEED = 0.6
const ENVIRONMENT_INTENSITY = 0.08
const SKY_SIZE = 450_000
const SKY_RAYLEIGH = 1.8
const SKY_MIE_COEFFICIENT = 0.003
const SKY_MIE_DIRECTIONAL_G = 0.82

const AO_RADIUS = 0.35
const AO_INTENSITY = 2.35
const BLOOM_STRENGTH = 0.1
const BLOOM_RADIUS = 0.25
const BLOOM_THRESHOLD = 1.2

/** Fixed physics rate, so movement is identical whatever the display runs at. */
const STEP_SECONDS = 1 / 120
const GROUND_RESPONSE = 12
const GROUND_STOP_RESPONSE = 18
const AIR_CONTROL = 4
const COLLISION_ITERATIONS = 3
const COLLISION_EPSILON = 1e-6
const COLLISION_SKIN = 0.01
const FLOOR_SNAP = 0.25

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
])

export interface SceneManagerEvents {
  onModeChange?: (mode: ViewerMode) => void
  onPointerLockChange?: (locked: boolean) => void
}

/**
 * The viewer runs its own loop rather than a React one. A reconciliation pass
 * between every frame and the screen is what turns a damped camera from gliding
 * into clicking, and none of the per-frame work here needs React to describe it.
 */
export class SceneManager {
  readonly camera = new PerspectiveCamera(50, 1, 0.05, 4000)
  private readonly scene = new Scene()
  private readonly renderer: WebGLRenderer
  private readonly composer: EffectComposer
  private readonly controls: OrbitControls
  private readonly walkControls: PointerLockControls
  private readonly sky = new Sky()
  private readonly clock = new Clock()
  private readonly fallback = new Group()

  private readonly world = new Octree()
  private readonly collider = new Capsule()
  private readonly spawnCollider = new Capsule()
  private readonly velocity = new Vector3()
  private readonly desired = new Vector3()
  private readonly forward = new Vector3()
  private readonly right = new Vector3()
  private readonly correction = new Vector3()
  private readonly previousStart = new Vector3()
  private readonly floorRay = new Ray()
  private readonly floorNormal = new Vector3()
  private readonly pressed = new Set<string>()

  private prepared: PreparedScene | null = null
  private root: Group | null = null
  private environmentTarget: ReturnType<PMREMGenerator['fromScene']> | null =
    null
  private mode: ViewerMode = 'orbit'
  private tuning: PlayerTuning | null = null
  private eyeHeight = 1.7
  private gravity = 9.8
  private minFloorNormalY = Math.cos(MathUtils.degToRad(45))
  private fallReset = 12
  private onFloor = false
  private jumpQueued = false
  private accumulator = 0
  private frame = 0
  private disposed = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly events: SceneManagerEvents = {},
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      // N8AO resolves through offscreen targets, so SMAA does the antialiasing.
      antialias: false,
      powerPreference: 'high-performance',
    })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.toneMapping = AgXToneMapping
    this.renderer.toneMappingExposure = EXPOSURE
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = PCFShadowMap
    // Nothing in these scenes moves, so the shadow map is rendered per load.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    )
    this.renderer.setClearColor(0x0b0d10, 1)

    this.camera.position.set(6, 4.5, 8)
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = ORBIT_DAMPING
    this.controls.screenSpacePanning = true
    this.controls.target.set(0, 0.75, 0)
    this.controls.update()

    this.walkControls = new PointerLockControls(this.camera, canvas)
    this.walkControls.pointerSpeed = POINTER_SPEED
    this.walkControls.addEventListener('lock', this.handleLock)
    this.walkControls.addEventListener('unlock', this.handleUnlock)

    // Only lit when the GLB carries no light of its own, which now means the
    // scene was authored without one rather than that Blender dropped it.
    this.fallback.visible = false
    this.fallback.add(new HemisphereLight(0xf4f7ff, 0x252d24, 1.25))
    const fill = new DirectionalLight(0xffffff, 2.2)
    fill.position.set(5, 9, 4)
    fill.castShadow = true
    this.fallback.add(fill, fill.target)
    this.scene.add(this.fallback)

    this.sky.scale.setScalar(SKY_SIZE)
    this.sky.frustumCulled = false
    this.sky.visible = false
    this.scene.add(this.sky)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    const ao = new N8AOPass(this.scene, this.camera, 1, 1)
    ao.setQualityMode('Medium')
    ao.configuration.gammaCorrection = false
    ao.configuration.aoRadius = AO_RADIUS
    ao.configuration.distanceFalloff = 1
    ao.configuration.intensity = AO_INTENSITY
    ao.configuration.halfRes = false
    ao.configuration.accumulate = false
    this.composer.addPass(ao)
    this.composer.addPass(
      new UnrealBloomPass(
        new Vector2(1, 1),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      ),
    )
    this.composer.addPass(new SMAAPass())
    this.composer.addPass(new OutputPass())

    canvas.addEventListener('pointerdown', this.handlePointerDown)
    document.addEventListener('keydown', this.handleKeyDown)
    document.addEventListener('keyup', this.handleKeyUp)

    this.resize(canvas.clientWidth || 1, canvas.clientHeight || 1)
    this.frame = requestAnimationFrame(this.animate)
  }

  show(prepared: PreparedScene): void {
    this.clear()
    this.prepared = prepared

    const root = new Group()
    root.add(prepared.visual)
    this.scene.add(root)
    this.root = root

    this.world.clear()
    const triangle = new Triangle()
    for (const collider of prepared.colliders) {
      for (let i = 0; i < collider.indices.length; i += 3) {
        readVertex(collider, i, triangle.a)
        readVertex(collider, i + 1, triangle.b)
        readVertex(collider, i + 2, triangle.c)
        this.world.addTriangle(triangle.clone())
      }
    }
    if (prepared.colliders.length > 0) this.world.build()

    this.fallback.visible = !prepared.hasLights
    this.applySky(prepared)
    this.frameScene(prepared)
    if (prepared.spawn !== undefined) {
      const player = prepared.spawn.controller
      this.eyeHeight = player.eyeHeight
      this.gravity = player.gravity
      this.fallReset = player.fallResetDistance
      this.minFloorNormalY = Math.cos(
        MathUtils.degToRad(player.maxSlopeDegrees),
      )
      const feet = new Vector3(...prepared.spawn.position)
      this.spawnCollider.set(
        feet.clone().setY(feet.y + player.radius),
        feet.clone().setY(feet.y + player.height - player.radius),
        player.radius,
      )
      this.resetPlayer()
      this.tuning = {
        walkSpeed: player.walkSpeed,
        runSpeed: player.runSpeed,
        jumpSpeed: player.jumpSpeed,
      }
    }

    this.renderer.shadowMap.needsUpdate = true
  }

  setMode(mode: ViewerMode): void {
    if (mode === this.mode) return
    if (mode === 'walk' && this.prepared?.spawn === undefined) return
    this.mode = mode
    if (mode === 'orbit') {
      if (this.walkControls.isLocked) this.walkControls.unlock()
      this.controls.enabled = true
    } else {
      this.controls.enabled = false
      this.resetPlayer()
    }
    this.events.onModeChange?.(mode)
  }

  setTuning(tuning: PlayerTuning): void {
    this.tuning = tuning
  }

  resetPlayer(): void {
    this.collider.copy(this.spawnCollider)
    this.previousStart.copy(this.collider.start)
    this.velocity.set(0, 0, 0)
    this.onFloor = true
    this.jumpQueued = false
    this.accumulator = 0
    if (this.prepared?.spawn !== undefined && this.mode === 'walk') {
      this.camera.position
        .copy(this.collider.start)
        .setY(this.collider.start.y - this.collider.radius + this.eyeHeight)
    }
  }

  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.composer.setSize(width, height)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    document.removeEventListener('keydown', this.handleKeyDown)
    document.removeEventListener('keyup', this.handleKeyUp)
    this.walkControls.removeEventListener('lock', this.handleLock)
    this.walkControls.removeEventListener('unlock', this.handleUnlock)
    this.walkControls.disconnect()
    this.controls.dispose()
    this.clear()
    this.composer.dispose()
    this.renderer.dispose()
  }

  private clear(): void {
    if (this.root !== null) {
      this.scene.remove(this.root)
      this.root = null
    }
    if (this.prepared !== null) {
      disposePreparedScene(this.prepared)
      this.prepared = null
    }
    if (this.environmentTarget !== null) {
      this.environmentTarget.dispose()
      this.environmentTarget = null
    }
    this.scene.environment = null
    this.sky.visible = false
    this.world.clear()
  }

  private applySky(prepared: PreparedScene): void {
    const sky = prepared.sky
    if (sky === undefined) {
      this.sky.visible = false
      this.scene.background = null
      return
    }

    setSkyUniform(this.sky, 'turbidity', sky.turbidity)
    setSkyUniform(this.sky, 'rayleigh', SKY_RAYLEIGH)
    setSkyUniform(this.sky, 'mieCoefficient', SKY_MIE_COEFFICIENT)
    setSkyUniform(this.sky, 'mieDirectionalG', SKY_MIE_DIRECTIONAL_G)
    setSkyUniform(this.sky, 'cloudCoverage', sky.cloudCoverage)
    // Drawn in the sky, hidden while the environment map is baked: prefiltering
    // a raw HDR disc leaves a ringing hotspot on every surface.
    setSkyUniform(this.sky, 'showSunDisc', 1)
    setSkyUniform(
      this.sky,
      'sunPosition',
      sky.sunDirection.clone().multiplyScalar(SKY_SIZE),
    )
    this.sky.visible = true

    const generator = new PMREMGenerator(this.renderer)
    const staging = new Scene()
    const source = this.sky.clone()
    source.visible = true
    setSkyUniform(source, 'showSunDisc', 0)
    staging.add(source)
    this.environmentTarget = generator.fromScene(staging)
    this.scene.environment = this.environmentTarget.texture
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY
    generator.dispose()
  }

  private frameScene(prepared: PreparedScene): void {
    const { center, radius } = prepared.bounds
    this.controls.target.copy(center)
    this.controls.minDistance = Math.max(radius * 0.002, 0.01)
    this.controls.maxDistance = Math.max(radius * 24, 25)
    this.camera.position
      .copy(center)
      .add(new Vector3(0.6, 0.45, 0.8).normalize().multiplyScalar(radius * 2.4))
    this.camera.near = Math.max(radius / 1000, 0.05)
    this.camera.far = Math.max(radius * 200, 2000)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  private readonly handlePointerDown = (): void => {
    if (this.mode === 'walk' && !this.walkControls.isLocked) {
      this.walkControls.lock()
    }
  }

  private readonly handleLock = (): void => {
    this.events.onPointerLockChange?.(true)
  }

  private readonly handleUnlock = (): void => {
    this.pressed.clear()
    this.events.onPointerLockChange?.(false)
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.walkControls.isLocked || !MOVE_KEYS.has(event.code)) return
    event.preventDefault()
    if (event.code === 'Space' && !event.repeat) this.jumpQueued = true
    this.pressed.add(event.code)
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code)
  }

  private readonly animate = (): void => {
    if (this.disposed) return
    const delta = Math.min(this.clock.getDelta(), 0.1)

    if (this.mode === 'walk' && this.walkControls.isLocked) {
      this.updateWalk(delta)
    } else if (this.mode === 'orbit') {
      this.controls.update()
    }

    this.camera.updateMatrixWorld()
    this.composer.render(delta)
    this.frame = requestAnimationFrame(this.animate)
  }

  private updateWalk(delta: number): void {
    const speed =
      this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight')
        ? (this.tuning?.runSpeed ?? 16)
        : (this.tuning?.walkSpeed ?? 10)

    const ahead =
      Number(this.pressed.has('KeyW') || this.pressed.has('ArrowUp')) -
      Number(this.pressed.has('KeyS') || this.pressed.has('ArrowDown'))
    const across =
      Number(this.pressed.has('KeyD') || this.pressed.has('ArrowRight')) -
      Number(this.pressed.has('KeyA') || this.pressed.has('ArrowLeft'))

    this.camera.getWorldDirection(this.forward)
    this.forward.y = 0
    if (this.forward.lengthSq() < COLLISION_EPSILON) this.forward.set(0, 0, -1)
    this.forward.normalize()
    this.right.crossVectors(this.forward, this.camera.up).normalize()
    this.desired
      .copy(this.forward)
      .multiplyScalar(ahead)
      .addScaledVector(this.right, across)
    if (this.desired.lengthSq() > 0) {
      this.desired.normalize().multiplyScalar(speed)
    }

    this.accumulator += delta
    while (this.accumulator >= STEP_SECONDS) {
      this.previousStart.copy(this.collider.start)
      this.step(STEP_SECONDS)
      this.accumulator -= STEP_SECONDS
    }
    this.recoverIfFallen()
    this.syncCamera(this.accumulator / STEP_SECONDS)
  }

  private step(delta: number): void {
    let wasOnFloor = this.onFloor
    if (this.jumpQueued) {
      if (wasOnFloor) {
        this.velocity.y = this.tuning?.jumpSpeed ?? 4.5
        this.onFloor = false
        wasOnFloor = false
      }
      this.jumpQueued = false
    }

    // An exponential approach rather than a fixed impulse, so the same feel
    // survives whatever rate the physics happens to be stepping at.
    const response = wasOnFloor
      ? this.desired.lengthSq() > 0
        ? GROUND_RESPONSE
        : GROUND_STOP_RESPONSE
      : AIR_CONTROL
    const control = 1 - Math.exp(-response * delta)
    this.velocity.x = MathUtils.lerp(this.velocity.x, this.desired.x, control)
    this.velocity.z = MathUtils.lerp(this.velocity.z, this.desired.z, control)

    if (wasOnFloor) this.velocity.y = 0
    else this.velocity.y -= this.gravity * delta

    this.correction.copy(this.velocity).multiplyScalar(delta)
    this.collider.translate(this.correction)

    let onFloor = this.resolveCollisions()
    if (!onFloor && wasOnFloor && this.velocity.y <= 0) onFloor = this.snap()
    this.onFloor = onFloor
    if (onFloor && this.velocity.y < 0) this.velocity.y = 0
  }

  private resolveCollisions(): boolean {
    let onFloor = false
    for (let i = 0; i < COLLISION_ITERATIONS; i++) {
      const hit = this.world.capsuleIntersect(this.collider)
      if (hit === false) break
      if (
        !Number.isFinite(hit.depth) ||
        hit.depth <= COLLISION_EPSILON ||
        hit.normal.lengthSq() <= COLLISION_EPSILON
      ) {
        break
      }
      if (hit.normal.y >= this.minFloorNormalY && this.velocity.y <= 0) {
        onFloor = true
      }
      const into = this.velocity.dot(hit.normal)
      if (into < 0) this.velocity.addScaledVector(hit.normal, -into)
      this.correction
        .copy(hit.normal)
        .multiplyScalar(hit.depth + COLLISION_SKIN)
      this.collider.translate(this.correction)
    }
    return onFloor
  }

  /** Keeps the player on stairs and ramps instead of stepping off into a fall. */
  private snap(): boolean {
    const feetY = this.collider.start.y - this.collider.radius
    this.floorRay.origin.set(
      this.collider.start.x,
      feetY + COLLISION_SKIN,
      this.collider.start.z,
    )
    this.floorRay.direction.set(0, -1, 0)
    const hit = this.world.rayIntersect(this.floorRay)
    if (
      hit === false ||
      !Number.isFinite(hit.distance) ||
      hit.distance > FLOOR_SNAP + COLLISION_SKIN
    ) {
      return false
    }
    hit.triangle.getNormal(this.floorNormal)
    if (this.floorNormal.y < this.minFloorNormalY) return false

    this.correction.set(
      0,
      MathUtils.clamp(
        hit.position.y + COLLISION_SKIN - feetY,
        -FLOOR_SNAP,
        COLLISION_SKIN,
      ),
      0,
    )
    this.collider.translate(this.correction)
    return true
  }

  private recoverIfFallen(): void {
    const floor = this.spawnCollider.start.y - this.spawnCollider.radius
    if (this.collider.end.y >= floor - this.fallReset) return
    this.resetPlayer()
  }

  /**
   * Physics runs at a fixed rate and the display does not, so the camera sits
   * between the last two steps. Without this the view judders at any refresh
   * rate that is not an exact multiple of the step.
   */
  private syncCamera(alpha: number): void {
    const feetY =
      MathUtils.lerp(this.previousStart.y, this.collider.start.y, alpha) -
      this.collider.radius
    this.camera.position.set(
      MathUtils.lerp(this.previousStart.x, this.collider.start.x, alpha),
      feetY + this.eyeHeight,
      MathUtils.lerp(this.previousStart.z, this.collider.start.z, alpha),
    )
  }
}

function setSkyUniform(sky: Sky, name: string, value: number | Vector3): void {
  const uniform = sky.material.uniforms[name]
  if (uniform !== undefined) uniform.value = value
}

function readVertex(
  collider: { vertices: Float32Array; indices: Uint32Array },
  index: number,
  target: Vector3,
): void {
  const at = (collider.indices[index] as number) * 3
  target.set(
    collider.vertices[at] as number,
    collider.vertices[at + 1] as number,
    collider.vertices[at + 2] as number,
  )
}
