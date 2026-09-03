/**
 * types.ts — todo13 模型管理页线格式类型
 *
 * 镜像 src/models/registry.ts ModelEntry（registry 引用 fs/chokidar，不在
 * tsconfig.web 编译范围内 —— 约定同 components/market/types.ts）。字段以
 * 'models:list' 运行时 JSON 为准。
 */

export type ModelFormat = 'gguf' | 'safetensors' | 'onnx' | 'bin' | 'unknown'

export type ModelRow = {
  name: string
  file: string
  path: string
  size: number
  quant: string
  arch: string
  format: ModelFormat
  mtimeMs: number
  /** registry 探针隔离标记（probeFileHeader 失败时由 registry 写入） */
  corrupted?: boolean
  /** 损坏原因（仅 corrupted 时） */
  error?: string
}

/** 'models:list' → handlers.ts `{ models }`。 */
export type ModelsListReply = { models: ModelRow[] }

/** 'models:setDir' 应答族（whitelist 新通道，handlers.ts modelsSetDirSchema）。 */
export type SetDirReply =
  | { ok: true; modelsDir: string; models: ModelRow[]; restartRequired: boolean }
  | { ok: false; error: 'path-not-absolute' | 'dir-not-found' | 'invalid-payload'; issues?: unknown }

/** 'config:get' 应答族 — 本组件仅消费 modelsDir。 */
export type ConfigGetReply = { ok?: boolean; config?: { modelsDir?: string } }

/** 字节数 → 人类可读（与 market 侧独立实现，页内自治）。 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(1)} ${units[u]}`
}
