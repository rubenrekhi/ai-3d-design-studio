'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { SceneManager } from './SceneManager'
import { prepareScene } from './prepare'
import type {
  PlayerTuning,
  SceneViewerInfo,
  SceneViewerProps,
  ViewerMode,
} from './types'

export function SceneViewer({
  src,
  initialMode = 'orbit',
  className,
  style,
  onLoad,
  onError,
  onModeChange,
}: SceneViewerProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const manager = useRef<SceneManager>(null)
  const [mode, setMode] = useState<ViewerMode>(initialMode)
  const [info, setInfo] = useState<SceneViewerInfo>()
  const [tuning, setTuning] = useState<PlayerTuning>()
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState<Error>()
  const [progress, setProgress] = useState<number>()

  const report = useRef({ onLoad, onError, onModeChange })
  report.current = { onLoad, onError, onModeChange }

  useEffect(() => {
    const element = canvas.current
    if (element === null) return

    const created = new SceneManager(element, {
      onModeChange: (next) => {
        setMode(next)
        report.current.onModeChange?.(next)
      },
      onPointerLockChange: setLocked,
    })
    manager.current = created

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry !== undefined) {
        created.resize(entry.contentRect.width, entry.contentRect.height)
      }
    })
    observer.observe(element)

    return () => {
      observer.disconnect()
      created.dispose()
      manager.current = null
    }
  }, [])

  useEffect(() => {
    const created = manager.current
    if (created === null) return
    let cancelled = false

    setInfo(undefined)
    setError(undefined)
    setProgress(0)

    new GLTFLoader().load(
      src,
      (gltf) => {
        if (cancelled) return
        try {
          const prepared = prepareScene(gltf.scene)
          created.show(prepared)
          setProgress(undefined)
          setInfo(prepared.info)
          if (prepared.spawn !== undefined) {
            const { walkSpeed, runSpeed, jumpSpeed } = prepared.spawn.controller
            setTuning({ walkSpeed, runSpeed, jumpSpeed })
          }
          report.current.onLoad?.(prepared.info)
        } catch (cause) {
          const failure =
            cause instanceof Error ? cause : new Error(String(cause))
          setError(failure)
          setProgress(undefined)
          report.current.onError?.(failure)
        }
      },
      (event) => {
        if (!cancelled && event.total > 0) {
          setProgress((event.loaded / event.total) * 100)
        }
      },
      (cause) => {
        if (cancelled) return
        const failure =
          cause instanceof Error ? cause : new Error(String(cause))
        setError(failure)
        setProgress(undefined)
        report.current.onError?.(failure)
      },
    )

    return () => {
      cancelled = true
    }
  }, [src])

  useEffect(() => {
    manager.current?.setMode(initialMode)
  }, [initialMode])

  useEffect(() => {
    if (tuning !== undefined) manager.current?.setTuning(tuning)
  }, [tuning])

  const choose = useCallback((next: ViewerMode) => {
    manager.current?.setMode(next)
  }, [])

  const walkable = info?.hasSpawn === true

  return (
    <div className={className} style={{ ...rootStyle, ...style }}>
      <canvas ref={canvas} style={canvasStyle} />

      {error !== undefined ? (
        <div style={messageStyle}>Could not load scene: {error.message}</div>
      ) : null}
      {progress !== undefined && error === undefined ? (
        <div style={messageStyle}>Loading scene {Math.round(progress)}%</div>
      ) : null}

      <div style={toolbarStyle}>
        <button
          type="button"
          style={buttonStyle(mode === 'orbit')}
          onClick={() => choose('orbit')}
        >
          Orbit
        </button>
        <button
          type="button"
          style={buttonStyle(mode === 'walk')}
          disabled={!walkable}
          onClick={() => choose('walk')}
        >
          Walk
        </button>
        {walkable ? (
          <button
            type="button"
            style={buttonStyle(false)}
            onClick={() => manager.current?.resetPlayer()}
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
            max={30}
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
            max={50}
            onChange={(runSpeed) => setTuning({ ...tuning, runSpeed })}
          />
          <Slider
            label="Jump"
            value={tuning.jumpSpeed}
            min={0}
            max={12}
            onChange={(jumpSpeed) => setTuning({ ...tuning, jumpSpeed })}
          />
        </div>
      ) : null}

      <div style={helpStyle}>
        {mode === 'walk'
          ? locked
            ? 'WASD move · Shift run · Space jump · Esc release'
            : 'Click the scene to capture the mouse'
          : 'Drag to orbit · Scroll to zoom'}
      </div>
    </div>
  )
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

const rootStyle: React.CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: 360,
  overflow: 'hidden',
  background: '#0b0d10',
  color: '#f4f4f5',
}

const canvasStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  height: '100%',
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
  pointerEvents: 'none',
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
