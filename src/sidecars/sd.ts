/**
 * sd sidecar — wraps stable-diffusion.cpp `sd-server` (single binary HTTP
 * server) as a SidecarManager child.
 *
 * Spec (Todo 20 / Wave5 T20, 阶段0 校准 upstream master-841):
 * - Binary: `sd-server`（旧名 sd-cli，无 server 模式；override via SD_BIN env or constructor bin）
 * - Host: 127.0.0.1, Port: 11436 (SD_PORT) — argv `--listen-ip` / `--listen-port`
 *   (upstream sd-server 实测参数；旧 `--host/--port` 仅存在于本仓早期设想)
 * - Model REQUIRED at spawn (common.cpp: model_path/diffusion_model required) —
 *   执行器始终先解析模型再 ensureSidecar('sd', {modelPath})
 * - Health: http://127.0.0.1:11436/health  (SidecarManager 5s pulse, 3 fails -> restart)
 * - Generate: POST http://127.0.0.1:11436/generate  (queued, serialized)
 * - GGUF 量化: modelPath + quantization (q4_0/q4_1/q5_0/q5_1/q8_0/f16/f32) 透传
 * - CPU 回退: --cpu / --device cpu 兜底，GPU 失败时可重试
 * - Queue: 进程内串行队列，避免并发压爆显存
 * - Logs: logs/sidecar-sd.log via SidecarManager (rotation 5MiB -> .1)
 * - Isolation: spawned sidecar only; MIT (sd.cpp) — No AGPL linking.
 * - Reuse: SidecarManager (spawn/health/logs), ISidecar/IImageBackend contracts.
 */

import * as path from 'path'

import { SidecarManager, type SidecarManagerOptions } from '../core/SidecarManager'
import type { ISidecar } from '../core/types'

// ---------------------------------------------------------------------------
// Constants — must be 127.0.0.1 per security baseline
// ---------------------------------------------------------------------------

export const SD_NAME = 'sd' as const
export const SD_HOST = '127.0.0.1' as const
export const SD_PORT = 11436 as const
/**
 * sd-server（upstream master-841）无 /health；健康探针改用 OpenAI 兼容
 * GET /v1/models（200 即存活）。旧 /generate 端点同样不存在，生成走
 * 原生异步任务 API（POST /sdcpp/v1/img_gen + GET /sdcpp/v1/jobs/{id}）。
 */
export const SD_HEALTH_URL = `http://${SD_HOST}:${SD_PORT}/v1/models` as const
/** 旧同步端点（已废弃，仅保留常量兼容外部引用） */
export const SD_GENERATE_URL = `http://${SD_HOST}:${SD_PORT}/generate` as const
/** 原生异步任务 API（api.md §POST /sdcpp/v1/img_gen） */
export const SD_IMG_GEN_URL = `http://${SD_HOST}:${SD_PORT}/sdcpp/v1/img_gen` as const
export const SD_LOG_FILE = `sidecar-${SD_NAME}.log` as const
export const DEFAULT_SD_BIN = 'sd-server' as const

/** Supported GGUF quantization / weight types for sd.cpp GGUF models. */
export const SD_QUANTIZATIONS = ['f32', 'f16', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_0'] as const
export type SdQuantization = (typeof SD_QUANTIZATIONS)[number]

/** Quick check helper */
export function isValidSdQuantization(v: string): v is SdQuantization {
  return (SD_QUANTIZATIONS as readonly string[]).includes(v)
}

/**
 * LoRA apply modes per leejet/stable-diffusion.cpp docs/lora.md (verified
 * 2026-09-03 via raw.githubusercontent + Appendix R3 §A row 18/20):
 * `--lora-apply-mode immediately|at_runtime`; `auto` = sd.cpp picks
 * at_runtime when weights contain quantized params, else immediately.
 */
export const SD_LORA_APPLY_MODES = ['immediately', 'at_runtime', 'auto'] as const
export type SdLoraApplyMode = (typeof SD_LORA_APPLY_MODES)[number]

export function isValidSdLoraApplyMode(v: string): v is SdLoraApplyMode {
  return (SD_LORA_APPLY_MODES as readonly string[]).includes(v)
}

/** True for GGUF quantized weight hints (everything except f32/f16). */
function isQuantizedWeight(q: SdQuantization | undefined): boolean {
  return q !== undefined && q !== 'f32' && q !== 'f16'
}

/** One LoRA selection: file stem inside --lora-model-dir + strength 0..2. */
export type SdLoraTag = {
  name: string
  scale: number
}

/** Snap a scale to the [0,2] range on a 0.05 grid; NaN defaults to 1 (A1111 parity). */
function clampLoraScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  const clamped = Math.min(2, Math.max(0, scale))
  return Number((Math.round(clamped / 0.05) * 0.05).toFixed(2))
}

