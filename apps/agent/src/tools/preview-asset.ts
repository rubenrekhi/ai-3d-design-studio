import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { ASSETS_DIR, describeShot, renderAsset } from '../render'

export const previewAssetTool = defineTool({
  name: 'preview_asset',
  label: 'Preview',
  description: `Look at one asset on its own. Builds ${ASSETS_DIR}/<name>.py by calling its build() in an empty scene, then returns a contact sheet of it from four sides. Use this while shaping an asset; use inspect_scene to see it placed in the scene.`,
  promptSnippet:
    'build one asset module on its own and look at it from four sides',
  parameters: Type.Object({
    name: Type.String({
      description: `The asset to look at, named as ${ASSETS_DIR}/<name>.py without the directory or the extension.`,
    }),
  }),
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    const preview = await renderAsset(ctx.cwd, params.name, {
      id: toolCallId,
      signal,
    })
    return {
      content: preview.shots.flatMap((shot) => [
        {
          type: 'text' as const,
          text: `${describeShot(params.name, shot)}:`,
        },
        { type: 'image' as const, data: shot.png, mimeType: 'image/png' },
      ]),
      details: {
        name: params.name,
        shots: preview.shots.map(({ label, view }) => ({ label, view })),
        durationMs: preview.durationMs,
      },
    }
  },
})
