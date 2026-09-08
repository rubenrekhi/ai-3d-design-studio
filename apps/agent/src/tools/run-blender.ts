import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { buildScene } from '../blender/build'
import { SCENE_GLB } from '../blender/render'

export const runBlenderTool = defineTool({
  name: 'run_blender',
  label: 'Build',
  description: `Run scene.py in Blender to rebuild ${SCENE_GLB}. Reports the Python error when the script fails, and whatever the script printed when it succeeds.`,
  promptSnippet: `run scene.py in Blender to rebuild ${SCENE_GLB}`,
  parameters: Type.Object({}),
  execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
    const build = await buildScene(ctx.cwd, { signal })
    if (!build.ok) {
      throw new Error(`The build failed.\n\n${build.error}`)
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `Built and validated ${SCENE_GLB} (${Math.round(build.size / 1024)} KB) in ${build.durationMs}ms. Physics: ${build.physics.kind}, ${build.physics.colliderCount} collider${build.physics.colliderCount === 1 ? '' : 's'}, ${build.physics.hasSpawn ? 'spawn ready' : 'no spawn'}.\n\n${build.printed}`,
        },
      ],
      details: {
        durationMs: build.durationMs,
        size: build.size,
        physics: build.physics,
      },
    }
  },
})