/**
 * A1111-style prompt tag builder — sd.cpp applies LoRAs through prompt tags
 * `<lora:name:weight>` (docs/lora.md example `-p "a lovely cat<lora:marblesh:1>"`,
 * Appendix R3 §A row 18/20). Each tag is followed by one space; invalid/empty
 * names are skipped, tag-breaking characters (<> and whitespace) are replaced
 * with '_'. Returns '' for an empty selection so it is safe to prefix anywhere.
 */
export function buildLoraPromptTags(loras: readonly SdLoraTag[]): string {
  let out = ''
  for (const lora of loras) {
    const name = lora.name.trim().replace(/[\s<>]/g, '_')
    if (!name) continue
    out += `<lora:${name}:${clampLoraScale(lora.scale)}> `
  }
  return out
}

// ---------------------------------------------------------------------------
// Bin resolver
// ---------------------------------------------------------------------------

export function resolveSdBin(explicit?: string): string {
  if (explicit) return explicit
  const env = (typeof process !== 'undefined' ? process.env['SD_BIN'] : undefined) as string | undefined
  if (env && env.trim()) return env.trim()
  return DEFAULT_SD_BIN
}

// ---------------------------------------------------------------------------
// Args builder
// ---------------------------------------------------------------------------

export type BuildSdArgsOptions = {
  /** Absolute or relative path to diffusion GGUF / safetensors model. */
  modelPath?: string
  /** VAE model path (optional). */
  vaePath?: string
  /** GGUF quantization hint — validated against SD_QUANTIZATIONS; passed as --weight-type. */
  quantization?: SdQuantization
  /** Force CPU backend (sd.cpp --cpu). Used for fallback. */
  cpuFallback?: boolean
  /** Device override: 'cpu' | 'cuda' | 'vulkan' — defaults inferred from cpuFallback. */
  device?: 'cpu' | 'cuda' | 'vulkan'
  /** Override host (must stay 127.0.0.1). */
  host?: string
  /** Override port (default 11436). */
  port?: number
  /** Threads for CPU mode. */
  threads?: number
  /**
   * Directory holding LoRA safetensors/ckpt files -> `--lora-model-dir <dir>`
   * (leejet/stable-diffusion.cpp docs/lora.md, Appendix R3 §A row 18/20).
   */
  loraModelDir?: string
  /**
   * `--lora-apply-mode`. Unset + quantized weights -> at_runtime (the upstream
   * auto rule, made explicit for our default); unset + f16/f32/none -> omitted,
   * sd.cpp auto-selects immediately.
   */
  loraApplyMode?: SdLoraApplyMode
  /** Extra passthrough args appended as-is. */
  extraArgs?: string[]
}

