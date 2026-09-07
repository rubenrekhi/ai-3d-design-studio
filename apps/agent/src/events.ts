import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { HarnessEvent } from '@repo/shared'

type Block = { type: 'text'; text: string } | { type: string }

/**
 * Pi's stream, reduced to what a product needs and stripped of pixels. A
 * render is rebuilt from the stored GLB and the parameters in its result.
 */
export function toHarnessEvents(event: AgentSessionEvent): HarnessEvent[] {
  switch (event.type) {
    case 'message_update': {
      const delta = event.assistantMessageEvent
      return delta.type === 'text_delta'
        ? [{ type: 'text_delta', delta: delta.delta }]
        : []
    }
    case 'message_end': {
      const message = event.message
      if (message.role !== 'assistant') return []
      return [
        {
          type: 'assistant',
          text: textOf(message.content),
          stopReason: message.stopReason,
          ...(message.errorMessage === undefined
            ? {}
            : { error: message.errorMessage }),
        },
      ]
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool_call',
          id: event.toolCallId,
          name: event.toolName,
          args: (event.args ?? {}) as Record<string, unknown>,
        },
      ]
    case 'tool_execution_end': {
      const result = event.result as
        { content?: Block[]; details?: unknown } | undefined
      const content = result?.content ?? []
      return [
        {
          type: 'tool_result',
          id: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          text: textOf(content),
          images: content.filter((block) => block.type === 'image').length,
          ...(result?.details === undefined ? {} : { details: result.details }),
        },
      ]
    }
    default:
      return []
  }
}

function textOf(content: readonly Block[]): string {
  return content
    .flatMap((block) => ('text' in block ? [block.text] : []))
    .join('\n')
}
