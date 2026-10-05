import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai'

export type Turn =
  | { text: string }
  | { calls: { name: string; args: Record<string, unknown> }[] }
  | { abort: string }

/** Decides each turn from the context the model would have seen. */
export type Respond = (context: Context) => Turn

const EMPTY_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

let calls = 0

/** An assistant reply as a provider would stream it, played from a `Turn`. */
export function scriptedStream(
  model: Model<Api>,
  context: Context,
  respond: Respond,
): AssistantMessageEventStream {
  const events = createAssistantMessageEventStream()
  const base: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
  }

  queueMicrotask(() => {
    let turn: Turn
    try {
      turn = respond(context)
    } catch (error) {
      events.push({
        type: 'error',
        reason: 'error',
        error: { ...base, stopReason: 'error', errorMessage: String(error) },
      })
      return
    }

    events.push({ type: 'start', partial: base })
    if ('abort' in turn) {
      events.push({
        type: 'error',
        reason: 'aborted',
        error: { ...base, stopReason: 'aborted', errorMessage: turn.abort },
      })
      return
    }
    if ('text' in turn) {
      const message: AssistantMessage = {
        ...base,
        content: [{ type: 'text', text: turn.text }],
      }
      events.push({ type: 'text_start', contentIndex: 0, partial: message })
      events.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: turn.text,
        partial: message,
      })
      events.push({
        type: 'text_end',
        contentIndex: 0,
        content: turn.text,
        partial: message,
      })
      events.push({ type: 'done', reason: 'stop', message })
      return
    }

    const content: AssistantMessage['content'] = turn.calls.map((call) => ({
      type: 'toolCall',
      id: `call_${++calls}`,
      name: call.name,
      arguments: call.args,
    }))
    const message: AssistantMessage = {
      ...base,
      content,
      stopReason: 'toolUse',
    }
    content.forEach((block, contentIndex) => {
      if (block.type !== 'toolCall') return
      events.push({ type: 'toolcall_start', contentIndex, partial: message })
      events.push({
        type: 'toolcall_end',
        contentIndex,
        toolCall: block,
        partial: message,
      })
    })
    events.push({ type: 'done', reason: 'toolUse', message })
  })

  return events
}
