'use client'

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Bounds,
  KeyboardControls,
  OrbitControls,
  useGLTF,
  useKeyboardControls,
  useProgress,
} from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ConvexHullCollider,
  Physics,
  RigidBody,
  TrimeshCollider,
} from '@react-three/rapier'
import { Ecctrl, type EcctrlHandle } from 'ecctrl'
import {
  AgXToneMapping,
  DirectionalLight,
  PCFShadowMap,
  Quaternion,
  Scene,
  Sphere,
  Vector3,
} from 'three'
import { SkyMesh } from 'three/addons/objects/SkyMesh.js'
import { PMREMGenerator, WebGPURenderer, type Renderer } from 'three/webgpu'
import {
  castShadows,
  disposePreparedScene,
  prepareScene,
  type ColliderDescription,
  type SkyDescription,
} from './prepare'
import type {
  PlayerTuning,
  SceneViewerInfo,
  SceneViewerProps,
  SpawnDescription,
  ViewerMode,
} from './types'

/** Wide enough to enclose any scene the harness builds, inside the camera's far plane. */
const SKY_SIZE = 2000
/**
 * AgX holds a highlight far longer than ACES before it gives up and goes white,
 * which is the whole problem with a sky: its brightest parts are hundreds of
 * times its darkest, and ACES flattens everything above the middle of that
 * range into paper. Exposure sits below 1 for the same reason.
 */
const EXPOSURE = 0.8
/**
 * The sky is a light source of its own, and these scenes already carry an
 * authored sun. Left near 1 it doubles the scene's illumination from every
 * direction at once and washes it out; this is the share that reads as skylight
 * beside a sun rather than replacing it.
 */
const ENVIRONMENT_INTENSITY = 0.08
/** Thin haze, so blue survives down toward the horizon instead of whitening. */
const SKY_MIE_COEFFICIENT = 0.003
const SKY_MIE_DIRECTIONAL_G = 0.82
const SKY_RAYLEIGH = 1.8
/**
 * Scroll felt harsh at the default and sluggish once slowed down. The fix is
 * not speed: damping carries the motion on after the wheel stops, so the same
 * step arrives smoothly.
 */
const ORBIT_DAMPING = 0.075
const PLAYER_FLOAT_HEIGHT = 0.2
/**
 * Ecctrl's spring, damping and acceleration defaults are tuned around a capsule
 * this size — 1.2 m tall. A human-scale one is over twice the volume, so at the
 * default density it hangs off the same spring at half the stiffness and the
 * ride sags and wallows. Matching its mass instead of retuning every constant
 * keeps the rest of Ecctrl's defaults meaningful.
 */
const ECCTRL_TUNED_CAPSULE = { halfHeight: 0.3, radius: 0.3 }
/**
 * Ecctrl's two `DeltaTime` props are not times. Each is clamped to 0..1 and
 * scales an impulse of `mass * coefficient * value`, so it is the fraction of
 * the gap to target speed closed each frame.
 *
 * These are the response rates from the navigation contract of a viewer whose
 * movement reads well — 12 per second toward speed, 18 per second back to a
 * stop — converted through `1 - e^(-rate / 60)`. Stopping reaches a twentieth
 * of walking pace in about a sixth of a second: crisp without the dead snap of
 * cancelling all velocity in a single frame.
 */
const ACCELERATE = 0.181
const BRAKE = 0.259
/**
 * Both impulses are also scaled by `clamp((groundFriction + slideGripFactor) / 2, 0, 1)`.
 * Saturating that clamp keeps stopping and starting identical on every surface
 * rather than varying with whatever friction a collider happens to carry.
 */
const GRIP = 2
type MovementKey =
  'forward' | 'backward' | 'leftward' | 'rightward' | 'jump' | 'run'
const KEYBOARD_MAP: { name: MovementKey; keys: string[] }[] = [
  { name: 'forward', keys: ['ArrowUp', 'KeyW'] },
  { name: 'backward', keys: ['ArrowDown', 'KeyS'] },
  { name: 'leftward', keys: ['ArrowLeft', 'KeyA'] },
  { name: 'rightward', keys: ['ArrowRight', 'KeyD'] },
  { name: 'jump', keys: ['Space'] },
  { name: 'run', keys: ['ShiftLeft', 'ShiftRight'] },
]

