import { useEffect, useMemo, useState } from 'react'
import { SceneViewer } from '@repo/viewer'

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const [revision, setRevision] = useState(query.get('build') ?? 'initial')
  // `/render` serves the workspace's own build at /scene.glb and always sets
  // live=1, so that default belongs to it. Opened by hand there is no scene to
  // assume, and inventing one would show a room nobody asked for.
  const source =
    query.get('scene') ?? (query.get('live') === '1' ? '/scene.glb' : undefined)

  useEffect(() => {
    if (query.get('live') !== '1') return
    const events = new EventSource('/events')
    events.addEventListener('reload', (event) => {
      setRevision((event as MessageEvent<string>).data)
    })
    return () => events.close()
  }, [query])

  if (source === undefined) return <NoScene />

  const separator = source.includes('?') ? '&' : '?'
  const src = `${source}${separator}build=${encodeURIComponent(revision)}`
  return <SceneViewer src={src} initialMode="walk" />
}

function NoScene() {
  return (
    <main className="no-scene">
      <h1>No scene</h1>
      <p>
        Run <code>/render</code> in the agent to open the scene you are
        building, or name one yourself:
      </p>
      <code>?scene=/fixture/scene.glb</code>
    </main>
  )
}
