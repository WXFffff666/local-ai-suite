/**
 * llama sidecar — wraps llama.cpp `llama-server` as a SidecarManager child process.
 *
 * Spec (Todo 8 / Wave3 首项):
 * - Binary: `llama-server` (override via LLAMA_BIN env or constructor bin)
 * - Host: 127.0.0.1, Port: 11435 (from AppConfig llamaPort, DEFAULT 11435)
 * - Health: http://127.0.0.1:11435/health  (SidecarManager 5s pulse, 3 fails -> restart)
 * - Completion: POST http://127.0.0.1:11435/completion  SSE stream (data: {content, stop})
 * - Logs: logs/sidecar-llama.log via SidecarManager (rotation 5MiB -> .1)
 * - Isolation: spawned sidecar only; no AGPL linking into main process.
 * - Reuse: SidecarManager (spawn/health/logs), ISidecar/IModelProvider contracts.
 */

import * as fs from 'fs'
import * as path from 'path'

import { SidecarManager, type SidecarManagerOptions } from '../core/SidecarManager'
import type { IModelProvider, ISidecar } from '../core/types'

// ---------------------------------------------------------------------------
// Constants — must be 127.0.0.1 per security baseline
// ---------------------------------------------------------------------------

export const LLAMA_NAME = 'llama' as const
export const LLAMA_HOST = '127.0.0.1' as const
export const LLAMA_PORT = 11435 as const
export const LLAMA_HEALTH_URL = `http://${LLAMA_HOST}:${LLAMA_PORT}/health` as const
export const LLAMA_COMPLETION_URL = `http://${LLAMA_HOST}:${LLAMA_PORT}/completion` as const
export const LLAMA_LOG_FILE = `sidecar-${LLAMA_NAME}.log` as const
export const DEFAULT_CTX_SIZE = 4096 as const
export const DEFAULT_LLAMA_BIN = 'llama-server' as const

// ---------------------------------------------------------------------------
// Args builder
// ---------------------------------------------------------------------------

export type BuildLlamaArgsOptions = {
  /** Absolute or relative path to GGUF file. Required for real spawn. */
  modelPath?: string
  /**
   * todo21: multimodal projector (llama.cpp mtmd). Absolute path to an
   * existing .gguf file, paired by the registry via the mmproj-*.gguf
   * convention. Emitted as `--mmproj <path>` (== LLAMA_ARG_MMPROJ,
   * llama.cpp tools/server/README.md). Requires modelPath.
   */
  mmprojPath?: string
  /** Context window. Default 4096. */
  ctxSize?: number
  /** Override port (default 11435). Must match healthUrl port. */
  port?: number
  /** Override host (default 127.0.0.1). Must stay 127.0.0.1. */
  host?: string
  /**
   * todo39: serve the embeddings API (OpenAI-compatible /v1/embeddings +
   * native /embeddings). Emits `--embeddings` (== LLAMA_ARG_EMBEDDINGS).
   * Required for the RAG 'internal' embedding arm: a plain chat instance
   * answers /v1/embeddings with 4xx and the tri-state resolver never picks it.
   */
  embeddings?: boolean
  /**
   * todo39: enable the reranking endpoint (POST /v1/rerank). R3b LIVE anchor:
   * the endpoint EXISTS in llama.cpp but is DEFAULT-OFF — without this flag a
   * bge-reranker gguf still cannot rerank. Emits `--rerank` (== LLAMA_ARG_RERANKING).
   */
  rerank?: boolean
  /** Extra passthrough args appended as-is. */
  extraArgs?: string[]
  /** fs existence seam for mmprojPath validation (tests inject a fake). */
  fileExists?: (p: string) => boolean
}

export function buildLlamaArgs(opts: BuildLlamaArgsOptions = {}): string[] {
  const host = opts.host ?? LLAMA_HOST
  const port = opts.port ?? LLAMA_PORT
  const ctxSize = opts.ctxSize ?? DEFAULT_CTX_SIZE

  if (host !== LLAMA_HOST) {
    throw new Error(`llama sidecar host must be ${LLAMA_HOST}, got ${host}`)
  }

  const args: string[] = ['--host', host, '--port', String(port), '--ctx-size', String(ctxSize)]

  if (opts.modelPath) {
    args.push('--model', opts.modelPath)
  }

  if (opts.mmprojPath !== undefined) {
    if (!opts.modelPath) {
      throw new Error('mmprojPath requires modelPath (llama-server --mmproj is only valid with --model)')
    }
    if (!path.isAbsolute(opts.mmprojPath)) {
      throw new Error(`mmprojPath must be absolute, got ${opts.mmprojPath}`)
    }
    const exists: (p: string) => boolean = opts.fileExists ?? ((p) => fs.existsSync(p))
    if (!exists(opts.mmprojPath)) {
      throw new Error(`mmprojPath does not exist: ${opts.mmprojPath}`)
    }
    args.push('--mmproj', opts.mmprojPath)
  }

  if (opts.embeddings === true) {
    args.push('--embeddings')
  }
  if (opts.rerank === true) {
    args.push('--rerank')
  }

  if (opts.extraArgs?.length) {
    args.push(...opts.extraArgs)
  }

  return args
}

