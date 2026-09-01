/**
 * Zod validation for IPC invoke payloads (plan W1-8: "所有 handler 入参 zod 校验";
 * Appendix C maps this to OWASP LLM input-handling for the IPC boundary).
 *
 * Every handler funnels its raw args through validatePayload(); a failure is
 * converted into the stable 400-shape IpcValidationError instead of throwing a
 * raw zod error across the IPC boundary.
 */

import { z } from 'zod'

// --- shared primitives -------------------------------------------------------

const idSchema = z.string().min(1).max(128)
const roleSchema = z.enum(['user', 'assistant', 'system'])

// --- chat --------------------------------------------------------------------

export const chatSendSchema = z.object({
  id: idSchema,
  model: z.string().min(1).max(256),
  messages: z
    .array(z.object({ role: roleSchema, content: z.string().max(1_000_000) }))
    .min(1)
    .max(512),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  stop: z.union([z.string().max(512), z.array(z.string().max(512)).max(16)]).optional()
})
export type ChatSendInput = z.infer<typeof chatSendSchema>

export const chatAbortSchema = z.object({ id: idSchema })
export type ChatAbortInput = z.infer<typeof chatAbortSchema>

// --- models / downloads --------------------------------------------------------

/** HF repo ids are 'owner/name' — downloadWithResume enforces the slash too. */
export const modelsDownloadSchema = z.object({
  id: idSchema.optional(),
  repoId: z
    .string()
    .regex(/^[^\s/]+\/[^\s/]+$/, 'repoId must be owner/name')
    .max(256),
  filename: z.string().min(1).max(512).optional(),
  localDir: z.string().min(1).max(1024).optional(),
  quant: z.string().min(1).max(32).optional()
})
export type ModelsDownloadInput = z.infer<typeof modelsDownloadSchema>

// --- images --------------------------------------------------------------------

export const imageGenerateSchema = z.object({
  prompt: z.string().min(1).max(8192),
  negative_prompt: z.string().max(8192).optional(),
  width: z.number().int().min(64).max(8192).optional(),
  height: z.number().int().min(64).max(8192).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfg_scale: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(-1).max(2_147_483_647).optional(),
  model: z.string().max(256).optional(),
  vramMB: z.number().int().min(0).max(1_048_576).optional()
})
export type ImageGenerateInput = z.infer<typeof imageGenerateSchema>

export const imageQueueStatusSchema = z.object({ jobId: idSchema.optional() })
export type ImageQueueStatusInput = z.infer<typeof imageQueueStatusSchema>

// --- gallery --------------------------------------------------------------------

export const galleryIdSchema = z.object({ id: z.string().min(1).max(256) })
export type GalleryIdInput = z.infer<typeof galleryIdSchema>

export const gallerySaveSchema = z.object({
  b64: z.string().min(1).max(80_000_000),
  prompt: z.string().max(8192).default(''),
  negative_prompt: z.string().max(8192).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  cfg_scale: z.number().nonnegative().optional(),
  seed: z.number().int().optional(),
  model: z.string().max(256).optional(),
  sampler: z.string().max(256).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  id: z.string().min(1).max(256).optional()
})
export type GallerySaveInput = z.infer<typeof gallerySaveSchema>

// --- search / hf market -----------------------------------------------------------

export const searchRunSchema = z.object({
  query: z.string().min(1).max(2048),
  count: z.number().int().min(1).max(50).optional()
})
export type SearchRunInput = z.infer<typeof searchRunSchema>

export const hfSearchSchema = z.object({
  query: z.string().max(512).optional(),
  quant: z.union([z.string().max(32), z.array(z.string().max(32)).max(16)]).optional(),
  ggufOnly: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sort: z.enum(['likes', 'downloads', 'lastModified']).optional(),
  direction: z.union([z.literal(-1), z.literal(1)]).optional()
})
export type HfSearchInput = z.infer<typeof hfSearchSchema>

// --- conversations (channels pre-listed; service lands in todo17) ------------------

export const conversationsListSchema = z.object({}).strict()
export const conversationsCreateSchema = z.object({ title: z.string().min(1).max(512).optional() })
export const conversationsRenameSchema = z.object({ id: idSchema, title: z.string().min(1).max(512) })
export const conversationsDeleteSchema = z.object({ id: idSchema })
export const conversationsAppendMessageSchema = z.object({
  chatId: idSchema,
  role: roleSchema,
  content: z.string().max(1_000_000)
})
export const conversationsListMessagesSchema = z.object({ chatId: idSchema })

// --- validation funnel --------------------------------------------------------------

export type IpcIssue = { path: string; message: string }
export type IpcValidationError = { ok: false; error: 'invalid-payload'; issues: IpcIssue[] }

export type Validated<T> = { ok: true; data: T } | IpcValidationError

/** Parses `value` with `schema`, converting failures to the 400-shape result. */
export function validatePayload<T>(schema: z.ZodType<T>, value: unknown): Validated<T> {
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, data: parsed.data }
  const issues: IpcIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message
  }))
  return { ok: false, error: 'invalid-payload', issues }
}
