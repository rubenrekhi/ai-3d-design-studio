import { SceneViewer } from '@repo/viewer'

export function App() {
  const query = new URLSearchParams(window.location.search)
  const src = query.get('scene') ?? '/scene.glb'
  return <SceneViewer src={src} initialMode="walk" />
}
