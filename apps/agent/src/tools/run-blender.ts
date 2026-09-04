import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { lastLines, runBlender } from '../blender'
import { SCENE_GLB } from '../render'

export const runBlenderTool = defineTool({
  name: 'run_blender',
  label: 'Build',
  description: `Run scene.py in Blender to rebuild ${SCENE_GLB}. Reports the Python error when the script fails, and whatever the script printed when it succeeds.`,
  promptSnippet: `run scene.py in Blender to rebuild ${SCENE_GLB}`,
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
    const build = await runBlender(ctx.cwd, { signal })
    if (!build.ok) {
      throw new Error(`The build failed.\n\n${lastLines(build.stderr)}`)
    }

    const glb = join(ctx.cwd, SCENE_GLB)
    const size = await sizeOf(glb)
    if (size === undefined) {
      throw new Error(
        `scene.py ran without error but wrote no ${SCENE_GLB}. It must end by exporting one: bpy.ops.export_scene.gltf(filepath="${SCENE_GLB}").`,
      )
    }

    const printed = lastLines(build.stdout)
    return {
      content: [
        {
          type: 'text' as const,
          text: `Built ${SCENE_GLB} (${Math.round(size / 1024)} KB) in ${build.durationMs}ms.\n\n${printed}`,
        },
      ],
      details: { durationMs: build.durationMs, size },
    }
  },
})

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch {
    return undefined
  }
}
