/**
 * 生图队列与显存分级 — Wave5 T22
 *
 * 显存分级:
 *   <4GB  -> SD1.5 Q4 强制降级 (downgrade)
 *   <6GB  -> SDXL 警告 (warn, 仍允许但提示显存紧张)
 *   >=6GB && <=12GB -> SDXL 正常
 *   >12GB -> 解锁 FLUX (unlock)
 *
 * 队列:
 *   - 串行执行 (concurrency=1) 避免显存争用
 *   - SSE 进度推送 (0..100, 事件 data: {jobId, progress, status, message})
 *   - 重试: 默认 2 次 + 指数退避, 仅对可重试错误 (网络/429/5xx/超时/OOM 可重试标记)
 *
 * MIT, 无 AGPL. 仅依赖 Node/TS 标准.
 */

// ---------------------------------------------------------------------------
// VRAM 分级
// ---------------------------------------------------------------------------

export const VRAM_THRESH_SD15_Q4_MB = 4096 as const // <4GB
export const VRAM_THRESH_SDXL_WARN_MB = 6144 as const // <6GB
export const VRAM_THRESH_FLUX_MB = 12288 as const // >12GB

export type VramTier = 'low' | 'medium' | 'high' | 'ultra'
/** 推荐模型 */
export type RecommendedModel = 'sd1.5-q4' | 'sd1.5' | 'sdxl' | 'flux'

export type VramGrade = {
  tier: VramTier
  totalMB: number
  /** <4GB 强制走 SD1.5 Q4 */
  downgradeToQ4: boolean
  /** <6GB 时若请求 SDXL 需警告 */
  warnSdxl: boolean
  /** >12GB 解锁 FLUX */
  fluxUnlocked: boolean
  /** 推荐模型 */
  recommended: RecommendedModel
  /** 人可读提示 */
  message: string
}

export function classifyVram(totalMB: number | null | undefined): VramTier {
  if (totalMB == null || !Number.isFinite(totalMB) || totalMB <= 0) return 'low'
  if (totalMB < VRAM_THRESH_SD15_Q4_MB) return 'low'
  if (totalMB < VRAM_THRESH_SDXL_WARN_MB) return 'medium'
  if (totalMB <= VRAM_THRESH_FLUX_MB) return 'high'
  return 'ultra'
}

/** 显存分级主函数 */
export function gradeVram(totalMB: number | null | undefined): VramGrade {
  const mb = totalMB == null || !Number.isFinite(totalMB) ? 0 : totalMB
  const tier = classifyVram(mb)
  const downgradeToQ4 = mb > 0 && mb < VRAM_THRESH_SD15_Q4_MB
  const warnSdxl = mb > 0 && mb < VRAM_THRESH_SDXL_WARN_MB
  const fluxUnlocked = mb > VRAM_THRESH_FLUX_MB
  let recommended: RecommendedModel
  let message: string
  if (downgradeToQ4) {
    recommended = 'sd1.5-q4'
    message = `显存 ${Math.round(mb / 1024)}GB <4GB，已自动降级 SD1.5 Q4 (q4_0)`
  } else if (tier === 'medium') {
    recommended = 'sdxl'
    message = `显存 ${Math.round(mb / 1024)}GB <6GB，SDXL 可能显存紧张，建议 512x512 / 降低 steps`
  } else if (tier === 'ultra') {
    recommended = 'flux'
    message = `显存 ${Math.round(mb / 1024)}GB >12GB，已解锁 FLUX`
  } else {
    recommended = 'sdxl'
    message = `显存 ${Math.round(mb / 1024)}GB，SDXL 可正常运行`
  }
  if (mb === 0) {
    // 未知显存视为 low
    return {
      tier: 'low',
      totalMB: 0,
      downgradeToQ4: true,
      warnSdxl: true,
      fluxUnlocked: false,
      recommended: 'sd1.5-q4',
      message: '显存未知，已降级 SD1.5 Q4 兜底',
    }
  }
  return { tier, totalMB: mb, downgradeToQ4, warnSdxl, fluxUnlocked, recommended, message }
}

/** 是否需要对请求的模型做降级/警告/解锁判定 */
export type ModelRequestGrade = {
  allowed: boolean
  downgraded: boolean
  warning?: string
  reason: string
  effectiveModel: string
  grade: VramGrade
}

