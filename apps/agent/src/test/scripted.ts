import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { type Respond, scriptedStream, type Turn } from './stream'

export type { Respond, Turn } from './stream'

export const PROVIDER = 'scripted'

/**
 * Registers a provider whose replies come from `respond` and makes it the
 * session's model, so a test drives pi's real loop without a network.
 */
export async function useScriptedModel(
  session: AgentSession,
  respond: Respond,
): Promise<void> {
  session.modelRuntime.registerProvider(PROVIDER, {
    api: PROVIDER,
    baseUrl: 'http://scripted.invalid',
    apiKey: 'scripted',
    streamSimple: (model, context) => scriptedStream(model, context, respond),
    models: [
      {
        id: PROVIDER,
        name: 'Scripted',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 8192,
      },
    ],
  })
  const model = session.modelRuntime.getModel(PROVIDER, PROVIDER)
  if (model === undefined) throw new Error('the scripted model is missing')
  await session.setModel(model)
}

/** Turns a `Turn` list into a `Respond` that plays it in order. */
export function inOrder(turns: Turn[]): Respond {
  const queue = [...turns]
  return () => {
    const turn = queue.shift()
    if (turn === undefined) throw new Error('the script ran out of turns')
    return turn
  }
}
