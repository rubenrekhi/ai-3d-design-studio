import type { PlayerControllerConfig, SceneKind } from '@repo/scene-contract'

export type ViewerMode = 'orbit' | 'walk'

export interface SceneViewerInfo {
  kind?: SceneKind
  contractVersion?: number
  colliderCount: number
  hasSpawn: boolean
  /** The scene's authored controller, if it declared a spawn. */
  controller?: PlayerControllerConfig
}

/** Viewer-side overrides of the authored controller. Nothing is persisted. */
export interface PlayerTuning {
  walkSpeed: number
  runSpeed: number
  jumpSpeed: number
}

export interface SceneViewerProps {
  src: string
  initialMode?: ViewerMode
  className?: string
  style?: React.CSSProperties
  onLoad?: (info: SceneViewerInfo) => void
  onError?: (error: Error) => void
  onModeChange?: (mode: ViewerMode) => void
}

export interface SpawnDescription {
  position: [number, number, number]
  quaternion: [number, number, number, number]
  controller: PlayerControllerConfig
}
