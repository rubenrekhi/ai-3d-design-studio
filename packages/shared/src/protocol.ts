import { z } from 'zod'
import { changedFilesSchema, manifestSchema } from './manifest'

export const runStatusSchema = z.enum(['ok', 'error', 'aborted'])
export type RunStatus = z.infer<typeof runStatusSchema>

/**
 * Pi's session document with every render replaced by its stub: the header
 * first, then each entry in file order. Written back out one object per line
 * it is a session file pi can open.
 */
export const conversationSchema = z.array(z.record(z.string(), z.unknown()))
export type Conversation = z.infer<typeof conversationSchema>

const commitBase = {
  workdir: z.string(),
  sessionId: z.string(),
  /** The entry the conversation ends on. Null when it holds no entries yet. */
  entryId: z.string().nullable(),
  conversation: conversationSchema,
}

/**
 * What a run leaves behind. Only a run that ended cleanly and builds carries
 * a manifest, so files cannot be committed from a run that failed.
 */
export const commitSchema = z.discriminatedUnion('status', [
  z.object({
    ...commitBase,
    status: z.literal('ok'),
    manifest: manifestSchema,
    changed: changedFilesSchema,
  }),
  z.object({
    ...commitBase,
    status: z.enum(['error', 'aborted']),
    error: z.string().optional(),
  }),
])
export type Commit = z.infer<typeof commitSchema>

export const buildReportSchema = z.object({
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
})
export type BuildReport = z.infer<typeof buildReportSchema>

/**
 * One line of the harness's stdout, in order. Images never appear: a render
 * is rebuilt from the stored GLB and the parameters in its tool result.
 */
export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session'),
    id: z.string(),
    file: z.string().optional(),
  }),
  z.object({ type: z.literal('run_start') }),
  z.object({ type: z.literal('text_delta'), delta: z.string() }),
  z.object({
    type: z.literal('assistant'),
    text: z.string(),
    stopReason: z.string(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    id: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    text: z.string(),
    images: z.number().int().nonnegative(),
    details: z.unknown().optional(),
  }),
  buildReportSchema.extend({ type: z.literal('build') }),
  z.object({ type: z.literal('commit'), commit: commitSchema }),
  z.object({
    type: z.literal('run_end'),
    status: runStatusSchema,
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type HarnessEvent = z.infer<typeof harnessEventSchema>