/**
 * `init()` settles only once a backend is live, and three falls back to its own
 * WebGL2 backend inside that call whenever WebGPU cannot be reached — a missing
 * `navigator.gpu`, a refused adapter, or a device that never arrives. Returning
 * the promise is what keeps the canvas from being handed a renderer that is
 * still negotiating. Colour space and tone mapping are left to R3F, which sets
 * sRGB and ACES Filmic on any renderer it configures.
 */
async function createRenderer(props: {
  canvas: HTMLCanvasElement | EventTarget
}): Promise<WebGPURenderer> {
  const renderer = new WebGPURenderer({
    // R3F widens the canvas to cover `createRoot` on an offscreen one, and
    // declares its own `OffscreenCanvas` that three does not accept. The web
    // `<Canvas>` this viewer renders always builds a real element.
    canvas: props.canvas as HTMLCanvasElement,
    antialias: true,
    powerPreference: 'high-performance',
  })
  await renderer.init()
  return renderer
}

export function SceneViewer({
  src,
  initialMode = 'orbit',
  className,
  style,
  onLoad,
  onError,
  onModeChange,
}: SceneViewerProps) {
  const [mode, setMode] = useState<ViewerMode>(initialMode)
  const [info, setInfo] = useState<SceneViewerInfo>()
  const [debug, setDebug] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const [pointerLocked, setPointerLocked] = useState(false)
  const [tuning, setTuning] = useState<PlayerTuning>()

  useEffect(() => {
    setInfo(undefined)
    setPointerLocked(false)
    setTuning(undefined)
  }, [src])

  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  useEffect(() => {
    if (mode === 'walk' && info !== undefined && !info.hasSpawn) {
      setMode('orbit')
    }
  }, [info, mode])

  useEffect(() => {
    onModeChange?.(mode)
  }, [mode, onModeChange])

  const loaded = useCallback(
    (next: SceneViewerInfo) => {
      setInfo(next)
      if (next.controller !== undefined) {
        const { walkSpeed, runSpeed, jumpSpeed } = next.controller
        setTuning({ walkSpeed, runSpeed, jumpSpeed })
      }
      onLoad?.(next)
    },
    [onLoad],
  )

  const rootStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: 360,
    overflow: 'hidden',
    background: '#0b0d10',
    color: '#f4f4f5',
    ...style,
  } satisfies React.CSSProperties

  return (
    <div className={className} style={rootStyle}>
      <ViewerErrorBoundary
        key={src}
        onError={onError}
        fallback={(error) => <ErrorOverlay error={error} />}
      >
        <Canvas
          shadows
          dpr={[1, 1.5]}
          camera={{ position: [5, 3.5, 7], fov: 50, near: 0.05, far: 4000 }}
          gl={createRenderer}
        >
          <color attach="background" args={['#0b0d10']} />
          <Suspense fallback={null}>
            <LoadedScene
              src={src}
              mode={mode}
              debug={debug}
              resetToken={resetToken}
              tuning={tuning}
              onLoaded={loaded}
              onPointerLockChange={setPointerLocked}
            />
          </Suspense>
        </Canvas>
      </ViewerErrorBoundary>

      <LoadingOverlay />
      <div style={toolbarStyle}>
        <button
          type="button"
          style={buttonStyle(mode === 'orbit')}
          onClick={() => setMode('orbit')}
        >
          Orbit
        </button>
        <button
          type="button"
          style={buttonStyle(mode === 'walk')}
          disabled={info !== undefined && !info.hasSpawn}
          onClick={() => setMode('walk')}
        >
          Walk
        </button>
        <button
          type="button"
          style={buttonStyle(debug)}
          onClick={() => setDebug((value) => !value)}
        >
          Physics
        </button>
        {info?.hasSpawn === true ? (
          <button
            type="button"
            style={buttonStyle(false)}
            onClick={() => setResetToken((value) => value + 1)}
          >
            Reset
          </button>
        ) : null}
      </div>

      {mode === 'walk' && tuning !== undefined ? (
        <div style={panelStyle}>
          <Slider
            label="Walk"
            value={tuning.walkSpeed}
            min={1}
            max={20}
            onChange={(walkSpeed) =>
              setTuning({
                ...tuning,
                walkSpeed,
                runSpeed: Math.max(tuning.runSpeed, walkSpeed),
              })
            }
          />
          <Slider
            label="Run"
            value={tuning.runSpeed}
            min={tuning.walkSpeed}
            max={30}
            onChange={(runSpeed) => setTuning({ ...tuning, runSpeed })}
          />
          <Slider
            label="Jump"
            value={tuning.jumpSpeed}
            min={0}
            max={20}
            onChange={(jumpSpeed) => setTuning({ ...tuning, jumpSpeed })}
          />
        </div>
      ) : null}

      <div style={helpStyle}>
        {mode === 'walk'
          ? pointerLocked
            ? 'WASD move · Shift run · Space jump · Esc release'
            : 'Click the scene to capture the mouse'
          : 'Drag to orbit · Scroll to zoom'}
      </div>
    </div>
  )
}