const SDXL_ALIASES = ['sdxl', 'sd-xl', 'stable-diffusion-xl']
const FLUX_ALIASES = ['flux', 'flux.1', 'flux1']
const SD15_ALIASES = ['sd1.5', 'sd15', 'stable-diffusion-1.5', 'sd-1.5']

function normalizeModel(m: string): string {
  return m.trim().toLowerCase()
}

export function gradeModelRequest(totalMB: number | null | undefined, requestedModel?: string): ModelRequestGrade {
  const grade = gradeVram(totalMB)
  const raw = requestedModel ? normalizeModel(requestedModel) : grade.recommended
  const wantsSdxl = SDXL_ALIASES.includes(raw)
  const wantsFlux = FLUX_ALIASES.includes(raw)
  const wantsSd15 = SD15_ALIASES.includes(raw) || raw.includes('sd1.5')

  // <4GB 强制降级: 任何非 sd1.5-q4 请求均降级
  if (grade.downgradeToQ4) {
    if (wantsSdxl || wantsFlux) {
      return {
        allowed: true,
        downgraded: true,
        warning: `显存 ${(grade.totalMB / 1024).toFixed(1)}GB <4GB，${requestedModel ?? 'SDXL/FLUX'} 已降级为 SD1.5 Q4`,
        reason: 'vram<4GB downgrade to sd1.5 q4_0',
        effectiveModel: 'sd1.5-q4',
        grade,
      }
    }
    return {
      allowed: true,
      downgraded: raw !== 'sd1.5-q4' && !wantsSd15 ? true : false,
      warning: undefined,
      reason: grade.message,
      effectiveModel: wantsSd15 ? raw : 'sd1.5-q4',
      grade,
    }
  }

  // <6GB 警告 SDXL: 允许但附警告
  if (grade.warnSdxl && wantsSdxl) {
    return {
      allowed: true,
      downgraded: false,
      warning: `显存 ${(grade.totalMB / 1024).toFixed(1)}GB <6GB，SDXL 可能 OOM，建议 512x512 / steps<=20`,
      reason: 'vram<6GB warn sdxl',
      effectiveModel: raw,
      grade,
    }
  }

  // >12GB 解锁 FLUX
  if (wantsFlux && !grade.fluxUnlocked) {
    return {
      allowed: false,
      downgraded: false,
      warning: `显存 ${(grade.totalMB / 1024).toFixed(1)}GB 未达 12GB，FLUX 未解锁，已回退 SDXL`,
      reason: 'flux requires >12GB',
      effectiveModel: 'sdxl',
      grade,
    }
  }
  if (wantsFlux && grade.fluxUnlocked) {
    return { allowed: true, downgraded: false, warning: undefined, reason: 'flux unlocked', effectiveModel: raw, grade }
  }

  return { allowed: true, downgraded: false, warning: undefined, reason: grade.message, effectiveModel: raw, grade }
}

// ---------------------------------------------------------------------------
// 队列 + SSE 进度 + 重试
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export type ImageJobOptions = {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  model?: string
  /** 显存总量 MB，用于分级判定 (注入便于测试) */
  vramMB?: number | null
  /** 最大重试次数 (默认 2) */
  maxRetries?: number
  /** 重试退避基数 ms (默认 400) */
  retryBackoffMs?: number
}

export type ImageJob = ImageJobOptions & {
  id: string
  status: JobStatus
  progress: number // 0..100
  createdAt: number
  startedAt?: number
  finishedAt?: number
  attempt: number // 已尝试次数 (0 开始)
  maxRetries: number
  retryBackoffMs: number
  error?: string
  result?: unknown
  grade?: ModelRequestGrade
  downgraded: boolean
  warning?: string
  effectiveModel: string
}

export type QueueEventType = 'queued' | 'progress' | 'retry' | 'done' | 'failed' | 'cancelled'

export type QueueEvent = {
  type: QueueEventType
  jobId: string
  progress: number
  status: JobStatus
  message?: string
  attempt?: number
  data?: unknown
}

export type JobHandler = (job: ImageJob, ctx: { onProgress: (p: number, msg?: string) => void; signal: AbortSignal }) => Promise<unknown>

