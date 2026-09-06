import type {
  SessionEntry,
  SessionMessageEntry,
} from '@earendil-works/pi-coding-agent'

export type AgentMessage = SessionMessageEntry['message']
export type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>

export function lastAssistant(
  messages: AgentMessage[],
): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'assistant') return message
  }
  return undefined
}

export function messagesOf(entries: SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) =>
    entry.type === 'message' ? [entry.message] : [],
  )
}

export function toolResultIds(entries: SessionEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messagesOf(entries)) {
    if (message.role === 'toolResult') ids.add(message.toolCallId)
  }
  return ids
}
