/**
 * 画廊落盘 — Wave5 T23
 *
 * 画廊落盘缩略图/原图/元数据，右键复制/插入聊天，一键复用参数，gallery/ 落盘
 * - 原图: gallery/<id>/original.png  (b64 -> png)
 * - 缩略: gallery/<id>/thumb.png     (复用原图，仅路径区分；真实缩略可在渲染层用 sharp/canvas 二次生成)
 * - 元数据: gallery/<id>/meta.json   (prompt/seed/steps/model/width/height ...)
 * - 接口: save/list/copy/insert/reuse  (task 要求 5 动词全暴露)
 *
 * MIT, 无 AGPL. 仅 Node fs/path.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

import {
  buildParametersText,
  embedParameters,
  parseParametersText,
  readParametersText,
  type GalleryParameters,
} from './parameters'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const GALLERY_DIR_NAME = 'gallery' as const
export const ORIGINAL_FILE = 'original.png' as const
export const THUMB_FILE = 'thumb.png' as const
export const META_FILE = 'meta.json' as const

/** 落盘元数据 — 生成参数全量 */
export type GalleryMeta = {
  id: string
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  model?: string
  sampler?: string
  createdAt: number
  /** 可选额外透传 */
  extra?: Record<string, unknown>
  /** todo22 — A1111 parameters 同源结构（chunk 与 meta 双写，chunk 为事实源） */
  params?: GalleryParameters
}

/** 列表项 = 元数据 + 落盘路径 */
export type GalleryItem = GalleryMeta & {
  originalPath: string
  thumbPath: string
  metaPath: string
}

/** save 入参 */
export type SaveOptions = {
  /** base64 PNG (不含 data: 前缀，也兼容 data:image/png;base64,) */
  b64: string
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  model?: string
  sampler?: string
  extra?: Record<string, unknown>
  /** 自定义落盘根，默认 gallery/ ；测试注入临时目录 */
  baseDir?: string
  /** 可选覆盖 id，便于测试确定性 */
  id?: string
}

/** list 入参 */
export type ListOptions = {
  baseDir?: string
}

/** 生成参数复用 — 直接喂给 /generate 或 queue */
export type ReuseParams = {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  model?: string
  sampler?: string
  extra?: Record<string, unknown>
}

/** copy 返回 */
export type CopyPayload = {
  /** 落盘绝对路径 */
  path: string
  /** b64 (不含前缀) */
  b64: string
  mime: string
}

/** insert 返回 — 插入聊天/编辑器 */
export type InsertPayload = {
  /** 插入文本 (markdown 图片引用 + prompt) */
  text: string
  /** 图片本地路径 */
  imagePath: string
  /** 图片 b64 供前端直接预览 */
  b64: string
  prompt: string
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** 画廊错误 — id 非法、路径越出画廊根目录等安全失败（task4） */
export class GalleryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GalleryError'
  }
}

/**
 * id 文件系统净化 — 白名单 [a-zA-Z0-9._-]，其余替换为 '_'。
 * 原为 save() 内联正则（gallery.ts:173），提升为 save 与全部读路径共用的唯一事实源。
 */
