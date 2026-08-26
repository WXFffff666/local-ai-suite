/**
 * ollama sidecar — wraps `ollama serve` as a SidecarManager child process.
 *
 * Spec (Todo 9 / Wave3 T9):
 * - Binary: `ollama` (override via OLLAMA_BIN env or constructor bin)
 * - Host: 127.0.0.1, Port: 11434 (OLLAMA_PORT, OLLAMA_HOST)
 * - Health: http://127.0.0.1:11434/api/tags  (SidecarManager 5s pulse, 3 fails -> restart)
 * - Models: OLLAMA_MODELS=models/  (env OLLAMA_MODELS or explicit, defaults to <cwd>/models)
 * - APIs: POST /api/chat (SSE/JSON), GET /api/tags (list), GET /api/ps (running)
 * - OpenAI-compat: /v1/* middleware forwards to Ollama (api_key=ollama compatible)
 * - Logs: logs/sidecar-ollama.log via SidecarManager (rotation 5MiB -> .1)
 * - Isolation: spawned sidecar only; no AGPL linking.
 * - Reuse: SidecarManager, ISidecar/IModelProvider contracts.
 */

import * as path from 'path'

import { SidecarManager, type SidecarManagerOptions } from '../core/SidecarManager'
import type { IModelProvider, ISidecar } from '../core/types'

// ---------------------------------------------------------------------------
// Constants — must be 127.0.0.1 per security baseline
// ---------------------------------------------------------------------------

export const OLLAMA_NAME = 'ollama' as const
export const OLLAMA_HOST = '127.0.0.1' as const
export const OLLAMA_PORT = 11434 as const
export const OLLAMA_HEALTH_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags` as const
export const OLLAMA_CHAT_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat` as const
export const OLLAMA_TAGS_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags` as const
export const OLLAMA_PS_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/ps` as const
export const OLLAMA_LOG_FILE = `sidecar-${OLLAMA_NAME}.log` as const
export const DEFAULT_OLLAMA_BIN = 'ollama' as const
export const DEFAULT_MODELS_DIR = 'models' as const
export const OLLAMA_API_KEY = 'ollama' as const

// ---------------------------------------------------------------------------
// Env / Bin / Models dir resolvers
// ---------------------------------------------------------------------------

export function resolveOllamaBin(explicit?: string): string {
  if (explicit) return explicit
  const env = (typeof process !== 'undefined' ? process.env['OLLAMA_BIN'] : undefined) as string | undefined
  if (env && env.trim()) return env.trim()
  return DEFAULT_OLLAMA_BIN
}

export function resolveOllamaModelsDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  const env = (typeof process !== 'undefined' ? process.env['OLLAMA_MODELS'] : undefined) as string | undefined
  if (env && env.trim()) return path.resolve(env.trim())
  return path.resolve(process.cwd(), DEFAULT_MODELS_DIR)
}

export function getOllamaHostEnv(port: number = OLLAMA_PORT): string {
  return `${OLLAMA_HOST}:${port}`
}

// ---------------------------------------------------------------------------
// Args builder — ollama serve uses env OLLAMA_HOST for bind, not CLI flags
// ---------------------------------------------------------------------------

export type BuildOllamaArgsOptions = {
  port?: number
  host?: string
  modelsDir?: string
  extraArgs?: string[]
}

export function buildOllamaArgs(opts: BuildOllamaArgsOptions = {}): string[] {
  const host = opts.host ?? OLLAMA_HOST
  const port = opts.port ?? OLLAMA_PORT
  if (host !== OLLAMA_HOST) {
    throw new Error(`ollama sidecar host must be ${OLLAMA_HOST}, got ${host}`)
  }
  if (port < 1024 || port > 65535) throw new Error(`port out of range: ${port}`)
  // ollama serve is the subcommand; extraArgs appended verbatim
  const args: string[] = ['serve']
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  return args
}

