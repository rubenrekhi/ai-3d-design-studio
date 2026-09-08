import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  AgentSessionEvent,
  AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent'
import type { BuildReport, Commit } from '@repo/shared'
import { createStudioAgent } from '../agent'
import { type Respond, useScriptedModel } from './scripted'

export const hasBlender = existsSync(
  process.env.BLENDER_PATH ??
    '/Applications/Blender.app/Contents/MacOS/Blender',
)

export const GOOD_SCENE = `import bpy
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
bpy.context.active_object.name = "Cube"
settings = bpy.data.objects.new("__studio_scene_settings__", None)
settings["studio_contract_version"] = 1
settings["studio_scene_kind"] = "asset"
bpy.context.scene.collection.objects.link(settings)
bpy.ops.export_scene.gltf(
    filepath="scene.glb", export_apply=True, export_extras=True
)
`

export const BROKEN_SCENE = `import bpy
raise RuntimeError("boom")
`

export function assetModule(name: string): string {
  return `import bpy

def build(location=(0, 0, 0), instance_name="${name}"):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    root = bpy.context.active_object
    root.name = instance_name
    return root
`
}

export interface Fixture {
  workdir: string
  runtime: AgentSessionRuntime
  events: AgentSessionEvent[]
  commits: Commit[]
  builds: BuildReport[]
  write(rel: string, content: string): Promise<void>
  read(rel: string): Promise<string | undefined>
  dispose(): Promise<void>
}

/**
 * A studio agent on a throwaway workspace, driven by a scripted model and
 * pointed at an empty agent directory so nothing on the machine leaks in.
 */
export async function fixture(respond: Respond): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'studio-'))
  const workdir = join(root, 'workspace')
  await mkdir(workdir, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = join(root, 'agent')

  const commits: Commit[] = []
  const builds: BuildReport[] = []
  const runtime = await createStudioAgent({
    workdir,
    onCommit: async (commit) => {
      commits.push(commit)
    },
    onBuild: (build) => {
      builds.push(build)
    },
  })
  const events: AgentSessionEvent[] = []
  runtime.session.subscribe((event) => {
    events.push(event)
  })
  await useScriptedModel(runtime.session, respond)

  return {
    workdir,
    runtime,
    events,
    commits,
    builds,
    async write(rel, content) {
      const abs = join(workdir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    },
    async read(rel) {
      try {
        return await readFile(join(workdir, rel), 'utf8')
      } catch {
        return undefined
      }
    },
    async dispose() {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
