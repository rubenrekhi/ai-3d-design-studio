import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { describeView, renderScene, SCENE_GLB, WHOLE_SCENE } from '../render'

export const inspectSceneTool = defineTool({
  name: 'inspect_scene',
  label: 'Look',
  description: `Look at the scene. Renders ${SCENE_GLB} from a camera that orbits whatever it frames and always points at it, so you choose a direction rather than a position. Build with run_blender first: this renders the exported GLB, not scene.py.`,
  promptSnippet: 'render the scene from a camera you choose and look at it',
  parameters: Type.Object({
    azimuth: Type.Number({
      description:
        'Direction to look from, in degrees around the scene: 0 front, 90 right, 180 back, 270 left.',
    }),
    elevation: Type.Number({
      description:
        'Height to look from, in degrees: 0 eye level, 90 straight down, negative from below.',
      minimum: -89,
      maximum: 89,
    }),
    framing: Type.String({
      description: `The object to fill the frame with, by name, or "${WHOLE_SCENE}" for everything.`,
    }),
  }),
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    const view = {
      azimuth: params.azimuth,
      elevation: params.elevation,
      framing: params.framing,
    }
    const render = await renderScene(ctx.cwd, view, { id: toolCallId, signal })
    return {
      content: [
        { type: 'text' as const, text: `Rendered ${describeView(view)}.` },
        {
          type: 'image' as const,
          data: render.png,
          mimeType: 'image/png',
        },
      ],
      details: { view, durationMs: render.durationMs },
    }
  },
})
