import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { validateScenePhysics } from '../physics'
import {
  describeView,
  renderPhysicsScene,
  SCENE_GLB,
  WHOLE_SCENE,
} from '../render'

export const inspectPhysicsTool = defineTool({
  name: 'inspect_physics',
  label: 'Inspect physics',
  description: `Validate and look at the playable physics in ${SCENE_GLB}. Visible collision is green, hidden triangle proxies are blue, hidden convex proxies are orange, and the player capsule and facing direction are pink and yellow. Build with run_blender first.`,
  promptSnippet:
    'validate the collision boundaries and player spawn, then look at their debug overlay',
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
      description: `The object to fill the frame with, by name, or "${WHOLE_SCENE}" for everything. Use "${WHOLE_SCENE}" to judge navigation.`,
    }),
  }),
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    const validation = await validateScenePhysics(ctx.cwd, { signal })
    if (!validation.ok) {
      throw new Error(`Physics validation failed.\n\n${validation.error}`)
    }
    const view = {
      azimuth: params.azimuth,
      elevation: params.elevation,
      framing: params.framing,
    }
    const render = await renderPhysicsScene(ctx.cwd, view, {
      id: toolCallId,
      signal,
    })
    const report = validation.report
    return {
      content: [
        {
          type: 'text' as const,
          text: `Physics is valid: ${report.colliderCount} collider${report.colliderCount === 1 ? '' : 's'} (${report.hiddenColliderCount} hidden proxies, ${report.triangleCount} triangles), ${report.hasSpawn ? 'player spawn ready' : 'no player spawn'}. Rendered ${describeView(view)} with the physics overlay.`,
        },
        {
          type: 'image' as const,
          data: render.png,
          mimeType: 'image/png',
        },
      ],
      details: {
        view,
        physics: true,
        report,
        durationMs: validation.durationMs + render.durationMs,
      },
    }
  },
})