export function buildSdArgs(opts: BuildSdArgsOptions = {}): string[] {
  const host = opts.host ?? SD_HOST
  const port = opts.port ?? SD_PORT

  if (host !== SD_HOST) {
    throw new Error(`sd sidecar host must be ${SD_HOST}, got ${host}`)
  }
  if (port < 1024 || port > 65535) throw new Error(`port out of range: ${port}`)

  if (opts.quantization !== undefined && !isValidSdQuantization(opts.quantization)) {
    throw new Error(`invalid sd quantization: ${opts.quantization} — allowed: ${SD_QUANTIZATIONS.join(', ')}`)
  }
  if (opts.device !== undefined && !['cpu', 'cuda', 'vulkan'].includes(opts.device)) {
    throw new Error(`invalid sd device: ${opts.device}`)
  }
  if (opts.loraApplyMode !== undefined && !isValidSdLoraApplyMode(opts.loraApplyMode)) {
    throw new Error(`invalid sd lora-apply-mode: ${opts.loraApplyMode} — allowed: ${SD_LORA_APPLY_MODES.join(', ')}`)
  }

  // sd-server HTTP 模式：--listen-ip / --listen-port（upstream master-841 实测）
  const args: string[] = ['--listen-ip', host, '--listen-port', String(port)]

  if (opts.modelPath) {
    // sd.cpp commonly uses --model or --diffusion-model; expose as --model
    args.push('--model', opts.modelPath)
  }
  if (opts.vaePath) {
    args.push('--vae', opts.vaePath)
  }
  if (opts.quantization) {
    // sd.cpp weight type flag
    args.push('--weight-type', opts.quantization)
  }

  // LoRA (docs/lora.md): dir + apply mode. Quantized defaults to at_runtime —
  // the same rule upstream's `auto` applies; we pin it so the argv is explicit.
  if (opts.loraModelDir) {
    args.push('--lora-model-dir', opts.loraModelDir)
  }
  const loraMode = opts.loraApplyMode ?? (opts.loraModelDir && isQuantizedWeight(opts.quantization) ? 'at_runtime' : undefined)
  if (loraMode !== undefined) {
    args.push('--lora-apply-mode', loraMode)
  }

  // CPU fallback / device selection
  const wantCpu = opts.cpuFallback === true || opts.device === 'cpu'
  if (wantCpu) {
    args.push('--cpu')
  } else if (opts.device) {
    // explicit device flag (sd.cpp --device cuda/vulkan)
    args.push('--device', opts.device)
  }

  if (opts.threads !== undefined) {
    if (!Number.isInteger(opts.threads) || opts.threads < 1) throw new Error(`threads must be >=1, got ${opts.threads}`)
    args.push('--threads', String(opts.threads))
  }

  if (opts.extraArgs?.length) {
    args.push(...opts.extraArgs)
  }

  return args
}

/** Build args with forced CPU fallback — convenience for retry path. */
export function buildSdCpuFallbackArgs(opts: BuildSdArgsOptions = {}): string[] {
  return buildSdArgs({ ...opts, cpuFallback: true, device: 'cpu' })
}

/** 旧同步端点 URL（已废弃，保留兼容） */
export function getGenerateUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}/generate`
}

export function getHealthUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}/v1/models`
}

export function getImgGenUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}/sdcpp/v1/img_gen`
}

export function getJobUrl(port: number = SD_PORT, jobId: string): string {
  return `http://${SD_HOST}:${port}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`
}

// ---------------------------------------------------------------------------
// Sidecar factory — returns a configured SidecarManager
// ---------------------------------------------------------------------------

export type CreateSdOptions = BuildSdArgsOptions & {
  /** Override binary (defaults to SD_BIN env or sd-cli). */
  bin?: string
  /** Override log directory (SidecarManager default: <cwd>/logs). */
  logDir?: string
  /** Forward extra SidecarManagerOptions (spawner/fetcher/fsDeps/healthIntervalMs...). */
  managerOptions?: Omit<SidecarManagerOptions, 'logDir'>
}

export function createSdSidecarConfig(opts: CreateSdOptions = {}): ISidecar & { modelPath?: string; quantization?: SdQuantization } {
  const bin = resolveSdBin(opts.bin)
  const port = opts.port ?? SD_PORT
  const args = buildSdArgs(opts)
  const healthUrl = getHealthUrl(port)
  const cfg: ISidecar & { modelPath?: string; quantization?: SdQuantization } = {
    name: SD_NAME,
    bin,
    args,
    port,
    healthUrl,
  }
  if (opts.modelPath) cfg.modelPath = opts.modelPath
  if (opts.quantization) cfg.quantization = opts.quantization
  return cfg
}

/**
 * Create a SidecarManager wired for sd.cpp sd-cli.
 * - healthUrl is always http://127.0.0.1:<port>/health
 * - logs to logs/sidecar-sd.log (via SidecarManager's <logDir>/sidecar-sd.log)
 * - caller controls lifecycle: start()/stop()/restart()/healthCheck()
 */
export function createSdSidecar(opts: CreateSdOptions = {}): SidecarManager {
  const config = createSdSidecarConfig(opts)
  const logDir = opts.logDir ?? path.join(process.cwd(), 'logs')
  const mgrOpts: SidecarManagerOptions = {
    logDir,
    ...(opts.managerOptions ?? {}),
  }
  return new SidecarManager(config, mgrOpts)
}

// ---------------------------------------------------------------------------
// Queue — serializes POST /generate to avoid VRAM contention
// ---------------------------------------------------------------------------

