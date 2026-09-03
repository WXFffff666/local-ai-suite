/**
 * Zod validation for IPC invoke payloads (plan W1-8: "所有 handler 入参 zod 校验";
 * Appendix C maps this to OWASP LLM input-handling for the IPC boundary).
 *
 * Every handler funnels its raw args through validatePayload(); a failure is
 * converted into the stable 400-shape IpcValidationError instead of throwing a
 * raw zod error across the IPC boundary.
 */

import { z } from 'zod'

import type { ChatMessageContent } from './whitelist'

// --- shared primitives -------------------------------------------------------

const idSchema = z.string().min(1).max(128)
const roleSchema = z.enum(['user', 'assistant', 'system'])

// --- chat --------------------------------------------------------------------

/**
 * todo21 VLM: image_url parts accept ONLY inline base64 data-URLs of the four
 * raster mimes llama.cpp mtmd handles well. SVG is rejected (vector/XSS surface
 * — never a chat image), remote http(s) URLs are rejected (renderer must never
 * be tricked into fetching attacker-controlled URLs through the model loop).
 * Decoded payload cap: 4 MiB.
 */
export const MAX_IMAGE_DATA_BYTES = 4 * 1024 * 1024
const IMAGE_DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/

export type ParsedImageDataUri = { mime: string; bytes: number }

/** Parses a legal chat image data-URL; undefined on any violation. */
export function parseImageDataUri(url: string): ParsedImageDataUri | undefined {
  const m = IMAGE_DATA_URI_RE.exec(url)
  if (!m?.[2]) return undefined
  const b64 = m[2]
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const bytes = Math.floor(b64.length / 4) * 3 - pad
  if (bytes > MAX_IMAGE_DATA_BYTES) return undefined
  return { mime: `image/${m[1] === 'jpeg' ? 'jpeg' : m[1]}`, bytes }
}

const chatImageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z
    .object({
      // 4 MiB decoded ≈ 5.6M base64 chars; char pre-guard bounds the regex cost.
      url: z
        .string()
        .min(1)
        .max(6_000_000)
        .refine((u) => parseImageDataUri(u) !== undefined, {
          message: 'image_url must be a base64 data:image/(png|jpeg|webp|gif) URI ≤4MiB decoded',
        }),
    })
    .strict(),
}).strict()

const chatTextPartSchema = z
  .object({ type: z.literal('text'), text: z.string().max(1_000_000) })
  .strict()

const chatContentArraySchema = z
  .array(z.union([chatTextPartSchema, chatImageUrlPartSchema]))
  .min(1)
  .max(8)
  .superRefine((parts, ctx) => {
    const images = parts.filter((p) => p.type === 'image_url').length
    if (images > 2) {
      ctx.addIssue({ code: 'custom', message: 'too-many-images', max: 2 })
    }
  })

const chatMessageContentSchema = z.union([z.string().max(1_000_000), chatContentArraySchema])

export const chatMessageSchema = z.object({ role: roleSchema, content: chatMessageContentSchema })

export const chatSendSchema = z.object({
  id: idSchema,
  model: z.string().min(1).max(256),
  messages: z.array(chatMessageSchema).min(1).max(512),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
  stop: z.union([z.string().max(512), z.array(z.string().max(512)).max(16)]).optional()
})
export type ChatSendInput = z.infer<typeof chatSendSchema>

// Compile-time wire-alignment proof: the zod-inferred content shape must stay
// assignable to the whitelist's shared ChatMessageContent contract.
export const CHAT_CONTENT_WIRE_ALIGNED: ChatSendInput['messages'][number]['content'] extends ChatMessageContent
  ? true
  : never = true

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
  quant: z.string().min(1).max(32).optional(),
  /** 14b disk pre-flight budget in bytes; absent ⇒ size unknown ⇒ check skipped. */
  expectedBytes: z.number().int().positive().max(1_000_000_000_000_000).optional()
})
export type ModelsDownloadInput = z.infer<typeof modelsDownloadSchema>

export const downloadCancelSchema = z.object({ id: idSchema })
export type DownloadCancelInput = z.infer<typeof downloadCancelSchema>

/** todo13: models dir switch. Absolute path only — checked again by the handler. */
export const modelsSetDirSchema = z.object({
  path: z.string().min(1).max(1024)
})
export type ModelsSetDirInput = z.infer<typeof modelsSetDirSchema>

/** todo19: LoRA scan takes no arguments; the empty-object shape is still gated. */
export const modelsLoraScanSchema = z.object({}).strict()

/**
 * todo19: LoRA header meta. The path is renderer-supplied (from a prior
 * models:loraScan reply) — zod only bounds its shape; the handler re-confines
 * it inside modelsDir (assertInsideModelsDir) before any read. Absolute-path
 * traversal ('../../x.safetensors') is a rejection, not a parse concern.
 */
export const modelsLoraMetaSchema = z.object({
  path: z.string().min(1).max(1024)
})
export type ModelsLoraMetaInput = z.infer<typeof modelsLoraMetaSchema>

// --- config (theme / locale / encrypted secret payloads) -------------------------

/** Secret fields persist ONLY safeStorage payloads (enc:v1:/enc:fallback:v1:) —
 *  the handler rejects any other non-empty value (plaintext-never-on-disk). */
