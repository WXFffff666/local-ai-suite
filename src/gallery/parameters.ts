/**
 * A1111 风格 `parameters` tEXt 元数据（todo22）
 *
 * 约定来源：AUTOMATIC1111 stable-diffusion-webui modules/images.py —
 * original.png 内嵌名为 `parameters` 的 tEXt chunk，正文为
 *   <prompt 多行>
 *   Negative prompt: <...>
 *   Steps: N, Sampler: X, CFG scale: F, Seed: N, Size: WxH, Model: M, loras: <lora:n:w>
 * tEXt 只允许 Latin-1，CJK 内容按 A1111 同法承载 UTF-8 字节（utf-8 → latin1
 * 写入，读回 latin1 → utf-8）。sharp 读写不到 tEXt —— 必须走 chunk 库（R8）。
 *
 * 通道：png-chunks-extract / png-chunks-encode / png-chunk-text（MIT，
 * package.json 已预置）。非 PNG 载荷与损坏 PNG 全部静默降级（不抛）。
 */

import extractChunks from 'png-chunks-extract'
import encodeChunks from 'png-chunks-encode'
import { encode as encodeTextChunk, decode as decodeTextChunk } from 'png-chunk-text'

export const PARAMETERS_KEYWORD = 'parameters' as const

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

/** 与 gallery meta / /generate 复用参数同形的键集（chunk 内承载面） */
export type GalleryParameters = {
  prompt: string
  negative_prompt?: string
  steps?: number
  cfg_scale?: number
  seed?: number
  sampler?: string
  model?: string
  size?: string
  loras?: string
  strength?: number
}

function hasPngMagic(buf: Uint8Array): boolean {
  if (buf.length < 8) return false
  for (let i = 0; i < 4; i++) if (buf[i] !== PNG_MAGIC[i]) return false
  return true
}

/** A1111 同款拼装。空值键跳过；loras 已是 `<lora:n:w>` 串原样写入。 */
export function buildParametersText(p: GalleryParameters): string {
  const lines: string[] = [p.prompt]
  if (p.negative_prompt) lines.push(`Negative prompt: ${p.negative_prompt}`)
  const meta: string[] = []
  if (p.steps !== undefined) meta.push(`Steps: ${p.steps}`)
  if (p.sampler) meta.push(`Sampler: ${p.sampler}`)
  if (p.cfg_scale !== undefined) meta.push(`CFG scale: ${p.cfg_scale}`)
  if (p.seed !== undefined) meta.push(`Seed: ${p.seed}`)
  if (p.size) meta.push(`Size: ${p.size}`)
  if (p.model) meta.push(`Model: ${p.model}`)
  if (p.loras) meta.push(`loras: ${p.loras}`)
  if (p.strength !== undefined) meta.push(`Strength: ${p.strength}`)
  if (meta.length > 0) lines.push(meta.join(', '))
  return lines.join('\n')
}

/** `Key: value, Key2: value2` 逗号切分，值内逗号（多 lora 标签）回填上一键。 */
function splitMetaLine(line: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const token of line.split(', ')) {
    const m = token.match(/^([A-Za-z][A-Za-z0-9 ]*): (.*)$/)
    if (m && m[1] && m[2] !== undefined) out.push([m[1], m[2]])
    else if (out.length > 0 && m === null) out[out.length - 1]![1] += `, ${token}`
  }
  return out
}

/** 宽容解析（外部 A1111 文件亦吃）；只回推得动的键，数字解析失败键跳过。 */
const META_LINE_RE = /\b(Steps|Sampler|CFG scale|Seed|Size|Model|loras|Strength): /
export function parseParametersText(text: string): GalleryParameters {
  const lines = text.split('\n')
  const lastIsMeta = META_LINE_RE.test(lines[lines.length - 1] ?? '')
  const metaLine = lastIsMeta ? (lines[lines.length - 1] ?? '') : ''
  const out: GalleryParameters = { prompt: '' }
  const kv = new Map<string, string>()
  for (const [k, v] of splitMetaLine(metaLine)) kv.set(k.toLowerCase(), v)

  const negIdx = lines.findIndex((l) => l.startsWith('Negative prompt:'))
  const promptEnd = negIdx !== -1 ? negIdx : lastIsMeta ? lines.length - 1 : lines.length
  out.prompt = lines.slice(0, Math.max(promptEnd, 0)).join('\n')

  if (negIdx !== -1 && lines[negIdx]) out.negative_prompt = lines[negIdx]!.slice('Negative prompt:'.length + 1)
  const num = (key: string): number | undefined => {
    const raw = kv.get(key)
    if (raw === undefined) return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  const steps = num('steps')
  if (steps !== undefined) out.steps = steps
  const cfg = num('cfg scale')
  if (cfg !== undefined) out.cfg_scale = cfg
  const seed = num('seed')
  if (seed !== undefined) out.seed = seed
  const strength = num('strength')
  if (strength !== undefined) out.strength = strength
  const sampler = kv.get('sampler')
  if (sampler) out.sampler = sampler
  const model = kv.get('model') ?? kv.get('model name')
  if (model) out.model = model
  const size = kv.get('size')
  if (size) out.size = size
  const loras = kv.get('loras')
  if (loras) out.loras = loras
  return out
}

/** 把 parameters tEXt 写入 PNG（替换既有同名 chunk，置于 IEND 前）。非 PNG/解析失败原样返回。 */
export function embedParameters(png: Buffer, text: string): Buffer {
  if (!hasPngMagic(png)) return png
  let chunks
  try {
    chunks = extractChunks(new Uint8Array(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)))
  } catch {
    return png
  }
  const kept = chunks.filter((c) => {
    if (c.name !== 'tEXt') return true
    try {
      return decodeTextChunk(c.data).keyword !== PARAMETERS_KEYWORD
    } catch {
      return true
    }
  })
  const latin1Body = Buffer.from(text, 'utf-8').toString('latin1')
  const iendAt = kept.findIndex((c) => c.name === 'IEND')
  const chunk = encodeTextChunk(PARAMETERS_KEYWORD, latin1Body)
  if (iendAt === -1) kept.push(chunk)
  else kept.splice(iendAt, 0, chunk)
  try {
    return Buffer.from(encodeChunks(kept))
  } catch {
    return png
  }
}

/** 读取 parameters tEXt 正文；无 chunk / 非 PNG / 损坏 → null（调用方回退 meta.json）。 */
export function readParametersText(png: Uint8Array): string | null {
  if (!hasPngMagic(png)) return null
  let chunks
  try {
    chunks = extractChunks(png)
  } catch {
    return null
  }
  for (const c of chunks) {
    if (c.name !== 'tEXt') continue
    try {
      const d = decodeTextChunk(c.data)
      if (d.keyword === PARAMETERS_KEYWORD) return Buffer.from(d.text, 'latin1').toString('utf-8')
    } catch {
      /* 坏 chunk 跳过，继续找 */
    }
  }
  return null
}