export class SdQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private _pending = 0
  private _totalEnqueued = 0

  get pending(): number {
    return this._pending
  }
  get totalEnqueued(): number {
    return this._totalEnqueued
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this._pending += 1
    this._totalEnqueued += 1
    const cur = this.tail.then(() => fn())
    // keep chain alive even if cur rejects; also decrement pending exactly once
    this.tail = cur
      .catch(() => {})
      .finally(() => {
        this._pending = Math.max(0, this._pending - 1)
      }) as Promise<unknown>
    // attach pending decrement to returned promise as well for correct ordering in tests
    // (tail's finally runs after cur settles, so pending reflects queue depth)
    return cur
  }

  /** Wait until queue drains (for tests / shutdown). */
  async drain(): Promise<void> {
    await this.tail
  }
}

// Global default queue (per-process). SdSidecar uses its own instance.
export const defaultSdQueue = new SdQueue()

// ---------------------------------------------------------------------------
// Generate types — sd.cpp /generate JSON shape
// ---------------------------------------------------------------------------

export type SdGenerateRequest = {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  sampler?: string
  batch_count?: number
  /**
   * LoRA selections folded into prompt tags by toGenerateBody BEFORE the POST
   * (sd.cpp applies LoRAs via `<lora:name:w>` prompt tags + --lora-model-dir
   * server flag — Appendix R3 §A row 18/20, docs/lora.md). Never sent as a
   * body key: the sd-cli /generate parser ignores/derives on unknown fields.
   */
  loras?: SdLoraTag[]
  /**
   * img2img/inpaint (sd.cpp verified CLI flags `--init-img`/`--mask`/`--strength`
   * per Appendix R3 §A row 18/20 — `--init-image` is a typo, not a real flag).
   * Channel decision: transported via the /generate JSON body as snake_case
   * mirrors of those flags (toGenerateBody); if a future sd-cli body branch
   * drops them, the fallback is an argv sidecar restart with the same names.
   */
  initImagePath?: string
  maskPath?: string
  strength?: number
  // passthrough
  [key: string]: unknown
}

export type SdGenerateResponse = {
  /** PNG as base64 (no data: prefix) or array of b64s for batch. */
  image?: string
  images?: string[]
  /** Alternative: file path returned by sd-cli. */
  path?: string
  /** Seed actually used */
  seed?: number
  /** Raw passthrough */
  [key: string]: unknown
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init)
}

function isGpuErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase()
  return (
    lower.includes('cuda') ||
    lower.includes('vulkan') ||
    lower.includes('gpu') ||
    lower.includes('out of memory') ||
    lower.includes('oom') ||
    lower.includes('ggml') && lower.includes('failed')
  )
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Build the native img_gen request body (api.md §POST /sdcpp/v1/img_gen):
 * - steps/cfg_scale/sampler 折叠进 `sample_params`（sample_steps / txt_cfg /
 *   sample_method）；
 * - `loras` 仍以 A1111 `<lora:name:w>` prompt 标签携带（server --lora-model-dir
 *   侧加载）；native `lora[] {path, multiplier}` 路径解析在模型页 LoRA 集成时升级；
 * - initImagePath/maskPath 不进 body（文件读取在 generateImage 中转 base64）。
 */
export function toGenerateBody(req: SdGenerateRequest): Record<string, unknown> {
  const { loras, steps, cfg_scale, sampler, initImagePath: _init, maskPath: _mask, ...rest } = req
  const body: Record<string, unknown> = { ...rest }
  const sampleParams: Record<string, unknown> = {}
  if (steps !== undefined) sampleParams['sample_steps'] = steps
  if (sampler !== undefined) sampleParams['sample_method'] = sampler
  if (cfg_scale !== undefined) sampleParams['guidance'] = { txt_cfg: cfg_scale }
  if (Object.keys(sampleParams).length > 0) body['sample_params'] = sampleParams
  if (loras && loras.length > 0) {
    body['prompt'] = buildLoraPromptTags(loras) + String(rest.prompt ?? '')
  }
  return body
}

/** 原生异步任务句柄（POST /sdcpp/v1/img_gen 响应） */
export type SdJobSubmit = {
  id?: string
  kind?: string
  poll_url?: string
  status?: string
  queue_position?: number
  [key: string]: unknown
}