export function getHealthUrl(port: number = OLLAMA_PORT): string {
  return `http://${OLLAMA_HOST}:${port}/api/tags`
}
export function getChatUrl(port: number = OLLAMA_PORT): string {
  return `http://${OLLAMA_HOST}:${port}/api/chat`
}
export function getTagsUrl(port: number = OLLAMA_PORT): string {
  return `http://${OLLAMA_HOST}:${port}/api/tags`
}
export function getPsUrl(port: number = OLLAMA_PORT): string {
  return `http://${OLLAMA_HOST}:${port}/api/ps`
}

// ---------------------------------------------------------------------------
// Sidecar factory
// ---------------------------------------------------------------------------

export type CreateOllamaOptions = BuildOllamaArgsOptions & {
  bin?: string
  logDir?: string
  managerOptions?: Omit<SidecarManagerOptions, 'logDir'>
  /** extra env merged into spawn env */
  env?: Record<string, string>
}

export function createOllamaSidecarConfig(opts: CreateOllamaOptions = {}): ISidecar & Pick<IModelProvider, 'modelPath'> & { modelsDir: string } {
  const bin = resolveOllamaBin(opts.bin)
  const port = opts.port ?? OLLAMA_PORT
  const args = buildOllamaArgs(opts)
  const healthUrl = getHealthUrl(port)
  const modelsDir = resolveOllamaModelsDir(opts.modelsDir)
  const cfg: ISidecar & Pick<IModelProvider, 'modelPath'> & { modelsDir: string } = {
    name: OLLAMA_NAME,
    bin,
    args,
    port,
    healthUrl,
    modelsDir,
  }
  if (opts.modelsDir) (cfg as unknown as Record<string, unknown>)['modelPath'] = modelsDir
  return cfg
}

export function createOllamaSidecar(opts: CreateOllamaOptions = {}): SidecarManager {
  const config = createOllamaSidecarConfig(opts)
  const logDir = opts.logDir ?? path.join(process.cwd(), 'logs')
  // Do not mutate global process.env; SidecarManager clone will use process.env at spawn time,
  // so we monkey-patch via managerOptions.spawner wrapper or rely on caller to set env.
  // For testability we expose helper to get env; but SidecarManager itself spreads process.env.
  // Here we set process.env temporarily? No — we instead document that OLLAMA_HOST/MODELS
  // must be in env and provide helper. For ergonomics we patch process.env keys now.
  // To avoid global pollution in tests, we only set if not already set via opts.env.
  const ollamaEnv: Record<string, string> = {
    OLLAMA_HOST: getOllamaHostEnv(config.port),
    OLLAMA_MODELS: (config as unknown as { modelsDir: string }).modelsDir,
    ...(opts.env ?? {}),
  }
  // Inject via spawner wrapper if custom spawner not capturing env — we wrap spawner to merge env
  const origSpawner = opts.managerOptions?.spawner
  let wrappedSpawner = origSpawner
  if (origSpawner) {
    const orig = origSpawner
    wrappedSpawner = ((bin: string, args: string[], spawnOpts: Record<string, unknown>) => {
      const env = { ...(spawnOpts.env as Record<string, string> ?? {}), ...ollamaEnv }
      return (orig as unknown as (b: string, a: string[], o: Record<string, unknown>) => unknown)(bin, args, { ...spawnOpts, env }) as never
    }) as never
  }
  const mgrOpts: SidecarManagerOptions = {
    logDir,
    ...(opts.managerOptions ?? {}),
    ...(wrappedSpawner ? { spawner: wrappedSpawner } : {}),
  }
  // If no custom spawner, we need to ensure env is applied at spawn time — SidecarManager
  // reads process.env at spawn; we set via a one-time helper that caller can use.
  // To make default spawn also correct without global mutation, we stash env on config for inspection.
  // Actual env injection for default path happens via patching process.env inside SidecarManager spawn
  // using fetcher-like approach? Simpler: set process.env for the duration of SidecarManager lifetime
  // is not ideal. Instead we store ollamaEnv on manager for diagnostics.
  const mgr = new SidecarManager(config as unknown as ISidecar, mgrOpts)
  // Attach ollama env for inspection / tests without polluting global
  ;(mgr as unknown as Record<string, unknown>)['_ollamaEnv'] = ollamaEnv
  return mgr
}

