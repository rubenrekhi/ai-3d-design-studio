import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { harnessEventSchema } from '@repo/shared'
import { describe, expect, it } from 'vitest'
import { toHarnessEvents } from './events'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const message = {
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: 'Done.' }],
  api: 'x',
  provider: 'p',
  model: 'm',
  usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
  stopReason: 'stop' as const,
  timestamp: 1,
}

/** Maps, then proves the product could have parsed what came out. */
function mapped(event: AgentSessionEvent) {
  const events = toHarnessEvents(event)
  for (const out of events) expect(harnessEventSchema.parse(out)).toEqual(out)
  return events
}

describe('toHarnessEvents', () => {
  it('maps a tool result to text and an image count, never pixels', () => {
    const view = { azimuth: 0, elevation: 20, framing: 'scene' }
    const [result] = mapped({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'inspect_scene',
      isError: false,
      result: {
        content: [
          { type: 'text', text: 'Rendered.' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        details: { view },
      },
    })
    expect(result).toEqual({
      type: 'tool_result',
      id: 'call_1',
      name: 'inspect_scene',
      ok: true,
      text: 'Rendered.',
      images: 1,
      details: { view },
    })
    expect(JSON.stringify(result)).not.toContain('AAAA')
  })

  it('emits deltas while streaming and the text at message end', () => {
    const delta = { type: 'text_delta' as const, contentIndex: 0, delta: 'Do' }
    expect(
      mapped({
        type: 'message_update',
        message,
        assistantMessageEvent: { ...delta, partial: message },
      }),
    ).toEqual([{ type: 'text_delta', delta: 'Do' }])
    expect(mapped({ type: 'message_end', message })).toEqual([
      { type: 'assistant', text: 'Done.', stopReason: 'stop' },
    ])
  })

  it('maps a tool call and drops what the product has no use for', () => {
    const args = { path: 'scene.py', content: 'import bpy' }
    expect(
      mapped({
        type: 'tool_execution_start',
        toolCallId: 'call_2',
        toolName: 'write',
        args,
      }),
    ).toEqual([{ type: 'tool_call', id: 'call_2', name: 'write', args }])
    expect(mapped({ type: 'agent_start' })).toEqual([])
    const user = { role: 'user' as const, content: 'hi', timestamp: 1 }
    expect(mapped({ type: 'message_end', message: user })).toEqual([])
  })
})