function LoadedScene({
  src,
  mode,
  debug,
  resetToken,
  tuning,
  onLoaded,
  onPointerLockChange,
}: {
  src: string
  mode: ViewerMode
  debug: boolean
  resetToken: number
  tuning: PlayerTuning | undefined
  onLoaded: (info: SceneViewerInfo) => void
  onPointerLockChange: (locked: boolean) => void
}) {
  const gltf = useGLTF(src)
  const prepared = useMemo(() => prepareScene(gltf.scene), [gltf.scene])

  useEffect(() => {
    onLoaded(prepared.info)
    return () => {
      disposePreparedScene(prepared)
      useGLTF.clear(src)
    }
  }, [onLoaded, prepared, src])

  return (
    <>
      <RendererSettings key={src} />
      {prepared.sky !== undefined ? (
        <Sky sky={prepared.sky} center={prepared.bounds.center} />
      ) : null}
      {!prepared.hasLights ? <FallbackLights bounds={prepared.bounds} /> : null}
      <OrbitControls
        makeDefault
        enabled={mode === 'orbit'}
        enableDamping
        dampingFactor={ORBIT_DAMPING}
        minDistance={Math.max(prepared.bounds.radius * 0.002, 0.01)}
        maxDistance={Math.max(prepared.bounds.radius * 24, 25)}
      />
      <Bounds fit={mode === 'orbit'} margin={1.25}>
        <primitive object={prepared.visual} dispose={null} />
      </Bounds>
      <KeyboardControls map={KEYBOARD_MAP}>
        <Physics
          key={src}
          debug={debug}
          gravity={[0, -(prepared.spawn?.controller.gravity ?? 9.81), 0]}
        >
          <SceneColliders colliders={prepared.colliders} />
          {prepared.spawn && tuning !== undefined ? (
            <Player
              active={mode === 'walk'}
              debug={debug}
              resetToken={resetToken}
              spawn={prepared.spawn}
              tuning={tuning}
              onPointerLockChange={onPointerLockChange}
            />
          ) : null}
        </Physics>
      </KeyboardControls>
    </>
  )
}

function SceneColliders({ colliders }: { colliders: ColliderDescription[] }) {
  return (
    <RigidBody type="fixed" colliders={false}>
      {colliders.map((collider) =>
        collider.kind === 'hiddenConvex' ? (
          <ConvexHullCollider
            key={collider.name}
            name={collider.name}
            args={[collider.vertices]}
          />
        ) : (
          <TrimeshCollider
            key={collider.name}
            name={collider.name}
            args={[collider.vertices, collider.indices]}
          />
        ),
      )}
    </RigidBody>
  )
}