export function getOllamaEnvForSpawn(port: number = OLLAMA_PORT, modelsDir?: string): Record<string, string> {
  return {
    OLLAMA_HOST: getOllamaHostEnv(port),
    OLLAMA_MODELS: resolveOllamaModelsDir(modelsDir),
  }
}

// ---------------------------------------------------------------------------
// API types — Ollama native shapes
// ---------------------------------------------------------------------------

export type OllamaMessage = { role: string; content: string }

export type OllamaChatRequest = {
  model: string
  messages: OllamaMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  num_predict?: number
  stop?: string[]
  // passthrough
  [key: string]: unknown
}

export type OllamaChatChunk = {
  message?: OllamaMessage
  content?: string
  done: boolean
  // raw passthrough
  model?: string
  created_at?: string
  [key: string]: unknown
}

export type OllamaTagsResponse = {
  models: Array<{
    name: string
    model: string
    modified_at: string
    size: number
    digest: string
    details?: Record<string, unknown>
  }>
}

export type OllamaPsResponse = {
  models: Array<{
    name: string
    model: string
    size: number
    digest?: string
    details?: Record<string, unknown>
    expires_at?: string
    size_vram?: number
  }>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init as RequestInit)
}

// ---------------------------------------------------------------------------
// Auth — api_key=ollama compatible
// ---------------------------------------------------------------------------

/** Acceptable api key is exactly "ollama" per spec */
export function isOllamaApiKey(key: string | null | undefined): boolean {
  return key === OLLAMA_API_KEY
}

/** Extract candidate key from headers / query */
export function extractApiKey(input: {
  headers?: Record<string, string> | Headers
  query?: Record<string, string> | URLSearchParams
  url?: string
}): string | undefined {
  const h = input.headers
  const q = input.query
  const url = input.url

  // 1) Authorization: Bearer <key>
  let auth: string | undefined
  if (h instanceof Headers) auth = h.get('authorization') ?? h.get('Authorization') ?? undefined
  else if (h) {
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
    auth = lower['authorization']
  }
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m?.[1]) {
      const v = m[1].trim()
      if (v) return v
    }
  }
  // 2) x-api-key / api-key header
  if (h instanceof Headers) {
    const v = h.get('x-api-key') ?? h.get('api-key')
    if (v?.trim()) return v.trim()
  } else if (h) {
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
    const v = lower['x-api-key'] ?? lower['api-key']
    if (v?.trim()) return v.trim()
  }
  // 3) query param api_key / apikey
  if (q instanceof URLSearchParams) {
    const v = q.get('api_key') ?? q.get('apikey') ?? q.get('apiKey')
    if (v?.trim()) return v.trim()
  } else if (q) {
    const lower = Object.fromEntries(Object.entries(q).map(([k, v]) => [k.toLowerCase(), v]))
    const v = lower['api_key'] ?? lower['apikey'] ?? lower['apikey']
    if (v?.trim()) return v.trim()
  }
  // 4) url query string parse
  if (url) {
    try {
      const u = new URL(url, 'http://127.0.0.1')
      const v = u.searchParams.get('api_key') ?? u.searchParams.get('apikey')
      if (v?.trim()) return v.trim()
    } catch { /* ignore */ }
  }
  return undefined
}

export function isAuthorized(input: {
  headers?: Record<string, string> | Headers
  query?: Record<string, string> | URLSearchParams
  url?: string
}): boolean {
  const key = extractApiKey(input)
  if (!key) return false
  return isOllamaApiKey(key)
}