export function getCompletionUrl(port: number = LLAMA_PORT): string {
  return `http://${LLAMA_HOST}:${port}/completion`
}

export function getHealthUrl(port: number = LLAMA_PORT): string {
  return `http://${LLAMA_HOST}:${port}/health`
}

export function resolveLlamaBin(explicit?: string): string {
  if (explicit) return explicit
  const env = (typeof process !== 'undefined' ? process.env['LLAMA_BIN'] : undefined) as string | undefined
  if (env && env.trim()) return env.trim()
  return DEFAULT_LLAMA_BIN
}

// ---------------------------------------------------------------------------
// Sidecar factory — returns a configured SidecarManager
// ---------------------------------------------------------------------------

export type CreateLlamaOptions = BuildLlamaArgsOptions & {
  /** Override binary (defaults to LLAMA_BIN env or llama-server). */
  bin?: string
  /** Override log directory (SidecarManager default: <cwd>/logs). */
  logDir?: string
  /** Forward extra SidecarManagerOptions (spawner/fetcher/fsDeps/healthIntervalMs...). */
  managerOptions?: Omit<SidecarManagerOptions, 'logDir'>
}

export function createLlamaSidecarConfig(opts: CreateLlamaOptions = {}): ISidecar & Pick<IModelProvider, 'modelPath'> {
  const bin = resolveLlamaBin(opts.bin)
  const port = opts.port ?? LLAMA_PORT
  const args = buildLlamaArgs(opts)
  const healthUrl = getHealthUrl(port)
  const cfg: ISidecar & Pick<IModelProvider, 'modelPath'> = {
    name: LLAMA_NAME,
    bin,
    args,
    port,
    healthUrl,
  }
  if (opts.modelPath) cfg.modelPath = opts.modelPath
  return cfg
}

/**
 * Create a SidecarManager wired for llama.cpp.
 * - healthUrl is always http://127.0.0.1:<port>/health
 * - logs to logs/sidecar-llama.log (via SidecarManager's <logDir>/sidecar-llama.log)
 * - caller controls lifecycle: start()/stop()/restart()/healthCheck()
 */
export function createLlamaSidecar(opts: CreateLlamaOptions = {}): SidecarManager {
  const config = createLlamaSidecarConfig(opts)
  const logDir = opts.logDir ?? path.join(process.cwd(), 'logs')
  const mgrOpts: SidecarManagerOptions = {
    logDir,
    ...(opts.managerOptions ?? {}),
  }
  return new SidecarManager(config, mgrOpts)
}

// ---------------------------------------------------------------------------
// Completion types — llama.cpp /completion JSON shape
// ---------------------------------------------------------------------------

export type LlamaCompletionRequest = {
  prompt: string
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  n_predict?: number
  stop?: string[]
  // passthrough to llama.cpp
  [key: string]: unknown
}

export type LlamaCompletionChunk = {
  content: string
  stop: boolean
  // raw payload passthrough
  tokens_predicted?: number
  truncated?: boolean
  [key: string]: unknown
}

export type LlamaCompletionJson = {
  content: string
  stop: boolean
  tokens_predicted?: number
  [key: string]: unknown
}

// Minimal fetch-like shape for injection (works with global fetch Response)
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init)
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single SSE `data: ...` line.
 * Returns null for non-data / empty / [DONE] sentinel.
 */
export function parseSseLine(line: string): LlamaCompletionChunk | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const obj = JSON.parse(data) as Record<string, unknown>
    // llama.cpp streams {content, stop, ...} or {delta:{content}} style; normalize
    if (typeof obj['content'] === 'string') {
      return {
        content: obj['content'] as string,
        stop: Boolean(obj['stop']),
        ...obj,
      }
    }
    const delta = obj['delta'] as Record<string, unknown> | undefined
    if (delta && typeof delta['content'] === 'string') {
      return { content: delta['content'] as string, stop: Boolean(obj['stop'] ?? delta['stop']), ...obj }
    }
    // No content => ignore (could be metadata only)
    // Still check 'stop' sentinel
    if (obj['stop'] === true) return { content: '', stop: true, ...obj }
    return null
  } catch {
    return null
  }
}

