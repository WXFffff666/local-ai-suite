/**
 * image:* handler implementations (todo20 lane) - factored out of
 * src/main/ipc/handlers.ts following the existing createXxxHandler factory
 * pattern (deleteWorkspace/overwriteCoverage/...). The wiring in handlers.ts
 * stays the single ipc registration surface; these factories own validation
 * + queue/file side effects so the main map remains structural.
 */

import { mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { ImageJobOptions } from '../../image/queue'
import {
  imageGenerateSchema,
  imageSaveTempImageSchema,
  validatePayload,
} from '../ipc/schemas'

/**
 * Same call signature as ipc/handlers' IpcHandler minus the ctx param.
 * image handlers do not send events, and this keeps the module import-free
 * of handlers.ts (no type cycle). passthrough() in handlers.ts adapts it.
 */
export type ImageOpsHandler = (args: unknown[]) => Promise<unknown>

/** Decoded PNG cap for image:saveTempImage (8 MiB). */
export const TEMP_IMAGE_MAX_BYTES = 8 * 1024 * 1024

export type ImageQueueSurface = {
  enqueue: (opts: ImageJobOptions) => string
  getJob: (id: string) => { warning?: string; effectiveModel?: string } | undefined
}

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

function statSyncSafe(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * image:generate - zod-gated enqueue. txt2img payloads keep their pre-todo20
 * shape (mode/strength/img paths are dropped); img2img/inpaint carry
 * initImagePath/maskPath/strength (sd.cpp --init-img/--mask/--strength,
 * Appendix R3 搂A row 18/20). Queue-side file validation failures
 * (init-image-missing / mask-missing) ride the same 400-shape.
 */
export function createImageGenerateHandler(deps: { imageQueue: ImageQueueSurface }): ImageOpsHandler {
  return async (args) => {
    const parsed = validatePayload(imageGenerateSchema, first(args))
    if (!parsed.ok) return parsed
    const input = parsed.data
    const opts: ImageJobOptions = { prompt: input.prompt }
    if (input.negative_prompt !== undefined) opts.negative_prompt = input.negative_prompt
    if (input.width !== undefined) opts.width = input.width
    if (input.height !== undefined) opts.height = input.height
    if (input.steps !== undefined) opts.steps = input.steps
    if (input.cfg_scale !== undefined) opts.cfg_scale = input.cfg_scale
    if (input.seed !== undefined) opts.seed = input.seed
    if (input.model !== undefined) opts.model = input.model
    if (input.vramMB !== undefined) opts.vramMB = input.vramMB
    if (input.loras !== undefined) opts.loras = input.loras
    // 阶段1：AI 提示词润色开关（执行器先本地 LLM 扩写再出图）
    if (input.enhance !== undefined) opts.enhance = input.enhance
    // mode absent but initImagePath present implies img2img; a pure txt2img
    // payload keeps its exact pre-todo20 shape (the zod strength default is
    // dropped with the rest of the img2img bundle).
    const mode = input.mode ?? (input.initImagePath !== undefined ? 'img2img' : 'txt2img')
    if (mode !== 'txt2img') {
      opts.mode = mode
      if (input.initImagePath !== undefined) opts.initImagePath = input.initImagePath
      if (input.maskPath !== undefined) opts.maskPath = input.maskPath
      opts.strength = input.strength ?? 0.75
    }
    try {
      const jobId = deps.imageQueue.enqueue(opts)
      const job = deps.imageQueue.getJob(jobId)
      return { ok: true, statusCode: 202, jobId, warning: job?.warning, effectiveModel: job?.effectiveModel }
    } catch (e) {
      const message = (e as Error).message
      return { ok: false, error: 'invalid-payload', issues: [{ path: 'initImagePath', message }] }
    }
  }
}

/**
 * image:saveTempImage - persist a renderer-synthesized PNG (drag-drop read via
 * FileReader, or mask-brush canvas toDataURL) under <userDataDir>/tmp so sd-cli
 * consumes it as an absolute --init-img/--mask path. PNG-only + 8MiB cap on
 * decoded bytes; the returned path is what image:generate sends back.
 */
export function createSaveTempImageHandler(deps: { userDataDir: string }): ImageOpsHandler {
  return async (args) => {
    const parsed = validatePayload(imageSaveTempImageSchema, first(args))
    if (!parsed.ok) return parsed
    const comma = parsed.data.dataURL.indexOf(',')
    const buf = Buffer.from(parsed.data.dataURL.slice(comma + 1), 'base64')
    if (buf.length === 0) return { ok: false, error: 'invalid-payload' }
    if (buf.length > TEMP_IMAGE_MAX_BYTES) return { ok: false, error: 'dataurl-too-large' }
    const tmpDir = join(deps.userDataDir, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    // ts collision guard: two exports inside one ms bump the suffix (mask
    // strokes + drop events can land on the same clock tick).
    const ts = Date.now()
    let path = join(tmpDir, `img-${ts}.png`)
    for (let n = 1; statSyncSafe(path); n += 1) {
      path = join(tmpDir, `img-${ts}-${n}.png`)
    }
    writeFileSync(path, buf)
    return { ok: true, path }
  }
}