export const secretPayloadSchema = z
  .string()
  .max(4096)
  .refine((v) => v === '' || v.startsWith('enc:v1:') || v.startsWith('enc:fallback:v1:'), {
    message: 'secrets must be enc:v1:/enc:fallback:v1: payloads (encrypt via secrets:encrypt)'
  })

export const configGetSchema = z.object({}).strict()

export const configSetSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    locale: z.string().min(2).max(10).optional(),
    secrets: z
      .object({
        hfToken: secretPayloadSchema.optional(),
        tavilyApiKey: secretPayloadSchema.optional(),
        exaApiKey: secretPayloadSchema.optional(),
        braveApiKey: secretPayloadSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type ConfigSetInput = z.infer<typeof configSetSchema>

// --- images --------------------------------------------------------------------

/** todo20 — img2img/inpaint fields ride the same channel; mode stays optional so
 *  a plain txt2img payload parses to exactly its own keys (strict-shape test pin). */
export const imageGenerateSchema = z
  .object({
    prompt: z.string().min(1).max(8192),
    negative_prompt: z.string().max(8192).optional(),
    width: z.number().int().min(64).max(8192).optional(),
    height: z.number().int().min(64).max(8192).optional(),
    steps: z.number().int().min(1).max(150).optional(),
    cfg_scale: z.number().min(0).max(30).optional(),
    seed: z.number().int().min(-1).max(2_147_483_647).optional(),
    model: z.string().max(256).optional(),
    vramMB: z.number().int().min(0).max(1_048_576).optional(),
    mode: z.enum(['txt2img', 'img2img', 'inpaint']).optional(),
    /** absolute path exported by image:saveTempImage — existence checked at enqueue. */
    initImagePath: z.string().min(1).max(1024).optional(),
    maskPath: z.string().min(1).max(1024).optional(),
    /** sd.cpp --strength mirror; default 0.75 applied by the handler in img2img modes. */
    strength: z.number().min(0).max(1).default(0.75).optional(),
    loras: z
      .array(z.object({ name: z.string().min(1).max(256), scale: z.number().min(0).max(2) }))
      .max(16)
      .optional()
  })
  .superRefine((val, ctx) => {
    if ((val.mode === 'img2img' || val.mode === 'inpaint') && val.initImagePath === undefined) {
      ctx.addIssue({ code: 'custom', path: ['initImagePath'], message: 'init-image-missing' })
    }
    if (val.mode === 'inpaint' && val.maskPath === undefined) {
      ctx.addIssue({ code: 'custom', path: ['maskPath'], message: 'mask-required' })
    }
  })
export type ImageGenerateInput = z.infer<typeof imageGenerateSchema>

/**
 * todo20 — renderer exports drops/mask brush strokes as PNG dataURLs on the
 * canvas (webUtils paths are unavailable for synthesized images); main writes
 * them under userData/tmp. PNG-only. The char cap is a memory pre-guard
 * (~12MB decoded); the real 8MB limit is enforced on decoded bytes in the
 * handler so oversize payloads get the dedicated dataurl-too-large error.
 */
export const imageSaveTempImageSchema = z.object({
  dataURL: z.string().min(1).max(16_000_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'dataURL must be a base64 PNG data URL')
})
export type ImageSaveTempImageInput = z.infer<typeof imageSaveTempImageSchema>

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

// --- agent (todo23 tool-calling loop) ---------------------------------------------

/** Local engine origin only — same 127.0.0.1 confinement as every sidecar dial. */
const agentBaseUrlSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^http:\/\/127\.0\.0\.1(?::\d{2,5})?(?:\/.*)?$/, 'baseUrl must be http://127.0.0.1[:port]')

export const agentStartSchema = z
  .object({
    sessionId: idSchema,
    baseUrl: agentBaseUrlSchema,
    /** Absent ⇒ the handler answers model-not-selected; the UI picks one (todo29). */
    model: z.string().min(1).max(256).optional(),
    goal: z.string().min(1).max(200_000),
    /** Workspace root for the todo27/28 path fence; carried opaquely here. */
    workspace: z.string().max(1024).optional(),
    /** Optional LOWERING of the runner cap; the hard ceiling (25) lives in types.ts. */
    maxIterations: z.number().int().min(1).max(25).optional()
  })
  .strict()
export type AgentStartInput = z.infer<typeof agentStartSchema>

export const agentStatusSchema = z.object({ sessionId: idSchema }).strict()
export type AgentStatusInput = z.infer<typeof agentStatusSchema>

export const agentCancelSchema = agentStatusSchema
export type AgentCancelInput = z.infer<typeof agentCancelSchema>

// --- permission approval (todo25) -----------------------------------------------

/**
 * Renderer's answer to a 'permission:request'. The choice enum is the ONLY
 * escalation surface — there is deliberately no "approve everything" member
 * (no-YOLO posture, Appendix C LLM06). requestId comes from the bridge, so a
 * forged/stale id is refused at the bridge (unknown-request), not here.
 */
export const permissionRespondSchema = z
  .object({
    requestId: idSchema,
    choice: z.enum(['once', 'session', 'always', 'deny'])
  })
  .strict()
export type PermissionRespondInput = z.infer<typeof permissionRespondSchema>

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