/** 原生任务状态（GET /sdcpp/v1/jobs/{id} 响应的子集） */
export type SdJobStatus = {
  id?: string
  status?: string
  error?: string | null
  queue_position?: number
  result?: { images?: Array<{ b64_json?: string; dataURL?: string }>; [key: string]: unknown }
  [key: string]: unknown
}

export type FsReadLike = (path: string) => Buffer

function defaultFsRead(path: string): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs')
  return fs.readFileSync(path)
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function isAbortErr(e: unknown): boolean {
  return (e as DOMException)?.name === 'AbortError'
}

/**
 * Generate via the native async job API (POST /sdcpp/v1/img_gen → poll job →
 * b64 PNG). Replaces the legacy sync POST /generate which upstream sd-server
 * (master-841) no longer exposes. Throws on submit failure / job failure.
 * `signal` aborts polling and best-effort cancels the queued job
 * (features.cancel_queued).
 */
export async function generateImage(
  req: SdGenerateRequest,
  opts: {
    port?: number
    fetchImpl?: FetchLike
    signal?: AbortSignal
    headers?: Record<string, string>
    fsRead?: FsReadLike
    /** 轮询间隔 ms（默认 800） */
    pollMs?: number
  } = {},
): Promise<SdGenerateResponse> {
  if (!req.prompt || !req.prompt.trim()) throw new Error('prompt is required')
  const doFetch: FetchLike = opts.fetchImpl ?? defaultFetch
  const fsRead = opts.fsRead ?? defaultFsRead
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }

  const body = toGenerateBody(req)
  if (req.initImagePath !== undefined) {
    body['init_image'] = fsRead(req.initImagePath).toString('base64')
  }
  if (req.maskPath !== undefined) {
    body['mask_image'] = fsRead(req.maskPath).toString('base64')
  }

  const submit = await doFetch(getImgGenUrl(opts.port), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  const submitText = await submit.text().catch(() => '')
  if (!submit.ok) {
    throw new Error(`sd img_gen submit failed ${submit.status} ${submit.statusText} ${submitText}`.trim())
  }
  let job: SdJobSubmit
  try {
    job = JSON.parse(submitText) as SdJobSubmit
  } catch {
    throw new Error('sd img_gen submit returned non-JSON body')
  }
  // 兼容同步应答（少数构建直接 200 + images）
  const directImages = (job as { images?: string[] })['images']
  if (Array.isArray(directImages) && directImages.length > 0) {
    return { image: directImages[0], images: directImages }
  }
  const jobId = job.id
  if (jobId === undefined) throw new Error('sd img_gen submit missing job id')

  const pollUrl = getJobUrl(opts.port, jobId)
  const pollMs = opts.pollMs ?? 800
  const cancelJob = (): void => {
    // best-effort：取消排队任务（features.cancel_queued）；运行中任务上游无法取消
    void doFetch(pollUrl, { method: 'DELETE', headers: opts.headers }).catch(() => {})
  }
  for (;;) {
    // 先查一次再等待：已完成的短任务零延迟返回，也兼容 fake-timer 测试环境
    let st: SdJobStatus
    try {
      const res = await doFetch(pollUrl, { headers: opts.headers, signal: opts.signal })
      if (!res.ok) throw new Error(`sd job poll failed ${res.status} ${res.statusText}`)
      st = (await res.json()) as SdJobStatus
    } catch (e) {
      if (isAbortErr(e)) cancelJob()
      throw e
    }
    if (st.status === 'failed' || (typeof st.error === 'string' && st.error !== '')) {
      throw new Error(`sd job failed: ${st.error ?? 'unknown error'}`)
    }
    if (st.status === 'cancelled') {
      throw new DOMException('Aborted', 'AbortError')
    }
    const imgs = st.result?.images?.map((it) => it.b64_json ?? it.dataURL ?? '').filter((s) => s !== '') ?? []
    if (st.status === 'done' || imgs.length > 0) {
      if (imgs.length === 0) throw new Error('sd job finished without images')
      return { image: imgs[0], images: imgs }
    }
    // queued/running → 等待后继续轮询
    try {
      await sleepMs(pollMs, opts.signal)
    } catch (e) {
      if (isAbortErr(e)) cancelJob()
      throw e
    }
  }
}

/**
 * Queued variant — serializes via provided queue (default: defaultSdQueue).
 */