function Player({
  active,
  debug,
  resetToken,
  spawn,
  tuning,
  onPointerLockChange,
}: {
  active: boolean
  debug: boolean
  resetToken: number
  spawn: SpawnDescription
  tuning: PlayerTuning
  onPointerLockChange: (locked: boolean) => void
}) {
  const controller = useRef<EcctrlHandle>(null)
  const [locked, setLocked] = useState(false)
  const config = spawn.controller
  const capsuleHalfHeight = (config.height - config.radius * 2) / 2
  const position = playerBodyPosition(spawn)
  const density =
    capsuleVolume(
      ECCTRL_TUNED_CAPSULE.halfHeight,
      ECCTRL_TUNED_CAPSULE.radius,
    ) / capsuleVolume(capsuleHalfHeight, config.radius)

  useEffect(() => {
    onPointerLockChange(locked)
  }, [locked, onPointerLockChange])

  return (
    <>
      <Movement controller={controller} enabled={active && locked} />
      <Ecctrl
        ref={controller}
        position={position}
        // Enabled by the mode alone. Ecctrl short-circuits its whole frame when
        // disabled, so `currPos` would never leave the origin and the camera
        // this drives would sit inside the building until the pointer locked.
        // Pointer lock gates input and mouse look, not the body.
        enable={active}
        capsuleHalfHeight={capsuleHalfHeight}
        capsuleRadius={config.radius}
        density={density}
        maxWalkVel={tuning.walkSpeed}
        maxRunVel={tuning.runSpeed}
        jumpVel={tuning.jumpSpeed}
        accDeltaTime={ACCELERATE}
        decDeltaTime={BRAKE}
        slideGripFactor={GRIP}
        slopeMaxAngle={(config.maxSlopeDegrees * Math.PI) / 180}
        floatHeight={PLAYER_FLOAT_HEIGHT}
        enableToggleRun={false}
        ccd
      />
      <FirstPersonCamera
        active={active}
        controller={controller}
        resetToken={resetToken}
        spawn={spawn}
        onLockChange={setLocked}
      />
      {debug ? <SpawnDebug spawn={spawn} /> : null}
    </>
  )
}

const STILL = {
  forward: false,
  backward: false,
  leftward: false,
  rightward: false,
  run: false,
  jump: false,
}

/**
 * Ecctrl 2 listens for no keys of its own — its only input is `setMovement`,
 * which the host is expected to call every frame. `KeyboardControls` supplies
 * the state; without this the map is wired to nothing and the player is a
 * statue.
 */
function Movement({
  controller,
  enabled,
}: {
  controller: React.RefObject<EcctrlHandle | null>
  enabled: boolean
}) {
  const [, getKeys] = useKeyboardControls<MovementKey>()
  const moving = useRef(false)

  useFrame(() => {
    const handle = controller.current
    if (handle === null) return
    if (!enabled) {
      if (moving.current) {
        handle.setMovement(STILL)
        moving.current = false
      }
      return
    }
    const keys = getKeys()
    handle.setMovement({
      forward: keys.forward,
      backward: keys.backward,
      leftward: keys.leftward,
      rightward: keys.rightward,
      run: keys.run,
      jump: keys.jump,
    })
    moving.current = true
  })

  return null
}

function FirstPersonCamera({
  active,
  controller,
  resetToken,
  spawn,
  onLockChange,
}: {
  active: boolean
  controller: React.RefObject<EcctrlHandle | null>
  resetToken: number
  spawn: SpawnDescription
  onLockChange: (locked: boolean) => void
}) {
  const { camera, gl } = useThree()
  const spawnYaw = useMemo(() => yawFromSpawn(spawn), [spawn])
  const yaw = useRef(spawnYaw)
  const pitch = useRef(0)
  const handledReset = useRef(resetToken)

  useEffect(() => {
    const element = gl.domElement
    const lock = () => {
      if (active && document.pointerLockElement === null) {
        void element.requestPointerLock()
      }
    }
    const move = (event: MouseEvent) => {
      if (!active || document.pointerLockElement !== element) return
      yaw.current -= event.movementX * 0.002
      pitch.current = Math.max(
        -Math.PI / 2 + 0.02,
        Math.min(Math.PI / 2 - 0.02, pitch.current - event.movementY * 0.002),
      )
    }
    const changed = () => {
      onLockChange(active && document.pointerLockElement === element)
    }

    element.addEventListener('pointerdown', lock)
    document.addEventListener('mousemove', move)
    document.addEventListener('pointerlockchange', changed)
    return () => {
      element.removeEventListener('pointerdown', lock)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('pointerlockchange', changed)
    }
  }, [active, gl, onLockChange])

  useEffect(() => {
    if (!active && document.pointerLockElement === gl.domElement) {
      document.exitPointerLock()
    }
  }, [active, gl])

  useFrame(() => {
    const handle = controller.current
    if (handle === null) return

    if (handledReset.current !== resetToken) {
      resetPlayer(handle, spawn)
      yaw.current = spawnYaw
      pitch.current = 0
      handledReset.current = resetToken
    }

    if (
      handle.currPos.y <
      spawn.position[1] - spawn.controller.fallResetDistance
    ) {
      resetPlayer(handle, spawn)
      yaw.current = spawnYaw
      pitch.current = 0
    }

    if (!active) return
    const feetY =
      handle.currPos.y - spawn.controller.height / 2 - PLAYER_FLOAT_HEIGHT
    camera.position.set(
      handle.currPos.x,
      feetY + spawn.controller.eyeHeight,
      handle.currPos.z,
    )
    camera.rotation.set(pitch.current, yaw.current, 0, 'YXZ')
    camera.updateMatrixWorld()
  })

  return null
}