export type QueueOptions = {
  /** 并发度，默认 1 串行 */
  concurrency?: number
  /** 默认最大重试 */
  defaultMaxRetries?: number
  /** 默认退避 ms */
  defaultBackoffMs?: number
}

function genId(): string {
  // 轻量 id，无需 uuid 依赖
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isRetryableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  // 可重试: 429/5xx/超时/网络/oom/cuda 显存瞬时错误
  if (/429|too many requests/.test(msg)) return true
  if (/5\d{2}/.test(msg) && /50[02349]/.test(msg)) return true
  if (/timeout|timed out|abort|aborted|econnreset|econnrefused|network|fetch failed/.test(msg)) return true
  if (/cuda|vulkan|gpu|out of memory|oom|ggml.*failed/.test(msg)) return true
  // 明确不可重试: 400/401/403/404/校验错误
  if (/400|401|403|404|invalid|bad request|validation|prompt is required/.test(msg) && !/oom/.test(msg)) {
    // 若同时含 retryable 关键词则仍可重试 (如 cuda 400)
    if (/cuda|oom|gpu/.test(msg)) return true
    return false
  }
  // 默认: 5xx 已覆盖，其余视为可重试一次 (幂等生成可安全重试)
  // 为保守起见，仅对显式可重试返回 true，其余 false
  return false
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
  })
}

// SSE helpers — 纯函数，可直接用于 http Response
export function formatSseEvent(event: string, data: unknown): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data)
  // SSE 规范为 event + data 行；简化为 event+data 单行 JSON 更易解析
  return `event: ${event}\ndata: ${payload}\n\n`
}

export function formatQueueSse(event: QueueEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
}

// ---------------------------------------------------------------------------
// ImageQueue
// ---------------------------------------------------------------------------

/** 终态 job (done/failed/cancelled) 在队列中保留的上限，超出部分于微任务内 prune；保留项供 SSE 补发 */
const MAX_RETAINED_COMPLETED_JOBS = 100

export class ImageQueue {
  private jobs = new Map<string, ImageJob>()
  private queue: string[] = [] // jobIds FIFO
  private running = 0
  private readonly concurrency: number
  private readonly defaultMaxRetries: number
  private readonly defaultBackoffMs: number
  private handler: JobHandler | null = null
  private listeners = new Set<(ev: QueueEvent) => void>()
  private abortControllers = new Map<string, AbortController>()