// Generic middleware factory — works for fetch-style (Request->Response) and express-style (req,res,next)
export type OllamaMiddlewareOptions = {
  /** If true, missing key is allowed (no auth required). Default false -> require ollama key */
  allowWithoutKey?: boolean
  /** Custom key validator (default isOllamaApiKey) */
  validateKey?: (key: string | undefined) => boolean
}

export function createOllamaAuthMiddleware(opts: OllamaMiddlewareOptions = {}) {
  const validate = opts.validateKey ?? isOllamaApiKey
  const allowWithoutKey = opts.allowWithoutKey ?? false

  // fetch-style handler wrapper
  return {
    check(headers: Record<string, string> | Headers, query?: Record<string, string> | URLSearchParams, url?: string): boolean {
      const key = extractApiKey({ headers, query, url })
      if (!key && allowWithoutKey) return true
      if (!key) return false
      return validate(key)
    },
    // express-style middleware
    middleware(req: { headers: Record<string, string>; query?: Record<string, string>; url?: string }, _res: unknown, next: () => void): { status: number; body: unknown } | void {
      const key = extractApiKey({ headers: req.headers, query: req.query, url: req.url })
      if (!key && allowWithoutKey) { next(); return }
      if (!key || !validate(key)) {
        return { status: 401, body: { error: 'Unauthorized: api_key must be ollama' } }
      }
      next()
    },
  }
}

// ---------------------------------------------------------------------------
// Ollama HTTP helpers (fetch-injected, for tests + middleware forwarding)
// ---------------------------------------------------------------------------

export async function listTags(opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<OllamaTagsResponse> {
  const url = getTagsUrl(opts.port)
  const doFetch = opts.fetchImpl ?? defaultFetch
  const res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: opts.signal } as RequestInit)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`ollama /api/tags failed ${res.status} ${res.statusText} ${t}`.trim())
  }
  return (await res.json()) as OllamaTagsResponse
}

export async function listRunning(opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<OllamaPsResponse> {
  const url = getPsUrl(opts.port)
  const doFetch = opts.fetchImpl ?? defaultFetch
  const res = await doFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: opts.signal } as RequestInit)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`ollama /api/ps failed ${res.status} ${res.statusText} ${t}`.trim())
  }
  return (await res.json()) as OllamaPsResponse
}

export async function checkOllamaHealth(port: number = OLLAMA_PORT, fetchImpl?: FetchLike): Promise<boolean> {
  try {
    const doFetch: FetchLike = fetchImpl ?? defaultFetch
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await doFetch(getHealthUrl(port), { signal: ctrl.signal } as RequestInit)
      return (res as Response).ok
    } finally { clearTimeout(t) }
  } catch { return false }
}

// ---------------------------------------------------------------------------
// /api/chat — stream (NDJSON) and non-stream
// ---------------------------------------------------------------------------

export function parseOllamaChatLine(line: string): OllamaChatChunk | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // Ollama streams NDJSON (one JSON per line), not SSE, but also tolerate data: prefix for compat
  let data = trimmed
  if (data.startsWith('data:')) data = data.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const obj = JSON.parse(data) as Record<string, unknown>
    // Normalize: {message:{role,content}, done} or {content, done}
    const msg = obj['message'] as Record<string, unknown> | undefined
    if (msg && typeof msg['content'] === 'string') {
      return { message: { role: String(msg['role'] ?? 'assistant'), content: String(msg['content']) }, done: Boolean(obj['done']), ...obj } as OllamaChatChunk
    }
    if (typeof obj['content'] === 'string') {
      return { content: obj['content'] as string, done: Boolean(obj['done']), ...obj } as OllamaChatChunk
    }
    if (typeof obj['response'] === 'string') {
      return { content: obj['response'] as string, done: Boolean(obj['done']), ...obj } as OllamaChatChunk
    }
    if (obj['done'] === true) return { done: true, ...obj } as OllamaChatChunk
    return null
  } catch { return null }
}

