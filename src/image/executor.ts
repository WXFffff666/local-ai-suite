/**
 * 生图执行器 — ImageQueue 的真实 JobHandler（阶段0 接线，替换 queue.ts 默认 mock）。
 *
 * 数据流：job (ImageJob) → resolveModel（models/diffusion/** 注册表条目）
 *   → ensureSd（拉起/复用 sd 侧车，携带模型路径重启）
 *   → sd.cpp /generate（同步单 POST；ctx.signal 透传用于取消）
 *   → b64 PNG 回传（ImagePage PNG_B64_PREFIX_RE 契约：裸 base64，iVBOR 开头）。
 *
 * 进度：sd-cli /generate 无过程回调，采用 tick 模拟（启动→绘制→回传），
 * 与既有 SSE image:queue:status 通道兼容；真实进度待升级 sd-server 异步任务 API。
 *
 * MIT, 无 AGPL.
 */

import type { ModelEntry } from '../models/registry'
import type { ImageJob, JobHandler } from './queue'
import {
  generateImageQueued,
  type FetchLike,
  type SdGenerateRequest,
  type SdGenerateResponse,
} from '../sidecars/sd'

// ---------------------------------------------------------------------------
// 模型解析 — models/diffusion/** 目录约定（README「模型文件夹」）
// ---------------------------------------------------------------------------

/** diffusion 目录前缀（file 为相对 modelsDir 的 POSIX 路径） */
export const DIFFUSION_DIR_PREFIX = 'diffusion/'

/**
 * 从注册表条目中挑选画图模型：
 * - 仅接受 diffusion/ 目录下且未损坏的 gguf/safetensors；
 * - requested 给出时按 name/file 子串匹配（大小写不敏感），无命中回退全量；
 * - 无 requested 时：唯一候选直接用；多个按文件大小降序取最大（量化越高通常越大，
 *   且大文件多为底模而非小 LoRA 误放）。
 * 找不到返回 undefined（执行器抛 no-diffusion-model）。
 */
export function pickDiffusionModel(
  entries: readonly ModelEntry[],
  requested?: string,
): string | undefined {
  const candidates = entries.filter(
    (e) =>
      !e.corrupted &&
      (e.format === 'gguf' || e.format === 'safetensors') &&
      e.file.toLowerCase().startsWith(DIFFUSION_DIR_PREFIX),
  )
  if (candidates.length === 0) return undefined
  if (requested !== undefined && requested.trim() !== '') {
    const needle = requested.trim().toLowerCase()
    const matched = candidates.filter(
      (e) => e.name.toLowerCase().includes(needle) || e.file.toLowerCase().includes(needle),
    )
    if (matched.length > 0) return matched[0]!.path
  }
  if (candidates.length === 1) return candidates[0]!.path
  return [...candidates].sort((a, b) => b.size - a.size)[0]!.path
}

// ---------------------------------------------------------------------------
// 执行器工厂
// ---------------------------------------------------------------------------

export type SdExecutorDeps = {
  /** 注册表解析画图模型绝对路径；undefined = 未找到（抛 no-diffusion-model） */
  resolveModel: (requested?: string) => string | undefined
  /** 确保 sd 侧车以指定模型运行；返回可 POST 的端口 */
  ensureSd: (opts: { modelPath?: string }) => Promise<{ port: number }>
  /** sd HTTP 调用（测试注入；默认 generateImageQueued 全局串行队列） */
  generate?: (
    req: SdGenerateRequest,
    opts: { port: number; signal: AbortSignal; fetchImpl?: FetchLike },
  ) => Promise<SdGenerateResponse>
  /** 绘制阶段进度 tick 间隔 ms（默认 1500） */
  tickMs?: number
}

function firstB64(res: SdGenerateResponse): string | undefined {
  if (Array.isArray(res.images) && res.images.length > 0) {
    const first = res.images.find((s) => typeof s === 'string' && s.length > 0)
    if (first !== undefined) return first
  }
  if (typeof res.image === 'string' && res.image.length > 0) return res.image
  return undefined
}

/** 默认尺寸：sd.cpp 兼容起点，ImagePage 表单显式给值时以 job 为准 */
const DEFAULT_WIDTH = 512
const DEFAULT_HEIGHT = 512

/**
 * 创建真实生图 JobHandler。所有失败以 Error 抛出（queue.runJob 统一
 * 重试/终态/中文消息映射在 UI 层完成）。
 */
export function createSdJobHandler(deps: SdExecutorDeps): JobHandler {
  const doGenerate =
    deps.generate ??
    ((req: SdGenerateRequest, o: { port: number; signal: AbortSignal }) =>
      generateImageQueued(req, { port: o.port, signal: o.signal }))
  const tickMs = deps.tickMs ?? 1500

  return async (job: ImageJob, ctx) => {
    const modelPath = deps.resolveModel(job.model)
    if (modelPath === undefined) {
      throw new Error('no-diffusion-model: models/diffusion/ 目录下未找到可用的画图模型')
    }

    ctx.onProgress(5, '正在启动画图引擎…')
    const { port } = await deps.ensureSd({ modelPath })

    const req: SdGenerateRequest = {
      prompt: job.prompt,
      width: job.width ?? DEFAULT_WIDTH,
      height: job.height ?? DEFAULT_HEIGHT,
    }
    if (job.negative_prompt !== undefined) req.negative_prompt = job.negative_prompt
    if (job.steps !== undefined) req.steps = job.steps
    if (job.cfg_scale !== undefined) req.cfg_scale = job.cfg_scale
    if (job.seed !== undefined) req.seed = job.seed
    if (job.loras !== undefined && job.loras.length > 0) req.loras = job.loras
    if (job.initImagePath !== undefined) req.initImagePath = job.initImagePath
    if (job.maskPath !== undefined) req.maskPath = job.maskPath
    if (job.strength !== undefined) req.strength = job.strength

    // 绘制阶段 tick：/generate 同步返回，期间以平滑进度 + 阶段文案填充 SSE
    let pct = 10
    const timer = setInterval(() => {
      pct = Math.min(pct + 3, 85)
      ctx.onProgress(pct, '正在绘制…')
    }, tickMs)
    try {
      const res = await doGenerate(req, { port, signal: ctx.signal })
      const b64 = firstB64(res)
      if (b64 === undefined) throw new Error('画图引擎未返回图片数据')
      // PNG 契约：裸 base64，iVBOR 魔数（ImagePage PNG_B64_PREFIX_RE）
      if (!b64.startsWith('iVBOR')) throw new Error('画图引擎返回的不是 PNG 图片')
      ctx.onProgress(92, '正在回传图片…')
      const result: { b64: string; prompt: string; effectiveModel: string; seed?: number } = {
        b64,
        prompt: job.prompt,
        effectiveModel: job.effectiveModel,
      }
      if (typeof res.seed === 'number') result.seed = res.seed
      return result
    } finally {
      clearInterval(timer)
    }
  }
}
