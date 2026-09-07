import { describe, expect, it } from 'vitest'
import { stubConversation, stubImages } from './images'
import type { AgentMessage } from './messages'

type Content = Extract<AgentMessage, { role: 'toolResult' }>['content']

const PNG = 'iVBORw0KGgo='
const image = { type: 'image' as const, data: PNG, mimeType: 'image/png' }
const text = (text: string) => ({ type: 'text' as const, text })

function result(
  toolName: string,
  content: Content,
  details?: unknown,
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_1',
    toolName,
    content,
    details,
    isError: false,
    timestamp: 1,
  }
}

const inspection = result('inspect_scene', [text('Rendered.'), image], {
  view: { azimuth: 45, elevation: 25, framing: 'scene' },
})

describe('stubImages', () => {
  it('replaces an inspect_scene render with its recipe', () => {
    const stubbed = stubImages(inspection)
    if (stubbed.role !== 'toolResult') throw new Error('role changed')
    expect(stubbed.content).toEqual([
      text('Rendered.'),
      text(
        '[render — the whole scene in scene.glb at azimuth 45°, elevation 25°. Re-run inspect_scene to look again.]',
      ),
    ])
  })

  it('names each preview_asset view from its own shot', () => {
    const front = { azimuth: 0, elevation: 10, framing: 'scene' }
    const above = { azimuth: 0, elevation: 85, framing: 'scene' }
    const preview = result(
      'preview_asset',
      [text('front:'), image, text('above:'), image],
      {
        name: 'chair',
        shots: [
          { label: 'the front', view: front },
          { label: 'above', view: above },
        ],
      },
    )
    const stubbed = stubImages(preview)
    if (stubbed.role !== 'toolResult') throw new Error('role changed')
    expect(stubbed.content).toEqual([
      text('front:'),
      text(
        '[render — "chair" from the front (azimuth 0°, elevation 10°). Re-run preview_asset to look again.]',
      ),
      text('above:'),
      text(
        '[render — "chair" from above (azimuth 0°, elevation 85°). Re-run preview_asset to look again.]',
      ),
    ])
  })

  it('returns the same object when there is nothing to stub', () => {
    const plain = result('read', [text('print(1)')])
    expect(stubImages(plain)).toBe(plain)
    const user: AgentMessage = { role: 'user', content: 'hi', timestamp: 1 }
    expect(stubImages(user)).toBe(user)
  })

  it('falls back to a generic stub for a tool it does not know', () => {
    const stubbed = stubImages(result('screenshot', [image]))
    if (stubbed.role !== 'toolResult') throw new Error('role changed')
    expect(stubbed.content).toEqual([
      text('[image removed. Call screenshot again to see it.]'),
    ])
  })
})

describe('stubConversation', () => {
  it('keeps the header first and every entry in order, minus the pixels', () => {
    const header = {
      type: 'session' as const,
      version: 3,
      id: 'abc',
      timestamp: 't',
      cwd: '/w',
    }
    const entry = (id: string, parentId: string | null) => ({
      id,
      parentId,
      timestamp: 't',
    })
    const conversation = stubConversation(header, [
      {
        type: 'message',
        ...entry('1', null),
        message: { role: 'user', content: 'look', timestamp: 1 },
      },
      { type: 'message', ...entry('2', '1'), message: inspection },
      { type: 'model_change', ...entry('3', '2'), provider: 'p', modelId: 'm' },
    ])
    expect(conversation.map((e) => e.type)).toEqual([
      'session',
      'message',
      'message',
      'model_change',
    ])
    expect(JSON.stringify(conversation)).not.toContain(PNG)
    expect(JSON.stringify(conversation)).toContain('azimuth 45°')
  })
})