export function generateImageQueued(
  req: SdGenerateRequest,
  opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal; queue?: SdQueue; headers?: Record<string, string> } = {},
): Promise<SdGenerateResponse> {
  const q = opts.queue ?? defaultSdQueue
  return q.enqueue(() => generateImage(req, { port: opts.port, fetchImpl: opts.fetchImpl, signal: opts.signal, headers: opts.headers }))
}

/**
 * Generate with CPU fallback — on GPU-like failure, retry once via fallbackFetch.
 * fallbackFetch is typically a fetch bound to a CPU-sidecar port or same port with retry.
 * If no fallbackFetch supplied, still retries once after a brief delay (same endpoint).
 */
export async function generateWithCpuFallback(
  req: SdGenerateRequest,
  opts: {
    port?: number
    fetchImpl?: FetchLike
    fallbackFetchImpl?: FetchLike
    fallbackPort?: number
    signal?: AbortSignal
    queue?: SdQueue
  } = {},
): Promise<SdGenerateResponse> {
  const q = opts.queue
  const run = async (fetchImpl?: FetchLike, port?: number): Promise<SdGenerateResponse> => {
    const fn = () => generateImage(req, { port: port ?? opts.port, fetchImpl: fetchImpl ?? opts.fetchImpl, signal: opts.signal })
    return q ? q.enqueue(fn) : fn()
  }

  try {
    return await run(opts.fetchImpl, opts.port)
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    if (!isGpuErrorMessage(msg)) throw e
    // retry via fallback
    const fbFetch = opts.fallbackFetchImpl ?? opts.fetchImpl
    const fbPort = opts.fallbackPort ?? opts.port
    return run(fbFetch, fbPort)
  }
}

/**
 * Health probe — mirrors SidecarManager probe but standalone for tests/UI.
 */
export async function checkSdHealth(port: number = SD_PORT, fetchImpl?: FetchLike): Promise<boolean> {
  const url = getHealthUrl(port)
  const doFetch: FetchLike = fetchImpl ?? defaultFetch
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 2000)
  try {
    const res = await doFetch(url, { signal: ctrl.signal } as RequestInit)
    return (res as Response).ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Convenience wrapper — SdSidecar combines manager + queue + generate helpers
// ---------------------------------------------------------------------------

export class SdSidecar {
  readonly manager: SidecarManager
  readonly port: number
  readonly queue: SdQueue
  /** quantization hint (for diagnostics). */
  readonly quantization?: SdQuantization

  constructor(opts: CreateSdOptions = {}) {
    this.manager = createSdSidecar(opts)
    this.port = opts.port ?? SD_PORT
    this.queue = new SdQueue()
    this.quantization = opts.quantization
  }

  get config(): ISidecar {
    return this.manager.config
  }

  get logPath(): string {
    return this.manager.logPath
  }

  get generateUrl(): string {
    return getGenerateUrl(this.port)
  }

  get healthUrl(): string {
    return getHealthUrl(this.port)
  }

  /** Async: SidecarManager awaits port preflight before spawn (W0-2). */
  start(): Promise<void> {
    return this.manager.start()
  }

  stop(): void {
    this.manager.stop()
  }

  restart(): void {
    this.manager.restart()
  }

  getStatus(): ReturnType<SidecarManager['getStatus']> {
    return this.manager.getStatus()
  }

  isRunning(): boolean {
    return this.manager.isRunning()
  }

  /** Queued generate bound to this instance's port/queue. */
  async generate(req: SdGenerateRequest, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<SdGenerateResponse> {
    return generateImageQueued(req, { port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal, queue: this.queue })
  }

  /** Generate with CPU fallback (GPU error -> retry via fallback port/fetch). */
  async generateWithFallback(
    req: SdGenerateRequest,
    opts: { fetchImpl?: FetchLike; fallbackFetchImpl?: FetchLike; fallbackPort?: number; signal?: AbortSignal } = {},
  ): Promise<SdGenerateResponse> {
    return generateWithCpuFallback(req, {
      port: this.port,
      fetchImpl: opts.fetchImpl,
      fallbackFetchImpl: opts.fallbackFetchImpl,
      fallbackPort: opts.fallbackPort,
      signal: opts.signal,
      queue: this.queue,
    })
  }

  /** Raw (non-queued) generate — escapes queue, use sparingly. */
  async generateRaw(req: SdGenerateRequest, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<SdGenerateResponse> {
    return generateImage(req, { port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }
}

export default SdSidecar
