declare module 'n8ao' {
  import type { Camera, Scene } from 'three'
  import type { Pass } from 'three/addons/postprocessing/Pass.js'

  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number)
    configuration: {
      aoRadius: number
      distanceFalloff: number
      intensity: number
      gammaCorrection: boolean
      halfRes: boolean
      accumulate: boolean
    }
    setQualityMode(
      mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra',
    ): void
    setSize(width: number, height: number): void
    dispose(): void
  }
}
