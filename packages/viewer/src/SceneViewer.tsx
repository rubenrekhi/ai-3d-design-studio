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
import { Quaternion, Vector3 } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import {
  disposePreparedScene,
  prepareScene,
  type ColliderDescription,
} from './prepare'
import type {
  SceneViewerInfo,
  SceneViewerProps,
  SpawnDescription,
  ViewerMode,
} from './types'

const PLAYER_FLOAT_HEIGHT = 0.15
const KEYBOARD_MAP = [
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

  useEffect(() => {
    setInfo(undefined)
    setPointerLocked(false)
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
          dpr={[1, 2]}
          camera={{ position: [5, 3.5, 7], fov: 50, near: 0.05 }}
          gl={createRenderer}
        >
          <color attach="background" args={['#0b0d10']} />
          <Suspense fallback={null}>
            <LoadedScene
              src={src}
              mode={mode}
              debug={debug}
              resetToken={resetToken}
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
  onLoaded,
  onPointerLockChange,
}: {
  src: string
  mode: ViewerMode
  debug: boolean
  resetToken: number
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
      {!prepared.hasLights ? <FallbackLights /> : null}
      <OrbitControls makeDefault enabled={mode === 'orbit'} />
      <Bounds fit={mode === 'orbit'} clip margin={1.25}>
        <primitive object={prepared.visual} dispose={null} />
      </Bounds>
      <KeyboardControls map={KEYBOARD_MAP}>
        <Physics
          key={src}
          debug={debug}
          gravity={[0, -(prepared.spawn?.controller.gravity ?? 9.81), 0]}
        >
          <SceneColliders colliders={prepared.colliders} />
          {prepared.spawn ? (
            <Player
              active={mode === 'walk'}
              debug={debug}
              resetToken={resetToken}
              spawn={prepared.spawn}
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
  onPointerLockChange,
}: {
  active: boolean
  debug: boolean
  resetToken: number
  spawn: SpawnDescription
  onPointerLockChange: (locked: boolean) => void
}) {
  const controller = useRef<EcctrlHandle>(null)
  const [locked, setLocked] = useState(false)
  const config = spawn.controller
  const capsuleHalfHeight = (config.height - config.radius * 2) / 2
  const position = playerBodyPosition(spawn)

  useEffect(() => {
    onPointerLockChange(locked)
  }, [locked, onPointerLockChange])

  useEffect(() => {
    if (!active || locked) return
    controller.current?.setMovement({
      forward: false,
      backward: false,
      leftward: false,
      rightward: false,
      run: false,
      jump: false,
    })
  }, [active, locked])

  return (
    <>
      <Ecctrl
        ref={controller}
        position={position}
        enable={active && locked}
        capsuleHalfHeight={capsuleHalfHeight}
        capsuleRadius={config.radius}
        maxWalkVel={config.walkSpeed}
        maxRunVel={config.runSpeed}
        jumpVel={config.jumpSpeed}
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

function FallbackLights() {
  return (
    <>
      <hemisphereLight args={['#f4f7ff', '#252d24', 1.25]} />
      <directionalLight
        castShadow
        position={[5, 9, 4]}
        intensity={2.2}
        shadow-mapSize={[2048, 2048]}
      />
    </>
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
