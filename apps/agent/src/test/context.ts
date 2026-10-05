import type { Context } from '@earendil-works/pi-ai'

/** Every image block the model would have been sent, across all messages. */
export function imageCount(context: Context): number {
  let count = 0
  for (const message of context.messages) {
    if (message.role === 'assistant' || typeof message.content === 'string') {
      continue
    }
    count += message.content.filter((block) => block.type === 'image').length
  }
  return count
}

export function userText(context: Context, which: 'first' | 'last'): string {
  const users = context.messages.filter((message) => message.role === 'user')
  const message = which === 'first' ? users[0] : users[users.length - 1]
  if (message === undefined || message.role !== 'user') return ''
  if (typeof message.content === 'string') return message.content
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}
