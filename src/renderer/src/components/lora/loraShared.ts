/**
 * loraShared.ts — todo19 LoRA 选择器共享件（LoraPicker / LoraSection 共用）。
 * 线格式类型直接复用 src/main/ipc/whitelist.ts（tsconfig.web 允许 import 的
 * 唯一 main 文件），杜绝双份声明。
 */

import type { LoraFile, LoraMeta, LoraMetaError, LoraMetaReply, LoraScanReply } from '../../../../main/ipc/whitelist'

export type { LoraFile, LoraMeta, LoraMetaError, LoraMetaReply, LoraScanReply }

/** 计划 W3 滑杆规格：0..1.5，步进 0.05，默认 0.75（A1111/kohya 习惯位）。 */
export const LORA_SCALE_MIN = 0
export const LORA_SCALE_MAX = 1.5
export const LORA_SCALE_STEP = 0.05
export const LORA_SCALE_DEFAULT = 0.75

/** 一项选择 = 文件 + 权重；提交时映射为 image:generate 的 loras 载荷。 */
export type LoraSelection = {
  file: LoraFile
  scale: number
}

/** 与 src/sidecars/sd.ts clampLoraScale 同式（渲染层无法 import sidecars）。 */
function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  const clamped = Math.min(2, Math.max(0, scale))
  return Number((Math.round(clamped / 0.05) * 0.05).toFixed(2))
}

/** 单文件 `<lora:name:scale>` 标签（buildLoraPromptTags 渲染层镜像）。 */
export function loraTag(sel: LoraSelection): string {
  const name = sel.file.name.trim().replace(/[\s<>]/g, '_')
  return `<lora:${name}:${clampScale(sel.scale)}>`
}

/** 全部选择的实时预览串（每标签带尾随空格 —— 与 sd.ts buildLoraPromptTags 逐字节一致）。 */
export function loraTagPreview(sels: readonly LoraSelection[]): string {
  let out = ''
  for (const s of sels) out += `${loraTag(s)} `
  return out
}

/** 提交给 image:generate 的 loras 数组（仅 name+scale）。 */
export function toGenerateLoras(sels: readonly LoraSelection[]): { name: string; scale: number }[] {
  return sels.map((s) => ({ name: s.file.name, scale: clampScale(s.scale) }))
}

/** meta 摘要（选择行显示）：优先 tag 串与网络维度，缺省回 unknown。 */
export function loraMetaSummary(meta: LoraMeta | undefined): string | null {
  if (!meta || Object.keys(meta).length === 0) return null
  const parts: string[] = []
  if (typeof meta['ss_tag_string'] === 'string') parts.push(`tags: ${meta['ss_tag_string']}`)
  if (meta['ss_network_dim'] !== undefined) parts.push(`dim: ${meta['ss_network_dim']}`)
  if (meta['modelspec.architecture'] !== undefined) parts.push(`arch: ${meta['modelspec.architecture']}`)
  return parts.length > 0 ? parts.join(' · ') : Object.entries(meta).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ')
}

export type LoraInvoke = (channel: 'models:loraScan' | 'models:loraMeta', payload?: unknown) => Promise<unknown>

/** invoke + 线格式收敛（cast 集中在一处；main 侧 zod/containment 是最终门禁）。 */
export async function invokeLoraScan(invoke: LoraInvoke): Promise<LoraFile[]> {
  const reply = (await invoke('models:loraScan', {})) as Partial<LoraScanReply> | undefined
  if (!reply || reply.ok !== true) return []
  return Array.isArray(reply.files) ? reply.files : []
}

export async function invokeLoraMeta(invoke: LoraInvoke, path: string): Promise<LoraMetaReply> {
  const reply = (await invoke('models:loraMeta', { path })) as LoraMetaReply | undefined
  if (!reply || typeof reply !== 'object' || !('ok' in reply)) {
    return { ok: false, error: 'bad-header' }
  }
  return reply
}
