'use client'

import type { SceneViewerInfo } from '@repo/viewer'
import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { SceneSource } from './scene-sources'

const SceneViewer = dynamic(
  () => import('@repo/viewer').then((module) => module.SceneViewer),
  {
    ssr: false,
    loading: () => (
      <div className="viewer-message" role="status">
        <span className="viewer-spinner" aria-hidden="true" />
        Loading viewer
      </div>
    ),
  },
)

export function SceneWorkspace({ sources }: { sources: SceneSource[] }) {
  const [selectedId, setSelectedId] = useState<string>()
  const [loadState, setLoadState] = useState<{
    url: string
    info?: SceneViewerInfo
    error?: string
  }>()

  const source =
    sources.find((candidate) => candidate.id === selectedId) ?? sources[0]
  const loaded = loadState?.url === source?.url ? loadState : undefined

  return (
    <section className="workspace-panel">
      <div className="workspace-toolbar">
        <div>
          <p className="eyebrow">Scene preview</p>
          <h1>{source?.label ?? 'No build yet'}</h1>
        </div>

        {sources.length > 1 ? (
          <label className="source-picker">
            <span>Build</span>
            <select
              value={source?.id}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {sources.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="viewer-frame">
        {source === undefined ? (
          <EmptyViewer />
        ) : (
          <SceneViewer
            key={source.url}
            src={source.url}
            className="scene-viewer"
            onLoad={(info) => setLoadState({ url: source.url, info })}
            onError={(error) =>
              setLoadState({ url: source.url, error: error.message })
            }
          />
        )}
      </div>

      <footer className="scene-status" aria-live="polite">
        <StatusDot state={loaded?.error === undefined ? 'ready' : 'error'} />
        <span className="scene-status-label">
          {loaded?.error ?? statusText(source, loaded?.info)}
        </span>
        {loaded?.info === undefined ? null : (
          <span className="scene-stats">
            {loaded.info.colliderCount} collider
            {loaded.info.colliderCount === 1 ? '' : 's'}
            <span aria-hidden="true">·</span>
            {loaded.info.hasSpawn ? 'Walkable' : 'Orbit only'}
          </span>
        )}
      </footer>
    </section>
  )
}

function EmptyViewer() {
  return (
    <div className="viewer-empty">
      <div className="empty-object" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <h2>Your scene will appear here</h2>
        <p>
          The latest successful environment build becomes playable
          automatically.
        </p>
      </div>
      <code>?scene=/stored/scene.glb</code>
    </div>
  )
}

function StatusDot({ state }: { state: 'ready' | 'error' }) {
  return (
    <span className={`status-dot status-dot-${state}`} aria-hidden="true" />
  )
}

function statusText(
  source: SceneSource | undefined,
  info: SceneViewerInfo | undefined,
) {
  if (source === undefined) return 'Waiting for a successful build'
  if (info === undefined) return 'Loading scene'
  return info.kind === 'environment' ? 'Environment ready' : 'Asset ready'
}