function SpawnDebug({ spawn }: { spawn: SpawnDescription }) {
  const halfHeight = (spawn.controller.height - spawn.controller.radius * 2) / 2
  return (
    <group position={spawn.position} quaternion={spawn.quaternion}>
      <mesh
        position={[0, spawn.controller.height / 2 + PLAYER_FLOAT_HEIGHT, 0]}
      >
        <capsuleGeometry
          args={[spawn.controller.radius, halfHeight * 2, 8, 16]}
        />
        <meshBasicMaterial color="#38bdf8" wireframe />
      </mesh>
      <mesh position={[0, 0.08, -0.55]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.09, 0.35, 12]} />
        <meshBasicMaterial color="#fbbf24" />
      </mesh>
    </group>
  )
}

/**
 * The sky is drawn from the scene's own sun rather than authored as geometry:
 * glTF has nowhere to carry one, but a daylight model needs little more than
 * the direction light arrives from, which the export already states. The same
 * sky becomes the environment map, which is what stops a face turned away from
 * every lamp going to black and gives a polished surface something to mirror.
 */
/**
 * Every mesh here is fixed and the player casts nothing, so re-rendering the
 * shadow map each frame redraws an identical image. Rendering it once and
 * holding it is the difference between a scene that runs and one that crawls.
 */
function tuneSky(mesh: SkyMesh, sky: SkyDescription): void {
  mesh.turbidity.value = sky.turbidity
  mesh.rayleigh.value = SKY_RAYLEIGH
  mesh.mieCoefficient.value = SKY_MIE_COEFFICIENT
  mesh.mieDirectionalG.value = SKY_MIE_DIRECTIONAL_G
  mesh.cloudCoverage.value = sky.cloudCoverage
  mesh.sunPosition.value.copy(sky.sunDirection)
}

function RendererSettings() {
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    // R3F picks ACES at exposure 1 while configuring the canvas, so this has to
    // run after it rather than in the renderer factory.
    gl.toneMapping = AgXToneMapping
    gl.toneMappingExposure = EXPOSURE
    gl.shadowMap.type = PCFShadowMap
    gl.shadowMap.autoUpdate = false
    gl.shadowMap.needsUpdate = true
    return () => {
      gl.shadowMap.autoUpdate = true
    }
  }, [gl])

  return null
}