  constructor(opts: QueueOptions = {}) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1)
    this.defaultMaxRetries = opts.defaultMaxRetries ?? 2
    this.defaultBackoffMs = opts.defaultBackoffMs ?? 400
  }

  /** 注入实际执行器 (如调用 sd /generate) */
  setHandler(fn: JobHandler): void {
    this.handler = fn
  }

  /** 订阅 SSE/事件 — 返回取消函数 */
  subscribe(listener: (ev: QueueEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(ev: QueueEvent): void {
    for (const l of this.listeners) {
      try { l(ev) } catch { /* isolate */ }
    }
  }

  get pending(): number {
    return this.queue.length + this.running
  }

  get size(): number {
    return this.jobs.size
  }

  /** 当前活跃的事件订阅者数量（泄漏回归断言用） */
  get listenerCount(): number {
    return this.listeners.size
  }

  private pruneScheduled = false

  /** 在微任务内清理超出保留上限的终态 job，避免 jobs Map 无界增长 */
  private schedulePrune(): void {
    if (this.pruneScheduled) return
    this.pruneScheduled = true
    queueMicrotask(() => {
      this.pruneScheduled = false
      this.prune(MAX_RETAINED_COMPLETED_JOBS)
    })
  }

  getJob(id: string): ImageJob | undefined {
    return this.jobs.get(id)
  }

  listJobs(): ImageJob[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 入队 — 返回 jobId */
  enqueue(opts: ImageJobOptions): string {
    const id = genId()
    const grade = gradeModelRequest(opts.vramMB ?? null, opts.model)
    const job: ImageJob = {
      ...opts,
      id,
      status: 'queued',
      progress: 0,
      createdAt: Date.now(),
      attempt: 0,
      maxRetries: opts.maxRetries ?? this.defaultMaxRetries,
      retryBackoffMs: opts.retryBackoffMs ?? this.defaultBackoffMs,
      downgraded: grade.downgraded,
      warning: grade.warning,
      effectiveModel: grade.effectiveModel,
      grade,
    }
    // 若被降级且未显式指定模型，覆盖 model 为 effective
    if (grade.downgraded) {
      job.model = grade.effectiveModel
    }
    this.jobs.set(id, job)
    this.queue.push(id)
    this.emit({ type: 'queued', jobId: id, progress: 0, status: 'queued', message: grade.warning ?? grade.reason, data: { grade } })
    // 异步驱动
    queueMicrotask(() => this.pump())
    return id
  }

  cancel(jobId: string): boolean {
    const job = this.jobs.get(jobId)
    if (!job) return false
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return false
    // 若在队列中，移除
    const idx = this.queue.indexOf(jobId)
    if (idx !== -1) {
      this.queue.splice(idx, 1)
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      this.emit({ type: 'cancelled', jobId, progress: job.progress, status: 'cancelled', message: 'cancelled' })
      this.schedulePrune()
      return true
    }
    // 若正在运行，abort
    if (job.status === 'running') {
      const ctrl = this.abortControllers.get(jobId)
      ctrl?.abort()
      // 状态将在执行器 catch AbortError 后置为 cancelled
      return true
    }
    return false
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift()!
      const job = this.jobs.get(jobId)
      if (!job) continue
      if (job.status === 'cancelled') continue
      this.running += 1
      // 不 await，让并发跑；但 concurrency=1 时天然串行
      this.runJob(job).finally(() => {
        this.running = Math.max(0, this.running - 1)
        this.emit({ type: 'progress', jobId: job.id, progress: job.progress, status: job.status, message: 'queue tick' })
        // runJob 的所有终态 (done/failed/cancelled) 都会走到这里：微任务内 prune 防止 jobs Map 无界增长
        this.schedulePrune()
        // 驱动下一个
        queueMicrotask(() => this.pump())
      })
    }
  }

  private async runJob(job: ImageJob): Promise<void> {
    job.status = 'running'
    job.startedAt = Date.now()
    job.progress = 1
    const ctrl = new AbortController()
    this.abortControllers.set(job.id, ctrl)
    this.emit({ type: 'progress', jobId: job.id, progress: 1, status: 'running', message: 'start' })

    const onProgress = (p: number, msg?: string): void => {
      const clamped = Math.max(0, Math.min(100, Math.round(p)))
      job.progress = clamped
      this.emit({ type: 'progress', jobId: job.id, progress: clamped, status: 'running', message: msg ?? `progress ${clamped}%` })
    }

    const handler = this.handler ?? (async (j, ctx) => {
      // 默认模拟: 延迟 50ms 返回 prompt 回显，避免无 handler 时卡死
      await sleep(20, ctx.signal)
      ctx.onProgress(50, 'half')
      await sleep(20, ctx.signal)
      ctx.onProgress(100, 'done')
      return { b64: 'mock', prompt: j.prompt, effectiveModel: j.effectiveModel }
    })

    let lastError: unknown = null
    for (let attempt = 0; attempt <= job.maxRetries; attempt++) {
      job.attempt = attempt
      if (ctrl.signal.aborted) {
        job.status = 'cancelled'
        job.finishedAt = Date.now()
        this.emit({ type: 'cancelled', jobId: job.id, progress: job.progress, status: 'cancelled', message: 'aborted' })
        this.abortControllers.delete(job.id)
        return
      }
      try {
        const result = await handler(job, { onProgress, signal: ctrl.signal })
        job.result = result
        job.status = 'done'
        job.progress = 100
        job.finishedAt = Date.now()
        this.emit({ type: 'done', jobId: job.id, progress: 100, status: 'done', message: 'done', data: result })
        this.abortControllers.delete(job.id)
        return
      } catch (e) {
        lastError = e
        const aborted = (e as DOMException)?.name === 'AbortError' || ctrl.signal.aborted || String((e as Error).message ?? '').toLowerCase().includes('aborted')
        if (aborted) {
          job.status = 'cancelled'
          job.finishedAt = Date.now()
          this.emit({ type: 'cancelled', jobId: job.id, progress: job.progress, status: 'cancelled', message: 'aborted' })
          this.abortControllers.delete(job.id)
          return
        }
        const canRetry = attempt < job.maxRetries && isRetryableError(e)
        if (canRetry) {
          const backoff = job.retryBackoffMs * Math.pow(2, attempt)
          this.emit({ type: 'retry', jobId: job.id, progress: job.progress, status: 'running', message: `retry ${attempt + 1}/${job.maxRetries}: ${(e as Error).message}`, attempt: attempt + 1 })
          try {
            await sleep(backoff, ctrl.signal)
          } catch (abortErr) {
            job.status = 'cancelled'
            job.finishedAt = Date.now()
            this.emit({ type: 'cancelled', jobId: job.id, progress: job.progress, status: 'cancelled', message: 'aborted during backoff' })
            this.abortControllers.delete(job.id)
            return
          }
          continue
        }
        job.error = (e as Error).message ?? String(e)
        job.status = 'failed'
        job.finishedAt = Date.now()
        this.emit({ type: 'failed', jobId: job.id, progress: job.progress, status: 'failed', message: job.error, attempt })
        this.abortControllers.delete(job.id)
        return
      }
    }
    // 耗尽重试仍失败 (兜底)
    job.error = (lastError as Error)?.message ?? String(lastError)
    job.status = 'failed'
    job.finishedAt = Date.now()
    this.emit({ type: 'failed', jobId: job.id, progress: job.progress, status: 'failed', message: job.error })
    this.abortControllers.delete(job.id)
  }

  /** 等待指定 job 结束 (done/failed/cancelled) */
  async waitFor(jobId: string, timeoutMs = 30_000): Promise<ImageJob> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`job ${jobId} not found`)
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return job
    return new Promise<ImageJob>((resolve, reject) => {
      const t = setTimeout(() => { unsub(); reject(new Error(`waitFor ${jobId} timeout ${timeoutMs}ms`)) }, timeoutMs)
      const unsub = this.subscribe((ev) => {
        if (ev.jobId !== jobId) return
        if (ev.type === 'done' || ev.type === 'failed' || ev.type === 'cancelled') {
          clearTimeout(t)
          unsub()
          resolve(this.jobs.get(jobId)!)
        }
      })
    })
  }

  /** 等待队列排空 */
  async drain(timeoutMs = 30_000): Promise<void> {
    if (this.pending === 0) return
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { clearInterval(poll); unsub(); reject(new Error(`drain timeout ${timeoutMs}ms`)) }, timeoutMs)
      const poll = setInterval(() => {
        if (this.pending === 0) { clearTimeout(t); clearInterval(poll); unsub(); resolve() }
      }, 10)
      const unsub = this.subscribe(() => {
        if (this.pending === 0) { clearTimeout(t); clearInterval(poll); unsub(); resolve() }
      })
      // 兜底: 若已空
      if (this.pending === 0) { clearTimeout(t); clearInterval(poll); unsub(); resolve() }
    })
  }

  /** 创建 SSE Response — 订阅队列事件流，适合 http  handler 返回 */
  toSseResponse(jobId?: string): Response {
    const queue = this
    let hb: ReturnType<typeof setInterval> | null = null
    let unsub: (() => void) | null = null
    // 幂等清理：stream cancel / 写入已关闭流 时移除订阅与心跳，杜绝监听器残留
    const cleanup = (): void => {
      if (hb) { clearInterval(hb); hb = null }
      if (unsub) { unsub(); unsub = null }
    }
    const stream = new ReadableStream<string>({
      start(controller) {
        const send = (ev: QueueEvent): void => {
          if (jobId && ev.jobId !== jobId) return
          try { controller.enqueue(formatQueueSse(ev)) } catch { cleanup() /* closed */ }
        }
        // 立即推送当前 job 快照
        if (jobId) {
          const j = queue.getJob(jobId)
          if (j) send({ type: 'progress', jobId, progress: j.progress, status: j.status, message: j.warning ?? j.grade?.reason })
        } else {
          for (const j of queue.listJobs()) {
            send({ type: 'progress', jobId: j.id, progress: j.progress, status: j.status, message: j.status })
          }
        }
        unsub = queue.subscribe(send)
        // 心跳
        hb = setInterval(() => {
          try { controller.enqueue(`: keep-alive ${Date.now()}\n\n`) } catch { cleanup() }
        }, 15_000)
      },
      cancel() {
        cleanup()
      },
    })
    // 包装为 Response
    return new Response(stream as unknown as ReadableStream, { status: 200, headers: sseHeaders() })
  }

  /** 创建针对单 job 的 SSE Response 快捷方法 */
  sseForJob(jobId: string): Response {
    return this.toSseResponse(jobId)
  }

  /** 清空已完成任务 (done/failed/cancelled) — 可选保留最近 N 条。
   *  finishedAt 仅毫秒精度，同刻完成的 tie 用 Map 插入序兜底，确保删的是最旧的 */
  prune(keepRecent = 20): number {
    const terminal: Array<{ job: ImageJob; seq: number }> = []
    let seq = 0
    for (const j of this.jobs.values()) {
      if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') {
        terminal.push({ job: j, seq })
      }
      seq += 1
    }
    if (terminal.length <= keepRecent) return 0
    const toRemove = terminal
      .sort((a, b) => (a.job.finishedAt ?? 0) - (b.job.finishedAt ?? 0) || a.seq - b.seq)
      .slice(0, terminal.length - keepRecent)
    for (const { job } of toRemove) this.jobs.delete(job.id)
    return toRemove.length
  }
}

