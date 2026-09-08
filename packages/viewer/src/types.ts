import type { PlayerControllerConfig, SceneKind } from '@repo/scene-contract'

export type ViewerMode = 'orbit' | 'walk'

export interface SceneViewerInfo {
  kind?: SceneKind
  contractVersion?: number
  colliderCount: number
  hasSpawn: boolean
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