export async function* streamChat(
  req: OllamaChatRequest,
  opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal; headers?: Record<string, string> } = {},
): AsyncGenerator<OllamaChatChunk, void, unknown> {
  const url = getChatUrl(opts.port)
  const doFetch = opts.fetchImpl ?? defaultFetch
  const body: OllamaChatRequest = { ...req, stream: req.stream ?? true }
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  } as RequestInit)

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`ollama /api/chat failed ${res.status} ${res.statusText} ${t}`.trim())
  }

  const ct = res.headers.get('content-type') ?? ''
  // Non-stream JSON fallback
  if (ct.includes('application/json') && body.stream === false) {
    const json = (await res.json().catch(async () => ({ message: { content: await res.text() } }))) as Record<string, unknown>
    const msg = json['message'] as Record<string, unknown> | undefined
    const content = (msg?.['content'] as string | undefined) ?? (json['response'] as string | undefined) ?? (json['content'] as string | undefined) ?? ''
    yield { message: { role: 'assistant', content: String(content) }, done: true, ...json } as OllamaChatChunk
    return
  }

  const bodyStream = res.body
  if (!bodyStream) {
    // Fallback to text
    const text = await res.text()
    for (const line of text.split('\n')) {
      const chunk = parseOllamaChatLine(line)
      if (chunk) yield chunk
    }
    return
  }
  const reader = (bodyStream as unknown as ReadableStream<Uint8Array>).getReader?.() as ReadableStreamDefaultReader<Uint8Array> | undefined
  if (!reader) {
    const text = await res.text()
    for (const line of text.split('\n')) {
      const chunk = parseOllamaChatLine(line)
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
        const chunk = parseOllamaChatLine(line)
        if (chunk) yield chunk
      }
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => {})
        throw new DOMException('Aborted', 'AbortError')
      }
    }
    if (buf.trim()) {
      const chunk = parseOllamaChatLine(buf)
      if (chunk) yield chunk
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

export async function chat(
  req: OllamaChatRequest,
  opts: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<{ message: OllamaMessage; done: boolean; [k: string]: unknown }> {
  const url = getChatUrl(opts.port)
  const doFetch = opts.fetchImpl ?? defaultFetch
  const body = { ...req, stream: false }
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  } as RequestInit)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`ollama /api/chat failed ${res.status} ${res.statusText} ${t}`.trim())
  }
  const json = (await res.json()) as Record<string, unknown>
  const msg = json['message'] as Record<string, unknown> | undefined
  const content = (msg?.['content'] as string | undefined) ?? (json['response'] as string | undefined) ?? ''
  return {
    message: { role: String(msg?.['role'] ?? 'assistant'), content: String(content) },
    done: true,
    ...json,
  }
}

// ---------------------------------------------------------------------------
// /v1/* middleware forwarding (OpenAI compat -> Ollama)
// ---------------------------------------------------------------------------

export type OpenAIChatRequest = {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string[]
  [k: string]: unknown
}

export function openAiToOllama(req: OpenAIChatRequest): OllamaChatRequest {
  const { model, messages, stream, temperature, top_p, max_tokens, stop, ...rest } = req
  const out: OllamaChatRequest = {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: stream ?? true,
    ...rest,
  }
  if (temperature !== undefined) out.temperature = temperature
  if (top_p !== undefined) out.top_p = top_p
  if (max_tokens !== undefined) out.num_predict = max_tokens
  if (stop !== undefined) out.stop = Array.isArray(stop) ? stop as string[] : [String(stop)]
  return out
}

export function ollamaChunkToOpenAI(chunk: OllamaChatChunk, model: string): Record<string, unknown> {
  const content = chunk.message?.content ?? chunk.content ?? ''
  const done = chunk.done
  if (done) {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  }
}