// 单例 (进程级)
export const defaultImageQueue = new ImageQueue({ concurrency: 1, defaultMaxRetries: 2, defaultBackoffMs: 400 })

// ---------------------------------------------------------------------------
// 便捷: 将 ImageQueue 挂到 fetch-style handler
// ---------------------------------------------------------------------------

export function createImageQueueHandler(queue: ImageQueue = defaultImageQueue): (req: Request) => Response | Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const pathname = url.pathname
    // GET /api/image/queue -> 列表
    if (pathname === '/api/image/queue' && req.method === 'GET') {
      return new Response(JSON.stringify({ jobs: queue.listJobs(), pending: queue.pending }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    // GET /api/image/queue/:id
    const m = pathname.match(/^\/api\/image\/queue\/([^/]+)$/)
    if (m && req.method === 'GET') {
      const job = queue.getJob(m[1]!)
      if (!job) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify(job), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // GET /api/image/queue/:id/stream  SSE
    const ms = pathname.match(/^\/api\/image\/queue\/([^/]+)\/stream$/)
    if (ms && req.method === 'GET') {
      const job = queue.getJob(ms[1]!)
      if (!job) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      return queue.sseForJob(ms[1]!)
    }
    // GET /api/image/queue/stream  全局 SSE
    if (pathname === '/api/image/queue/stream' && req.method === 'GET') {
      return queue.toSseResponse()
    }
    // POST /api/image/generate -> enqueue (兼容 /v1/images 由上游转调)
    if ((pathname === '/api/image/generate' || pathname === '/v1/images/generations') && req.method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = await req.json() as Record<string, unknown> } catch { return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } }) }
      const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string).trim() : ''
      if (!prompt) return new Response(JSON.stringify({ error: 'prompt is required' }), { status: 400, headers: { 'content-type': 'application/json' } })
      const jobId = queue.enqueue({
        prompt,
        negative_prompt: typeof body['negative_prompt'] === 'string' ? body['negative_prompt'] as string : undefined,
        width: body['width'] != null ? Number(body['width']) : (typeof body['size'] === 'string' ? Number(String(body['size']).split('x')[0]) : undefined),
        height: body['height'] != null ? Number(body['height']) : (typeof body['size'] === 'string' ? Number(String(body['size']).split('x')[1]) : undefined),
        steps: body['steps'] != null ? Number(body['steps']) : undefined,
        seed: body['seed'] != null ? Number(body['seed']) : undefined,
        model: typeof body['model'] === 'string' ? body['model'] as string : undefined,
        vramMB: body['vramMB'] != null ? Number(body['vramMB']) : undefined,
        maxRetries: body['maxRetries'] != null ? Number(body['maxRetries']) : undefined,
      })
      const job = queue.getJob(jobId)!
      return new Response(JSON.stringify({ jobId, status: job.status, warning: job.warning, effectiveModel: job.effectiveModel, grade: job.grade }), {
        status: 202, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
}

export default ImageQueue
