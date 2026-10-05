import type {
  SessionEntry,
  SessionHeader,
} from '@earendil-works/pi-coding-agent'
import type { Conversation } from '@repo/shared'
import type { AgentMessage } from './messages'
import { describeShot, describeView, type Shot, type View } from './render'
import { inspectPhysicsTool, inspectSceneTool, previewAssetTool } from './tools'

type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>

/**
 * The text that stands in for a render once the model can no longer see it.
 * It carries the tool's own parameters, so it is both the model's handle on
 * the view and the recipe that rebuilds it from the stored GLB.
 */
function stubFor(message: ToolResultMessage, index: number): string {
  if (message.toolName === inspectSceneTool.name) {
    const view = (message.details as { view?: View } | undefined)?.view
    if (view !== undefined) {
      return `[render — ${describeView(view)}. Re-run ${inspectSceneTool.name} to look again.]`
    }
  }
  if (message.toolName === inspectPhysicsTool.name) {
    const view = (message.details as { view?: View } | undefined)?.view
    if (view !== undefined) {
      return `[physics render — ${describeView(view)}, with collision proxies and the player spawn shown. Re-run ${inspectPhysicsTool.name} to look again.]`
    }
  }
  if (message.toolName === previewAssetTool.name) {
    const details = message.details as
      | {
          name?: string
          physics?: boolean
          shots?: Pick<Shot, 'label' | 'view'>[]
        }
      | undefined
    const shot = details?.shots?.[index]
    if (details?.name !== undefined && shot !== undefined) {
      if (details.physics === true) {
        return `[physics render — ${describeShot(details.name, shot)}, with collision proxies shown. Re-run ${previewAssetTool.name} with physics=true to look again.]`
      }
      return `[render — ${describeShot(details.name, shot)}. Re-run ${previewAssetTool.name} to look again.]`
    }
  }
  return `[image removed. Call ${message.toolName} again to see it.]`
}

export function hasImage(message: AgentMessage): boolean {
  return (
    message.role === 'toolResult' &&
    message.content.some((block) => block.type === 'image')
  )
}

/**
 * Replaces each image in a tool result with its stub. Any other message, and
 * a result with no image, comes back as the same object.
 */
export function stubImages(message: AgentMessage): AgentMessage {
  if (!hasImage(message) || message.role !== 'toolResult') return message
  let index = 0
  return {
    ...message,
    content: message.content.map((block) =>
      block.type === 'image'
        ? { type: 'text' as const, text: stubFor(message, index++) }
        : block,
    ),
  }
}

/**
 * The session document as durable storage should hold it: the header first,
 * every entry after it, and no render left inside any of them.
 */
export function stubConversation(
  header: SessionHeader | null,
  entries: SessionEntry[],
): Conversation {
  const stubbed = entries.map((entry) =>
    entry.type === 'message'
      ? { ...entry, message: stubImages(entry.message) }
      : { ...entry },
  )
  return header === null ? stubbed : [{ ...header }, ...stubbed]
}
