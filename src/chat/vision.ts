/**
 * vision.ts — todo21 VLM 贴图契约面（渲染层）
 * 单一职责：图片 intake 校验（File → dataURL 前的闸门）+ 视觉能力探测
 * （models:list 里是否存在配对了 projectorPath 的 gguf 模型）。
 * 权威校验在 src/main/ipc/schemas.ts 的 chatSendSchema —— 这里的限制是
 * 同一契约的 UI 预检，不是第二套真值。
 */

/** 与 main 侧 zod 门一致的四类栅格图（svg 明确排除：矢量注入面）。 */
export const ACCEPTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AcceptedImageMime = (typeof ACCEPTED_IMAGE_MIMES)[number]

/** 解码后单图上限 4 MiB（== base64 还原出的原始字节数，file.size 即解码尺寸）。 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** plan: 每条消息最多 2 张贴图。 */
export const MAX_IMAGES_PER_MESSAGE = 2

export const VISION_DISABLED_TOOLTIP = '该模型无视觉投影文件'

/** 只有本地 data-URL 栅格图可被渲染（远端 URL 一律拒绝，双保险于 zod 门）。 */
const RENDERABLE_DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/

export function isRenderableImageSrc(src: string): boolean {
  return RENDERABLE_DATA_URI_RE.test(src)
}

export function isAcceptedImageFile(file: { type: string; size: number }): boolean {
  return (ACCEPTED_IMAGE_MIMES as readonly string[]).includes(file.type) && file.size <= MAX_IMAGE_BYTES
}

/** File → base64 dataURL（渲染层唯一图片来源）。 */
export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

export type FileLike = { type: string; size: number }

/**
 * 从 paste/drop 事件里挑出可添加的图片：只保留被接受的 mime，并在剩余
 * 名额（cap = MAX_IMAGES_PER_MESSAGE - already）内截断。纯函数，便于测试。
 */
export function selectAttachableImages(
  files: readonly FileLike[],
  alreadyAttached: number,
): number[] {
  const cap = Math.max(0, MAX_IMAGES_PER_MESSAGE - alreadyAttached)
  const indices: number[] = []
  for (let i = 0; i < files.length && indices.length < cap; i += 1) {
    const f = files[i]
    if (f && isAcceptedImageFile(f)) indices.push(i)
  }
  return indices
}

type ModelsListInvoker = { invoke(channel: 'models:list'): Promise<unknown> }

/** Structural window.api probe (chat lanes never import Electron types here). */
export function getWindowApiForVision(): ModelsListInvoker | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: { invoke?: unknown } }).api
  if (api && typeof api.invoke === 'function') return api as ModelsListInvoker
  return null
}

/**
 * 视觉能力 = 注册表里存在任一带 projectorPath 的 gguf 模型（todo21 配对）。
 * 无 api / 请求失败一律视为不可用（attach 禁用 + tooltip 即 QA-fail 场景）。
 */
export async function probeVisionCapability(invoke?: ModelsListInvoker['invoke']): Promise<boolean> {
  const api = getWindowApiForVision()
  const fn = invoke ?? api?.invoke.bind(api)
  if (!fn) return false
  try {
    const reply = (await fn('models:list')) as {
      models?: Array<{ format?: string; projectorPath?: string }>
    } | null
    const models = reply?.models ?? []
    return models.some(
      (m) => m.format === 'gguf' && typeof m.projectorPath === 'string' && m.projectorPath.length > 0,
    )
  } catch {
    return false
  }
}