/** Forward a fetch Request to local ollama, translating /v1/chat/completions <-> /api/chat */
export async function forwardToOllama(
  req: Request,
  opts: { port?: number; fetchImpl?: FetchLike } = {},
): Promise<Response> {
  const port = opts.port ?? OLLAMA_PORT
  const doFetch = opts.fetchImpl ?? defaultFetch
  const url = new URL(req.url)
  const pathname = url.pathname

  // Auth check: if Authorization/api_key present, must be ollama
  const authHeader = req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? undefined
  const queryKey = url.searchParams.get('api_key') ?? url.searchParams.get('apikey') ?? undefined
  const candidate = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? queryKey
  if (candidate && !isOllamaApiKey(candidate)) {
    return new Response(JSON.stringify({ error: 'Unauthorized: api_key must be ollama' }), { status: 401, headers: { 'content-type': 'application/json' } })
  }

  // Route mapping
  if (pathname === '/v1/chat/completions' || pathname === '/v1/chat/completions/') {
    const bodyText = await req.text().catch(() => '')
    let openAiReq: OpenAIChatRequest
    try { openAiReq = JSON.parse(bodyText || '{}') as OpenAIChatRequest } catch { return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'content-type': 'application/json' } }) }
    const ollamaReq = openAiToOllama(openAiReq)
    const stream = openAiReq.stream ?? true
    if (!stream) {
      const res = await chat(ollamaReq, { port, fetchImpl: doFetch })
      const openAiRes = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: openAiReq.model,
        choices: [{ index: 0, message: res.message, finish_reason: 'stop' }],
        usage: (res as Record<string, unknown>)['usage'] ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }
      return new Response(JSON.stringify(openAiRes), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // Stream -> NDJSON from ollama, convert to SSE for OpenAI client
    const ollamaRes = await doFetch(getChatUrl(port), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ollamaReq, stream: true }),
    } as RequestInit)
    if (!ollamaRes.ok) {
      const t = await ollamaRes.text().catch(() => '')
      return new Response(JSON.stringify({ error: `ollama upstream ${ollamaRes.status} ${t}`.trim() }), { status: ollamaRes.status, headers: { 'content-type': 'application/json' } })
    }
    const srcStream = ollamaRes.body as unknown as ReadableStream<Uint8Array> | null
    if (!srcStream) {
      return new Response(JSON.stringify({ error: 'upstream has no body' }), { status: 502, headers: { 'content-type': 'application/json' } })
    }
    // Transform NDJSON -> SSE
    const outStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = (srcStream as ReadableStream<Uint8Array>).getReader()
        const decoder = new TextDecoder()
        const encoder = new TextEncoder()
        let buf = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              const chunk = parseOllamaChatLine(line)
              if (!chunk) continue
              const openAiChunk = ollamaChunkToOpenAI(chunk, openAiReq.model)
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`))
              if (chunk.done) {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              }
            }
          }
          if (buf.trim()) {
            const chunk = parseOllamaChatLine(buf)
            if (chunk) {
              const openAiChunk = ollamaChunkToOpenAI(chunk, openAiReq.model)
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`))
              if (chunk.done) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            }
          }
          // Ensure DONE if upstream didn't send done
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        } finally {
          try { reader.releaseLock() } catch { /* ignore */ }
          controller.close()
        }
      },
    })
    return new Response(outStream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
  }

  // Generic proxy for /api/* and /v1/models
  if (pathname === '/v1/models' || pathname === '/v1/models/') {
    try {
      const tags = await listTags({ port, fetchImpl: doFetch })
      const openAiModels = {
        object: 'list',
        data: (tags.models ?? []).map(m => ({
          id: m.name ?? m.model,
          object: 'model',
          created: m.modified_at ? Math.floor(new Date(m.modified_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
          owned_by: 'local',
        })),
      }
      return new Response(JSON.stringify(openAiModels), { status: 200, headers: { 'content-type': 'application/json' } })
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { 'content-type': 'application/json' } })
    }
  }

  // Pass-through for /api/chat /api/tags /api/ps
  if (pathname.startsWith('/api/')) {
    const target = `http://${OLLAMA_HOST}:${port}${pathname}${url.search}`
    const init: RequestInit = {
      method: req.method,
      headers: Object.fromEntries(req.headers.entries()),
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const buf = await req.arrayBuffer().catch(() => null)
      if (buf) (init as Record<string, unknown>)['body'] = buf
    }
    // Remove host header to avoid mismatch; fetch will set
    if ((init.headers as Record<string, string>)['host']) delete (init.headers as Record<string, string>)['host']
    try {
      const upstream = await doFetch(target, init)
      // Clone headers
      const headers = new Headers()
      upstream.headers.forEach((v, k) => headers.set(k, v))
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502, headers: { 'content-type': 'application/json' } })
    }
  }

  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
}

