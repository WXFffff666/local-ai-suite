/**
 * sd sidecar — wraps `sd-cli` (stable-diffusion.cpp single binary) as a SidecarManager child.
 *
 * Spec (Todo 20 / Wave5 T20):
 * - Binary: `sd-cli` (override via SD_BIN env or constructor bin)
 * - Host: 127.0.0.1, Port: 11436 (SD_PORT)
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
export const SD_HEALTH_URL = `http://${SD_HOST}:${SD_PORT}/health` as const
export const SD_GENERATE_URL = `http://${SD_HOST}:${SD_PORT}/generate` as const
export const SD_LOG_FILE = `sidecar-${SD_NAME}.log` as const
export const DEFAULT_SD_BIN = 'sd-cli' as const

/** Supported GGUF quantization / weight types for sd.cpp GGUF models. */
export const SD_QUANTIZATIONS = ['f32', 'f16', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_0'] as const
export type SdQuantization = (typeof SD_QUANTIZATIONS)[number]

/** Quick check helper */
export function isValidSdQuantization(v: string): v is SdQuantization {
  return (SD_QUANTIZATIONS as readonly string[]).includes(v)
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

  // sd-cli server mode: bind host/port, quiet optional
  const args: string[] = ['--host', host, '--port', String(port)]

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

export function getGenerateUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}/generate`
}

export function getHealthUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}/health`
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
 * Raw POST /generate — no queue, no fallback.
 * Throws on non-2xx.
 */
export async function generateImage(
  req: SdGenerateRequest,
  opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<SdGenerateResponse> {
  if (!req.prompt || !req.prompt.trim()) throw new Error('prompt is required')
  const url = getGenerateUrl(opts.port)
  const doFetch: FetchLike = opts.fetchImpl ?? defaultFetch
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: JSON.stringify(req),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`sd /generate failed ${res.status} ${res.statusText} ${text}`.trim())
  }
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const json = (await res.json()) as SdGenerateResponse
    return json
  }
  // Some builds return raw PNG bytes — encode as b64
  const buf = await res.arrayBuffer().catch(() => null)
  if (buf && buf.byteLength > 0) {
    const b64 = Buffer.from(buf).toString('base64')
    return { image: b64, images: [b64] }
  }
  // fallback to text as b64-ish
  const text = await res.text().catch(() => '')
  if (text) return { image: text } as SdGenerateResponse
  throw new Error('sd /generate returned empty body')
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

  start(): void {
    this.manager.start()
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