function Sky({ sky, center }: { sky: SkyDescription; center: Vector3 }) {
  const { gl, scene } = useThree()

  const mesh = useMemo(() => {
    const value = new SkyMesh()
    value.scale.setScalar(SKY_SIZE)
    // Only what is drawn is exposed. The copy the environment map is built from
    // stays at the model's own scale, which is what `skyEnvironmentIntensity`
    // divides out.
    return value
  }, [])

  useEffect(() => {
    mesh.position.copy(center)
    tuneSky(mesh, sky)
    mesh.showSunDisc.value = true
  }, [mesh, sky, center])

  useEffect(() => {
    // R3F still types the renderer as WebGL; this one negotiated a backend in
    // the factory above.
    const generator = new PMREMGenerator(gl as unknown as Renderer)
    const staging = new Scene()
    const source = new SkyMesh()
    source.scale.setScalar(SKY_SIZE)
    tuneSky(source, sky)
    // Prefiltering turns the disc into a ringing hotspot, and the sun is
    // already in the scene as a light.
    source.showSunDisc.value = false
    staging.add(source)

    const target = generator.fromScene(staging)
    scene.environment = target.texture
    scene.environmentIntensity = ENVIRONMENT_INTENSITY
    generator.dispose()
    source.geometry.dispose()
    source.material.dispose()

    return () => {
      scene.environment = null
      scene.environmentIntensity = 1
      target.dispose()
    }
  }, [gl, scene, sky])

  useEffect(() => {
    return () => {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }, [mesh])

  return <primitive object={mesh} />
}

/**
 * Only reached when the GLB carries no light of its own, which now means the
 * scene was authored without one rather than that Blender dropped it.
 */
function FallbackLights({ bounds }: { bounds: Sphere }) {
  const light = useRef<DirectionalLight>(null)

  useEffect(() => {
    if (light.current !== null)
      castShadows(light.current, bounds, light.current.parent ?? light.current)
  }, [bounds])

  return (
    <>
      <hemisphereLight args={['#f4f7ff', '#252d24', 1.25]} />
      <directionalLight ref={light} intensity={2.2} rotation={[-0.9, 0.6, 0]} />
    </>
  )
}

function capsuleVolume(halfHeight: number, radius: number): number {
  return (
    Math.PI * radius ** 2 * halfHeight * 2 + (4 / 3) * Math.PI * radius ** 3
  )
}

function playerBodyPosition(spawn: SpawnDescription): [number, number, number] {
  return [
    spawn.position[0],
    spawn.position[1] + spawn.controller.height / 2 + PLAYER_FLOAT_HEIGHT,
    spawn.position[2],
  ]
}

function resetPlayer(handle: EcctrlHandle, spawn: SpawnDescription): void {
  const [x, y, z] = playerBodyPosition(spawn)
  const [qx, qy, qz, qw] = spawn.quaternion
  handle.body.setTranslation({ x, y, z }, true)
  handle.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true)
  handle.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
  handle.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
}

function yawFromSpawn(spawn: SpawnDescription): number {
  const quaternion = new Quaternion(...spawn.quaternion)
  const forward = new Vector3(0, 0, -1).applyQuaternion(quaternion)
  return Math.atan2(-forward.x, -forward.z)
}

function LoadingOverlay() {
  const { active, progress } = useProgress()
  if (!active) return null
  return (
    <div style={messageStyle}>
      Loading scene {Math.max(0, Math.min(100, Math.round(progress)))}%
    </div>
  )
}

function ErrorOverlay({ error }: { error: Error }) {
  return <div style={messageStyle}>Could not load scene: {error.message}</div>
}

class ViewerErrorBoundary extends Component<
  {
    children: React.ReactNode
    fallback: (error: Error) => React.ReactNode
    onError?: (error: Error) => void
  },
  { error?: Error }
> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error)
  }

  render() {
    return this.state.error === undefined
      ? this.props.children
      : this.props.fallback(this.state.error)
  }
}

const toolbarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  left: 16,
  display: 'flex',
  gap: 8,
  padding: 6,
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 10,
  background: 'rgba(12,14,18,0.86)',
  backdropFilter: 'blur(12px)',
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label style={sliderStyle}>
      <span style={{ width: 34 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: 96, accentColor: '#f4f4f5' }}
      />
      <span style={{ width: 42, textAlign: 'right' }}>{value.toFixed(1)}</span>
    </label>
  )
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 66,
  left: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 10,
  background: 'rgba(12,14,18,0.86)',
  backdropFilter: 'blur(12px)',
  color: '#d4d4d8',
  font: '11px/1 system-ui, sans-serif',
}

const sliderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
}

const helpStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '7px 10px',
  borderRadius: 8,
  background: 'rgba(12,14,18,0.82)',
  color: '#d4d4d8',
  font: '12px/1.3 system-ui, sans-serif',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
}

const messageStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  color: '#e4e4e7',
  background: '#0b0d10',
  font: '14px/1.5 system-ui, sans-serif',
  textAlign: 'center',
}

function buttonStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 62,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 7,
    padding: '7px 10px',
    background: active ? '#f4f4f5' : 'transparent',
    color: active ? '#18181b' : '#e4e4e7',
    font: '600 12px/1 system-ui, sans-serif',
    cursor: 'pointer',
  }
}
