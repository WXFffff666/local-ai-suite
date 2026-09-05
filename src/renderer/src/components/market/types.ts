/**
 * types.ts — todo14 市场页 IPC 线格式类型
 *
 * 镜像 src/market/hf.ts 的 HfModelCard / SUPPORTED_QUANTS 与 handlers.ts 的
 * 响应包装。刻意不直接 import hf.ts：该模块引用 child_process，不在
 * tsconfig.web.json 编译范围内（约定同 whitelist.ts 的 ImageQueueStatusEvent
 * "Mirrors src/image/queue.ts"）。字段以运行时 JSON 为准，漂移由
 * src/main/ipc/handlers.test.ts 侧的 zod schema 守住。
 */

/** 与 src/models/registry.ts + hf.ts SUPPORTED_QUANTS 一致的量化标签清单。 */
export const MARKET_QUANTS = [
  'Q2_K',
  'Q3_K_S',
  'Q3_K_M',
  'Q3_K_L',
  'Q4_0',
  'Q4_1',
  'Q4_K_S',
  'Q4_K_M',
  'Q5_0',
  'Q5_1',
  'Q5_K_S',
  'Q5_K_M',
  'Q6_K',
  'Q8_0',
  'IQ1_S',
  'IQ1_M',
  'IQ2_XS',
  'IQ2_XXS',
  'IQ3_XS',
  'IQ3_XXS',
  'IQ4_XS',
  'IQ4_NL',
  'F16',
  'F32',
  'BF16',
  'INT4',
  'INT8',
] as const

export type MarketQuantTag = (typeof MARKET_QUANTS)[number] | string

/** 镜像 hf.ts HfModelCard（去掉 revision 等渲染层不消费的可选噪声）。 */
export type MarketModelCard = {
  repoId: string
  name: string
  author: string
  quant: MarketQuantTag
  filename?: string
  sizeLabel: string
  gguf: boolean
  description: string
  tags: string[]
  likes?: number
  /** 精选目录：指定落盘子目录（models/diffusion 等），缺省按 repoId 建目录 */
  localDir?: string
}

/** validatePayload 失败的稳定 400 形状（schemas.ts IpcValidationError）。 */
export type IpcReject = {
  ok: false
  error: 'invalid-payload'
  issues: Array<{ path: string; message: string }>
}

/** 'hf:search' → handlers.ts `{ ok: true, cards }`。 */
export type HfSearchReply = { ok: true; cards: MarketModelCard[] } | IpcReject

/** 'models:download' → DownloadManager ack 族（14b：含磁盘预检拒绝）。 */
export type DownloadAckReply =
  | { ok: true; id: string; repoId: string; state: 'downloading' }
  | { ok: false; error: 'insufficient-disk'; free: number; needed: number }
  | IpcReject

/** 渲染层下载任务状态机 = DownloadProgressEvent 的累积投影。 */
export type DownloadJob = {
  id: string
  repoId: string
  /** 展示名：来自发起卡片，未知（main 侧自发事件）时回退 repoId。 */
  name: string
  received: number
  /** 0 = 总量未知（hf-cli 事件契约：done 前 total 恒为 0 → 不定长进度条）。 */
  total: number
  /** 'cancelled' = download:cancel 终态（todo14b）。 */
  state: 'downloading' | 'done' | 'error' | 'cancelled'
  error?: string
}

/** 把 issues 拼成一条可读错误串（诚实呈现，不吞错）。 */
export function formatIssues(reject: IpcReject): string {
  return reject.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')
}
