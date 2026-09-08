import { sceneSources } from './scene-sources'
import { SceneWorkspace } from './scene-workspace'

export default async function Home({ searchParams }: PageProps<'/'>) {
  const sources = sceneSources(await searchParams, process.env.STUDIO_SCENE_URL)

  return (
    <main className="studio-shell">
      <header className="studio-header">
        <div className="studio-brand" aria-label="3D Design Studio">
          <span className="studio-mark" aria-hidden="true" />
          <span>3D Design Studio</span>
        </div>
        <p>Build with the agent. Explore at human scale.</p>
      </header>

      <SceneWorkspace sources={sources} />
    </main>
  )
}