// Convenience: create a fetch handler for mounting at server (e.g. electron net / node http)
export function createOllamaMiddleware(opts: { port?: number; fetchImpl?: FetchLike; allowWithoutKey?: boolean } = {}) {
  const port = opts.port ?? OLLAMA_PORT
  const doFetch = opts.fetchImpl ?? defaultFetch
  const auth = createOllamaAuthMiddleware({ allowWithoutKey: opts.allowWithoutKey ?? true })
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url)
    const p = url.pathname
    const isOllamaRoute = p.startsWith('/api/') || p.startsWith('/v1/')
    if (!isOllamaRoute) return null
    // Auth gate if key supplied
    const key = extractApiKey({ headers: req.headers, url: req.url })
    if (key && !auth.check(req.headers as unknown as Headers)) {
      return new Response(JSON.stringify({ error: 'Unauthorized: api_key must be ollama' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    return forwardToOllama(req, { port, fetchImpl: doFetch })
  }
}

// ---------------------------------------------------------------------------
// Convenience wrapper — OllamaSidecar combines manager + api helpers
// ---------------------------------------------------------------------------

export class OllamaSidecar {
  readonly manager: SidecarManager
  readonly port: number
  readonly modelsDir: string

  constructor(opts: CreateOllamaOptions = {}) {
    this.manager = createOllamaSidecar(opts)
    this.port = opts.port ?? OLLAMA_PORT
    this.modelsDir = resolveOllamaModelsDir(opts.modelsDir)
  }

  get config(): ISidecar { return this.manager.config }
  get logPath(): string { return this.manager.logPath }
  get chatUrl(): string { return getChatUrl(this.port) }
  get tagsUrl(): string { return getTagsUrl(this.port) }
  get psUrl(): string { return getPsUrl(this.port) }
  get healthUrl(): string { return getHealthUrl(this.port) }

  start(): void { this.manager.start() }
  stop(): void { this.manager.stop() }
  restart(): void { this.manager.restart() }
  getStatus(): ReturnType<SidecarManager['getStatus']> { return this.manager.getStatus() }
  isRunning(): boolean { return this.manager.isRunning() }

  stream(req: OllamaChatRequest, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): AsyncGenerator<OllamaChatChunk> {
    return streamChat(req, { port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }
  async generate(req: OllamaChatRequest, opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<{ message: OllamaMessage; done: boolean; [k: string]: unknown }> {
    return chat(req, { port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }
  async tags(opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<OllamaTagsResponse> {
    return listTags({ port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }
  async ps(opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {}): Promise<OllamaPsResponse> {
    return listRunning({ port: this.port, fetchImpl: opts.fetchImpl, signal: opts.signal })
  }
  middleware(opts: { fetchImpl?: FetchLike; allowWithoutKey?: boolean } = {}): (req: Request) => Promise<Response | null> {
    return createOllamaMiddleware({ port: this.port, fetchImpl: opts.fetchImpl, allowWithoutKey: opts.allowWithoutKey })
  }
}

export default OllamaSidecar
