/** ImagePage 与主进程 IPC 的应答形状 + payload 组装（todo20 页面拆分件） */

import type { ImageMode } from './ImageModeToggle'
import type { GenerationFieldsValue } from './GenerationFields'

/** sd.cpp sampler 展示名（A1111 parameters 串与画廊 meta 共用） */
export const DEFAULT_SAMPLER = 'euler_a'

/** image:generate 载荷（todo20: img2img/inpaint 三模式统一通道；todo19: loras） */
export function buildGeneratePayload(
  f: GenerationFieldsValue,
  mode: ImageMode,
  img2img: { initImagePath?: string; maskPath?: string; strength: number },
  loras: { name: string; scale: number }[] = [],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt: f.prompt.trim(),
    width: f.width,
    height: f.height,
    steps: f.steps,
    cfg_scale: f.cfg,
    seed: f.seed,
  }
  if (f.negative.trim()) payload.negative_prompt = f.negative.trim()
  if (f.model.trim()) payload.model = f.model.trim()
  if (loras.length > 0) payload.loras = loras
  if (mode !== 'txt2img') {
    payload.mode = mode
    payload.initImagePath = img2img.initImagePath
    payload.strength = img2img.strength
    if (img2img.maskPath !== undefined) payload.maskPath = img2img.maskPath
  }
  return payload
}

/** gallery:save 载荷快照（提交瞬间定格，done 回调零闭包读值） */
export function buildGallerySnapshot(
  f: GenerationFieldsValue,
  mode: ImageMode,
  strength: number,
  loras: { name: string; scale: number }[] = [],
): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  if (mode !== 'txt2img') {
    extra.mode = mode
    extra.strength = strength
  }
  if (loras.length > 0) extra.loras = loras
  return {
    prompt: f.prompt.trim(),
    ...(f.negative.trim() ? { negative_prompt: f.negative.trim() } : {}),
    width: f.width,
    height: f.height,
    steps: f.steps,
    cfg_scale: f.cfg,
    seed: f.seed,
    ...(f.model.trim() ? { model: f.model.trim() } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  }
}

export type SaveTempReply = {
  ok?: boolean
  path?: string
  error?: string
  issues?: { message: string }[]
}

export type GenerateReply = SaveTempReply & { jobId?: string; warning?: string }

export type QueueStatusReply = {
  ok?: boolean
  job?: { status: string; result?: { b64?: string } } | null
}

export type GalleryListReply = { items: { id: string }[] }

export type GalleryReuseReply = {
  ok?: boolean
  params?: {
    prompt?: string
    negative_prompt?: string
    width?: number
    height?: number
    steps?: number
    cfg_scale?: number
    seed?: number
    model?: string
  }
}

/** 生成结果 PNG 的 base64 魔数探针（sharp/sd-cli 返回均带 89 50 4E 47 前缀） */
export const PNG_B64_PREFIX_RE = /^iVBOR/

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsDataURL(file)
  })
}