export function sanitizeGalleryId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * 目录包含校验（评审 r1 强制形式）：两侧先大小写折叠，再取
 * `path.relative(galleryDir, target)`，结果必须非空、不以 '..' 开头、非绝对路径
 * ——同时规避 Windows 盘符大小写（D:\ vs d:\）与 `\\?\` 前缀陷阱。失败抛 GalleryError。
 */
function assertInsideGalleryDir(target: string, galleryDir: string): void {
  const rel = relative(galleryDir.toLowerCase(), resolve(target).toLowerCase())
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new GalleryError(`gallery path escapes base directory: ${target}`)
  }
}

export function getGalleryDir(baseDir?: string): string {
  if (baseDir) return resolve(baseDir)
  return join(process.cwd(), GALLERY_DIR_NAME)
}

export function getItemDir(id: string, baseDir?: string): string {
  const galleryDir = getGalleryDir(baseDir)
  const dir = join(galleryDir, sanitizeGalleryId(id))
  assertInsideGalleryDir(dir, galleryDir)
  return dir
}

export function getOriginalPath(id: string, baseDir?: string): string {
  return join(getItemDir(id, baseDir), ORIGINAL_FILE)
}

export function getThumbPath(id: string, baseDir?: string): string {
  return join(getItemDir(id, baseDir), THUMB_FILE)
}

export function getMetaPath(id: string, baseDir?: string): string {
  return join(getItemDir(id, baseDir), META_FILE)
}

/**
 * 对象入参（copy/insert 收到 GalleryItem）携带的 originalPath 复核：
 * 从其自身结构重导规范路径（触发 getItemDir 的净化+包含校验），与入参不一致即视为篡改/越界。
 */
function canonicalOriginalPath(origPath: string): string {
  const idDir = dirname(origPath)
  const canonical = resolve(getOriginalPath(basename(idDir), dirname(idDir)))
  if (resolve(origPath).toLowerCase() !== canonical.toLowerCase()) {
    throw new GalleryError(`gallery item path fails containment check: ${origPath}`)
  }
  return canonical
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function normalizeB64(raw: string): string {
  const s = raw.trim()
  if (!s) throw new Error('b64 is required')
  // strip data url prefix
  const m = s.match(/^data:image\/\w+;base64,(.+)$/)
  if (m) return m[1]!.trim()
  return s
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// Core: save / list / copy / insert / reuse
// ---------------------------------------------------------------------------

// 单调递增序号：同毫秒保存时保证 list 排序确定性（CI 曾因同 ms tie 排序不稳定而抖动）
let __gallerySeq = 0

/** save 入参 → A1111 parameters 键集（extra 里 machine 字段 loras/strength 一并带走） */
function toGalleryParameters(opts: SaveOptions): GalleryParameters {
  const params: GalleryParameters = { prompt: opts.prompt.trim() }
  if (opts.negative_prompt) params.negative_prompt = opts.negative_prompt
  if (opts.steps !== undefined) params.steps = Number(opts.steps)
  if (opts.cfg_scale !== undefined) params.cfg_scale = Number(opts.cfg_scale)
  if (opts.seed !== undefined) params.seed = Number(opts.seed)
  if (opts.sampler) params.sampler = String(opts.sampler)
  if (opts.model) params.model = String(opts.model)
  if (opts.width !== undefined && opts.height !== undefined) params.size = `${Number(opts.width)}x${Number(opts.height)}`
  const loras = opts.extra?.['loras']
  if (typeof loras === 'string' && loras) params.loras = loras
  const strength = opts.extra?.['strength']
  if (typeof strength === 'number') params.strength = strength
  return params
}

/** 保存一张图到 gallery/<id>/ — 写入 原图 + 缩略 + meta.json */
export function save(opts: SaveOptions): GalleryItem {
  const b64 = normalizeB64(opts.b64)
  const prompt = (opts.prompt ?? '').trim()
  if (!prompt) throw new Error('prompt is required for gallery save')
  // validate base64 sanity
  try {
    const buf = Buffer.from(b64, 'base64')
    if (buf.length === 0) throw new Error('empty')
    // round-trip check: re-encode should not be empty
    if (!buf.toString('base64')) throw new Error('invalid b64')
  } catch (e) {
    throw new Error(`invalid b64: ${(e as Error).message}`)
  }
  const id = (opts.id?.trim() || genId())
  // sanitize id for filesystem (与读路径共用唯一净化规则；越界 id 在 getItemDir 抛 GalleryError)
  const safeId = sanitizeGalleryId(id)
  const dir = getItemDir(safeId, opts.baseDir)
  ensureDir(dir)
  const originalPath = getOriginalPath(safeId, opts.baseDir)
  const thumbPath = getThumbPath(safeId, opts.baseDir)
  const metaPath = getMetaPath(safeId, opts.baseDir)

  const buf = Buffer.from(b64, 'base64')
  const params = toGalleryParameters(opts)
  // todo22: A1111 约定 — parameters tEXt 写回 original.png（非 PNG 载荷静默跳过；
  // sharp 读不到 tEXt，必须走 png-chunks-*，R8 结论）。thumb 不动。
  writeFileSync(originalPath, embedParameters(buf, buildParametersText(params)))
  // 缩略：MVP 直接复用原图 bytes；后续可在 main 进程用 sharp 缩放
  writeFileSync(thumbPath, buf)

  const meta: GalleryMeta & { seq?: number } = {
    id: safeId,
    prompt,
    createdAt: Date.now(),
    seq: ++__gallerySeq,
    params,
  }
  if (opts.negative_prompt !== undefined) meta.negative_prompt = opts.negative_prompt
  if (opts.width !== undefined) meta.width = Number(opts.width)
  if (opts.height !== undefined) meta.height = Number(opts.height)
  if (opts.steps !== undefined) meta.steps = Number(opts.steps)
  if (opts.cfg_scale !== undefined) meta.cfg_scale = Number(opts.cfg_scale)
  if (opts.seed !== undefined) meta.seed = Number(opts.seed)
  if (opts.model !== undefined) meta.model = String(opts.model)
  if (opts.sampler !== undefined) meta.sampler = String(opts.sampler)
  if (opts.extra !== undefined) meta.extra = opts.extra

  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')

  return { ...meta, originalPath: resolve(originalPath), thumbPath: resolve(thumbPath), metaPath: resolve(metaPath) }
}

/** 列出 gallery/ 下所有项，按 createdAt 倒序 */
export function list(opts: ListOptions = {}): GalleryItem[] {
  const dir = getGalleryDir(opts.baseDir)
  if (!existsSync(dir)) return []
  const entries = readdirSync(dir, { withFileTypes: true })
  const out: GalleryItem[] = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const id = ent.name
    let metaPath: string
    try {
      metaPath = getMetaPath(id, opts.baseDir)
    } catch {
      continue // 目录名无法通过净化/包含校验（如 '..x'）→ 跳过，不炸整个列表
    }
    if (!existsSync(metaPath)) continue
    try {
      const raw = readFileSync(metaPath, 'utf-8')
      const meta = JSON.parse(raw) as GalleryMeta
      if (!meta.id) meta.id = id
      out.push({
        ...meta,
        originalPath: resolve(getOriginalPath(id, opts.baseDir)),
        thumbPath: resolve(getThumbPath(id, opts.baseDir)),
        metaPath: resolve(metaPath),
      })
    } catch {
      // corrupt meta -> skip
    }
  }
  out.sort((a, b) =>
    ((b as { seq?: number }).seq ?? 0) - ((a as { seq?: number }).seq ?? 0) ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0),
  )
  return out
}

/** 按 id 读取单项，找不到抛错 */
export function getItem(id: string, baseDir?: string): GalleryItem {
  const metaPath = getMetaPath(id, baseDir)
  if (!existsSync(metaPath)) throw new Error(`gallery item ${id} not found`)
  const raw = readFileSync(metaPath, 'utf-8')
  const meta = JSON.parse(raw) as GalleryMeta
  return {
    ...meta,
    id: meta.id ?? id,
    originalPath: resolve(getOriginalPath(id, baseDir)),
    thumbPath: resolve(getThumbPath(id, baseDir)),
    metaPath: resolve(metaPath),
  }
}

/** 右键复制 — 返回 b64 + 路径；若在 Electron 渲染层可再写 clipboard */
export function copy(idOrItem: string | GalleryItem, baseDir?: string): CopyPayload {
  const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.id
  const dirBase = typeof idOrItem === 'object' && (idOrItem as GalleryItem).metaPath ? undefined : baseDir
  // validation when string id
  if (typeof idOrItem === 'string') getItem(id, baseDir)
  const resolvedBase = dirBase ?? baseDir
  // prefer item's own paths if object (对象路径过包含复核，防篡改 originalPath 任意读)
  const origPath = typeof idOrItem === 'string'
    ? getOriginalPath(id, resolvedBase)
    : idOrItem.originalPath
      ? canonicalOriginalPath(idOrItem.originalPath)
      : getOriginalPath(id, resolvedBase)
  if (!existsSync(origPath)) throw new Error(`original not found for ${id}: ${origPath}`)
  const buf = readFileSync(origPath)
  const b64 = buf.toString('base64')
  // best-effort write to electron clipboard if available (no throw)
  // 非 Electron 运行时（vitest/CI）直接跳过，避免在 runner 上因加载 electron 原型挂起/拖慢
  if (!(process.versions as unknown as { electron?: string } | undefined)?.electron) {
    return { path: resolve(origPath), b64, mime: 'image/png' }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { clipboard?: { writeImage?: (img: unknown) => void; writeBuffer?: (t: string, b: Buffer, type: string) => void } }
    if (electron?.clipboard?.writeBuffer) {
      // PNG buffer
      electron.clipboard.writeBuffer('image/png', buf, 'image/png')
    }
  } catch {
    // not in electron — ignore
  }
  return { path: resolve(origPath), b64, mime: 'image/png' }
}

/** 插入聊天 — 返回 InsertPayload；若提供 onInsert 回调则调用 */
export function insert(
  idOrItem: string | GalleryItem,
  baseDirOrCallback?: string | ((payload: InsertPayload) => void),
  maybeCallback?: (payload: InsertPayload) => void,
): InsertPayload {
  let baseDir: string | undefined
  let onInsert: ((payload: InsertPayload) => void) | undefined
  if (typeof baseDirOrCallback === 'function') {
    onInsert = baseDirOrCallback
  } else {
    baseDir = baseDirOrCallback as string | undefined
    onInsert = maybeCallback
  }
  const id = typeof idOrItem === 'string' ? idOrItem : idOrItem.id
  const item = typeof idOrItem === 'string' ? getItem(id, baseDir) : idOrItem
  const origPath = typeof idOrItem === 'string'
    ? getOriginalPath(id, baseDir)
    : item.originalPath
      ? canonicalOriginalPath(item.originalPath)
      : getOriginalPath(id, baseDir)
  let b64 = ''
  try {
    if (existsSync(origPath)) b64 = readFileSync(origPath).toString('base64')
  } catch {
    b64 = ''
  }
  // fallback to copy if exists
  if (!b64) {
    try {
      b64 = copy(id, baseDir).b64
    } catch {
      b64 = ''
    }
  }
  const text = `![${item.prompt.slice(0, 32)}](${origPath}) ${item.prompt}`
  const payload: InsertPayload = { text, imagePath: resolve(origPath), b64, prompt: item.prompt }
  if (onInsert) onInsert(payload)
  return payload
}

/**
 * 一键复用参数 — 返回可直接喂给 /generate 的参数。
 * 优先级（todo22）：original.png 的 parameters tEXt chunk > meta.json。
 * 图片字节是 A1111 生态的事实源（可被别的工具改动后仍可信）；chunk 缺失/损坏
 * 或对象入参路径未通过包含校验时，回退 meta.json，绝不读围栏外路径。
 */
export function reuse(idOrItem: string | GalleryItem, baseDir?: string): ReuseParams {
  const item = typeof idOrItem === 'string' ? getItem(idOrItem, baseDir) : idOrItem
  const out: ReuseParams = { prompt: item.prompt }
  if (item.negative_prompt !== undefined) out.negative_prompt = item.negative_prompt
  if (item.width !== undefined) out.width = item.width
  if (item.height !== undefined) out.height = item.height
  if (item.steps !== undefined) out.steps = item.steps
  if (item.cfg_scale !== undefined) out.cfg_scale = item.cfg_scale
  if (item.seed !== undefined) out.seed = item.seed
  if (item.model !== undefined) out.model = item.model
  if (item.sampler !== undefined) out.sampler = item.sampler
  if (item.extra !== undefined) out.extra = item.extra
  try {
    const origPath = typeof idOrItem === 'string'
      ? getOriginalPath(idOrItem, baseDir)
      : item.originalPath
        ? canonicalOriginalPath(item.originalPath)
        : null
    if (origPath !== null && existsSync(origPath)) {
      const text = readParametersText(readFileSync(origPath))
      if (text !== null) applyChunkParams(out, parseParametersText(text))
    }
  } catch {
    // 坏 png / 越界路径：meta 回退，reuse 契约不抛
  }
  return out
}

/** chunk 解析值覆盖 meta 值；Size 拆回 width/height；空 prompt 不覆盖。 */
function applyChunkParams(out: ReuseParams, p: GalleryParameters): void {
  if (p.prompt) out.prompt = p.prompt
  if (p.negative_prompt !== undefined) out.negative_prompt = p.negative_prompt
  if (p.steps !== undefined) out.steps = p.steps
  if (p.cfg_scale !== undefined) out.cfg_scale = p.cfg_scale
  if (p.seed !== undefined) out.seed = p.seed
  if (p.sampler !== undefined) out.sampler = p.sampler
  if (p.model !== undefined) out.model = p.model
  if (p.size !== undefined) {
    const m = p.size.match(/^(\d+)\s*x\s*(\d+)$/)
    if (m) {
      out.width = Number(m[1])
      out.height = Number(m[2])
    }
  }
}

/** 删除单项 — 辅助 */
export function remove(id: string, baseDir?: string): boolean {
  const dir = getItemDir(id, baseDir)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** 清空画廊 — 辅助，测试用 */
export function clear(baseDir?: string): number {
  const items = list({ baseDir })
  let n = 0
  for (const it of items) {
    if (remove(it.id, baseDir)) n++
  }
  return n
}

// ---------------------------------------------------------------------------
// Aliases — 兼容语义化命名，task 要求动词全暴露故同时保留
// ---------------------------------------------------------------------------

export const saveToGallery = save
export const listGallery = list
export const copyGalleryItem = copy
export const insertGalleryItem = insert
export const reuseGalleryParams = reuse
export const getGalleryItem = getItem

// In-memory helpers for preview (不落盘)
export function toDataUrl(b64: string, mime = 'image/png'): string {
  const clean = normalizeB64(b64)
  return `data:${mime};base64,${clean}`
}

// todo22 — parameters tEXt 工具透出（UI/测试共用同一实现，无第二份解析器）
export {
  buildParametersText,
  parseParametersText,
  readParametersText,
  embedParameters,
  type GalleryParameters,
} from './parameters'

// Re-export for class wrapper

export class Gallery {
  constructor(private baseDir?: string) {}
  save(opts: Omit<SaveOptions, 'baseDir'>): GalleryItem {
    return save({ ...opts, baseDir: this.baseDir })
  }
  list(): GalleryItem[] {
    return list({ baseDir: this.baseDir })
  }
  get(id: string): GalleryItem {
    return getItem(id, this.baseDir)
  }
  copy(id: string): CopyPayload {
    return copy(id, this.baseDir)
  }
  insert(id: string, onInsert?: (p: InsertPayload) => void): InsertPayload {
    return insert(id, this.baseDir, onInsert)
  }
  reuse(id: string): ReuseParams {
    return reuse(id, this.baseDir)
  }
  remove(id: string): boolean {
    return remove(id, this.baseDir)
  }
  clear(): number {
    return clear(this.baseDir)
  }
}

export default Gallery
