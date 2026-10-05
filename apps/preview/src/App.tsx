import { useEffect, useMemo, useState } from 'react'
import { SceneViewer } from '@repo/viewer'

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const [revision, setRevision] = useState(query.get('build') ?? 'initial')
  const source = query.get('scene') ?? '/scene.glb'
  const src = `${source}${source.includes('?') ? '&' : '?'}build=${encodeURIComponent(revision)}`

  useEffect(() => {
    if (query.get('live') !== '1') return
    const events = new EventSource('/events')
    events.addEventListener('reload', (event) => {
      setRevision((event as MessageEvent<string>).data)
    })
    return () => events.close()
  }, [query])

  return <SceneViewer src={src} initialMode="walk" />
}
