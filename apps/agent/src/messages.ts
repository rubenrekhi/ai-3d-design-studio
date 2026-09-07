import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent'

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