/**
 * Stream completion via POST /completion (SSE).
 * - When stream=true (default), yields chunks as they arrive.
 * - Aborts via signal.
 * - Throws on non-2xx.
 */
export async function* streamCompletion(
  req: LlamaCompletionRequest,
  opts: {
    port?: number
    fetchImpl?: FetchLike
    signal?: AbortSignal
    headers?: Record<string, string>
  } = {},
): AsyncGenerator<LlamaCompletionChunk, void, unknown> {
  const url = getCompletionUrl(opts.port)
  const doFetch: FetchLike = opts.fetchImpl ?? defaultFetch

  const body: LlamaCompletionRequest = { ...req, stream: req.stream ?? true }

  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`llama /completion failed ${res.status} ${res.statusText} ${text}`.trim())
  }

  const contentType = res.headers.get('content-type') ?? ''
  // Non-stream JSON fallback
  if (!contentType.includes('text/event-stream')) {
    const json = (await res.json().catch(async () => ({ content: await res.text() }))) as Record<string, unknown>
    const chunk: LlamaCompletionChunk = {
      content: String(json['content'] ?? ''),
      stop: Boolean(json['stop'] ?? true),
      ...json,
    }
    if (chunk.content || chunk.stop) yield chunk
    return
  }

  // SSE stream
  const bodyStream = res.body
  if (!bodyStream) {
    throw new Error('llama /completion SSE response has no body')
  }

  const reader = (bodyStream as unknown as ReadableStream<Uint8Array>).getReader?.() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined

  // Fallback: if body is Node-like async iterable or already a string stream
  if (!reader) {
    // Try WHATWG-less path: res.text() fallback (non-stream)
    const text = await res.text()
    for (const line of text.split('\n')) {
      const chunk = parseSseLine(line)
      if (chunk) yield chunk
    }
    return
  }

  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const chunk = parseSseLine(line)
        if (chunk) yield chunk
      }
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => {})
        throw new DOMException('Aborted', 'AbortError')
      }
    }
    // flush remainder
    if (buf.trim()) {
      const chunk = parseSseLine(buf)
      if (chunk) yield chunk
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

/**
 * Non-streaming completion — POST /completion {stream:false} -> JSON {content, stop}.
 */
export async function complete(
  req: LlamaCompletionRequest,
  opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<LlamaCompletionJson> {
  const url = getCompletionUrl(opts.port)
  const doFetch: FetchLike = opts.fetchImpl ?? defaultFetch
  const body = { ...req, stream: false }
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`llama /completion failed ${res.status} ${res.statusText} ${text}`.trim())
  }
  const json = (await res.json()) as LlamaCompletionJson
  return json
}

/**
 * Health probe — mirrors SidecarManager probe but standalone for tests/UI.
 */
export async function checkLlamaHealth(port: number = LLAMA_PORT, fetchImpl?: FetchLike): Promise<boolean> {
  const url = getHealthUrl(port)
  const doFetch: FetchLike = fetchImpl ?? defaultFetch
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 2000)
  try {
    // If caller supplied fetchImpl that ignores signal, still pass it
    const res = await doFetch(url, { signal: ctrl.signal } as RequestInit)
    return (res as Response).ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Convenience wrapper — LlamaSidecar combines manager + completion helpers
// ---------------------------------------------------------------------------

export class LlamaSidecar {
  readonly manager: SidecarManager
  readonly port: number

  constructor(opts: CreateLlamaOptions = {}) {
    this.manager = createLlamaSidecar(opts)
    this.port = opts.port ?? LLAMA_PORT
  }

  get config(): ISidecar {
    return this.manager.config
  }

  get logPath(): string {
    return this.manager.logPath
  }

  get completionUrl(): string {
    return getCompletionUrl(this.port)
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

  /** SSE stream bound to this instance's port. */
  stream(req: LlamaCompletionRequest, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): AsyncGenerator<LlamaCompletionChunk> {
    return streamCompletion(req, { port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }

  /** Non-stream completion bound to this instance's port. */
  async generate(req: LlamaCompletionRequest, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<LlamaCompletionJson> {
    return complete(req, { port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }
}

export default LlamaSidecar
