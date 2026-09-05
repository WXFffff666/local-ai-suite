/**
 * OpenAI 兼容服务核心 — Wave6 T24
 *
 * 暴露 http://127.0.0.1:11434/v1
 *   GET  /v1/models
 *   POST /v1/chat/completions  (SSE, 含 data: [DONE])
 *   POST /v1/embeddings
 * 转发到 Ollama (127.0.0.1:11434 /api/*) 与 llama (127.0.0.1:11435 /completion) 择优
 * api_key=ollama 透传：若携带则必须为 ollama，否则 401；未携带则放行
 * Host MUST stay 127.0.0.1
 *
 * 提供：
 *  - fetch-style: handleOpenAiRequest / createOpenAiHandler
 *  - Express 中间件: createExpressMiddleware
 *  - Elysia 插件: createElysiaPlugin / elysiaOpenAiPlugin
 *  - Node http 服务: createOpenAiServer / startOpenAiServer
 *
 * MIT only — no AGPL.
 */

import * as http from 'http'

import { handleImagesRequest } from './images'

// ---------------------------------------------------------------------------
// Constants — 127.0.0.1 invariant
// ---------------------------------------------------------------------------

export const OPENAI_HOST = '127.0.0.1' as const
export const OPENAI_PORT = 11434 as const
export const OPENAI_BASE_URL = `http://${OPENAI_HOST}:${OPENAI_PORT}` as const
export const OPENAI_V1_PREFIX = '/v1' as const

export const OLLAMA_HOST = '127.0.0.1' as const
export const OLLAMA_PORT = 11434 as const
export const OLLAMA_TAGS_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags` as const
export const OLLAMA_CHAT_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/chat` as const
export const OLLAMA_EMBED_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/embed` as const
export const OLLAMA_EMBEDDINGS_URL = `http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/embeddings` as const

export const LLAMA_HOST = '127.0.0.1' as const
export const LLAMA_PORT = 11435 as const
export const LLAMA_COMPLETION_URL = `http://${LLAMA_HOST}:${LLAMA_PORT}/completion` as const

export const OLLAMA_API_KEY = 'ollama' as const

export const MODELS_PATH = '/v1/models' as const
export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions' as const
export const EMBEDDINGS_PATH = '/v1/embeddings' as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type OpenAiDeps = {
  /** Ollama 端口，默认 11434 */
  ollamaPort?: number
  /** Llama 端口，默认 11435；用于 chat fallback */
  llamaPort?: number
  /** 注入 fetch，测试用 */
  fetchImpl?: FetchLike
  signal?: AbortSignal
  /** /v1/images/generations 挂载（阶段0）；缺省直连 sd 侧车 11436 */
  images?: import('./images').ImagesDeps
}

export type OpenAIMessage = { role: string; content: string }

export type OpenAIChatRequest = {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  stop?: string[] | string
  [k: string]: unknown
}

export type OpenAIEmbeddingsRequest = {
  model: string
  input: string | string[]
  encoding_format?: string
  // Ollama also accepts prompt
  prompt?: string
  [k: string]: unknown
}

export type OllamaChatRequest = {
  model: string
  messages: { role: string; content: string }[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  num_predict?: number
  stop?: string[]
  [k: string]: unknown
}

export type OllamaChatChunk = {
  message?: { role: string; content: string }
  content?: string
  response?: string
  done: boolean
  model?: string
  created_at?: string
  [k: string]: unknown
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Auth — api_key=ollama 透传
// ---------------------------------------------------------------------------

export function isOllamaApiKey(key: string | null | undefined): boolean {
  return key === OLLAMA_API_KEY
}

export function extractApiKey(input: {
  headers?: Record<string, string> | Headers
  query?: Record<string, string> | URLSearchParams
  url?: string
}): string | undefined {
  const h = input.headers
  const q = input.query
  const url = input.url

  let auth: string | undefined
  if (h instanceof Headers) auth = h.get('authorization') ?? (h.get('Authorization') as string | null) ?? undefined
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
  if (h instanceof Headers) {
    const v = h.get('x-api-key') ?? h.get('api-key')
    if (v?.trim()) return v.trim()
  } else if (h) {
    const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
    const v = lower['x-api-key'] ?? lower['api-key']
    if (v?.trim()) return v.trim()
  }
  if (q instanceof URLSearchParams) {
    const v = q.get('api_key') ?? q.get('apikey') ?? q.get('apiKey')
    if (v?.trim()) return v.trim()
  } else if (q) {
    const lower = Object.fromEntries(Object.entries(q).map(([k, v]) => [k.toLowerCase(), v]))
    const v = lower['api_key'] ?? lower['apikey'] ?? lower['apiKey']
    if (v?.trim()) return v.trim()
  }
  if (url) {
    try {
      const u = new URL(url, `http://${OPENAI_HOST}:${OLLAMA_PORT}`)
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
  if (!key) return true // 透传：未携带则放行
  return isOllamaApiKey(key)
}

function assertAuthorized(req: Request): Response | null {
  // extract from Request
  const authHeader = req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? req.headers.get('api-key') ?? undefined
  let candidate: string | undefined
  if (authHeader) {
    const m = authHeader.match(/^Bearer\s+(.+)$/i)
    candidate = m?.[1]?.trim() ?? authHeader.trim()
  }
  if (!candidate) {
    try {
      const u = new URL(req.url, `http://${OPENAI_HOST}:${OPENAI_PORT}`)
      candidate = u.searchParams.get('api_key') ?? u.searchParams.get('apikey') ?? undefined
      if (candidate) candidate = candidate.trim()
    } catch { /* ignore */ }
  }
  if (!candidate) return null // allow without key
  if (!isOllamaApiKey(candidate)) {
    return jsonRes(401, { error: { message: 'Unauthorized: api_key must be ollama', type: 'invalid_request_error', code: 'invalid_api_key' } })
  }
  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init)
}

function jsonRes(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

function getOllamaTagsUrl(port: number): string {
  return `http://${OLLAMA_HOST}:${port}/api/tags`
}
function getOllamaChatUrl(port: number): string {
  return `http://${OLLAMA_HOST}:${port}/api/chat`
}
function getOllamaEmbedUrl(port: number): string {
  return `http://${OLLAMA_HOST}:${port}/api/embed`
}
function getOllamaEmbeddingsUrl(port: number): string {
  return `http://${OLLAMA_HOST}:${port}/api/embeddings`
}
function getLlamaCompletionUrl(port: number): string {
  return `http://${LLAMA_HOST}:${port}/completion`
}

export function assertHost(host: string): void {
  if (host !== OPENAI_HOST) throw new Error(`OpenAI sidecar host must be ${OPENAI_HOST}, got ${host}`)
}

// ---------------------------------------------------------------------------
// OpenAI <-> Ollama / Llama translation
// ---------------------------------------------------------------------------

export function openAiToOllama(req: OpenAIChatRequest): OllamaChatRequest {
  const { model, messages, stream: _s, temperature, top_p, max_tokens, stop, top_k, ...rest } = req as Record<string, unknown> as OpenAIChatRequest & { top_k?: number }
  const out: OllamaChatRequest = {
    model,
    messages: (messages ?? []).map((m) => ({ role: m.role, content: String(m.content ?? '') })),
    stream: req.stream ?? false,
    ...(rest as Record<string, unknown>),
  } as OllamaChatRequest
  if (temperature !== undefined) out.temperature = temperature
  if (top_p !== undefined) out.top_p = top_p
  if (top_k !== undefined) out.top_k = top_k
  if (max_tokens !== undefined) out.num_predict = max_tokens
  if (stop !== undefined) out.stop = Array.isArray(stop) ? (stop as string[]) : [String(stop)]
  return out
}

export function openAiMessagesToPrompt(messages: OpenAIMessage[]): string {
  // minimal chat template for llama fallback
  return messages
    .map((m) => {
      if (m.role === 'system') return `System: ${m.content}`
      if (m.role === 'assistant') return `Assistant: ${m.content}`
      if (m.role === 'user') return `User: ${m.content}`
      return `${m.role}: ${m.content}`
    })
    .join('\n') + '\nAssistant:'
}

export function parseOllamaChatLine(line: string): OllamaChatChunk | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let data = trimmed
  if (data.startsWith('data:')) data = data.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const obj = JSON.parse(data) as Record<string, unknown>
    const msg = obj['message'] as Record<string, unknown> | undefined
    if (msg && typeof msg['content'] === 'string') {
      return { message: { role: String(msg['role'] ?? 'assistant'), content: String(msg['content']) }, done: Boolean(obj['done']), ...obj } as OllamaChatChunk
    }
    if (typeof obj['content'] === 'string') return { content: obj['content'] as string, done: Boolean(obj['done']), ...obj } as OllamaChatChunk
    if (typeof obj['response'] === 'string') return { content: obj['response'] as string, done: Boolean(obj['done']), ...obj } as OllamaChatChunk
    if (obj['done'] === true) return { done: true, ...obj } as OllamaChatChunk
    return null
  } catch {
    return null
  }
}

export function ollamaChunkToOpenAIChunk(chunk: OllamaChatChunk, model: string, id: string, created: number): Record<string, unknown> {
  const content = chunk.message?.content ?? chunk.content ?? (chunk as Record<string, unknown>)['response'] as string | undefined ?? ''
  if (chunk.done) {
    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
  }
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleModels(_req: Request, deps: OpenAiDeps = {}): Promise<Response> {
  const port = deps.ollamaPort ?? OLLAMA_PORT
  const doFetch = deps.fetchImpl ?? defaultFetch
  try {
    const res = await doFetch(getOllamaTagsUrl(port), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: deps.signal,
    } as RequestInit)
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return jsonRes(502, { error: { message: `ollama /api/tags ${res.status} ${t}`.trim(), type: 'server_error' } })
    }
    const json = (await res.json()) as { models?: Array<{ name?: string; model?: string; modified_at?: string; size?: number; digest?: string; details?: Record<string, unknown> }> }
    const list = (json.models ?? []).map((m) => ({
      id: m.name ?? m.model ?? 'unknown',
      object: 'model' as const,
      created: m.modified_at ? Math.floor(new Date(m.modified_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
      owned_by: 'local' as const,
    }))
    return jsonRes(200, { object: 'list', data: list })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    return jsonRes(502, { error: { message: msg, type: 'server_error' } })
  }
}

export async function handleChatCompletions(req: Request, deps: OpenAiDeps = {}): Promise<Response> {
  let body: OpenAIChatRequest
  try {
    const text = await req.text()
    body = JSON.parse(text || '{}') as OpenAIChatRequest
  } catch {
    return jsonRes(400, { error: { message: 'invalid json body', type: 'invalid_request_error' } })
  }
  if (!body.model || typeof body.model !== 'string') {
    return jsonRes(400, { error: { message: 'model is required', type: 'invalid_request_error' } })
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonRes(400, { error: { message: 'messages is required and must be non-empty array', type: 'invalid_request_error' } })
  }
  for (const m of body.messages) {
    if (!m.role || typeof m.content !== 'string') {
      return jsonRes(400, { error: { message: 'each message must have role and content string', type: 'invalid_request_error' } })
    }
  }

  const stream = body.stream ?? false
  const ollamaPort = deps.ollamaPort ?? OLLAMA_PORT
  const llamaPort = deps.llamaPort ?? LLAMA_PORT
  const doFetch = deps.fetchImpl ?? defaultFetch
  const ollamaReq = openAiToOllama({ ...body, stream })

  // Non-stream: single JSON
  if (!stream) {
    // try Ollama first
    try {
      const res = await doFetch(getOllamaChatUrl(ollamaPort), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...ollamaReq, stream: false }),
        signal: deps.signal,
      } as RequestInit)
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        // if Ollama 404 or connection failure, try llama fallback
        if (res.status === 404 || res.status >= 500) throw new Error(`ollama ${res.status} ${t}`)
        return jsonRes(res.status, { error: { message: t || `ollama error ${res.status}`, type: 'server_error' } })
      }
      const j = (await res.json()) as Record<string, unknown>
      const msg = j['message'] as Record<string, unknown> | undefined
      const content = (msg?.['content'] as string | undefined) ?? (j['response'] as string | undefined) ?? (j['content'] as string | undefined) ?? ''
      const out = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: String(content) }, finish_reason: 'stop' }],
        usage: (j['usage'] as unknown) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }
      return jsonRes(200, out)
    } catch (e) {
      // Llama fallback for non-stream
      try {
        const prompt = openAiMessagesToPrompt(body.messages)
        const llamaRes = await doFetch(getLlamaCompletionUrl(llamaPort), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, stream: false, temperature: body.temperature, top_p: body.top_p, stop: ollamaReq.stop }),
          signal: deps.signal,
        } as RequestInit)
        if (!llamaRes.ok) throw new Error(`llama ${llamaRes.status}`)
        const lj = (await llamaRes.json()) as Record<string, unknown>
        const content = String(lj['content'] ?? '')
        return jsonRes(200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      } catch {
        const msg = (e as Error).message ?? String(e)
        return jsonRes(502, { error: { message: msg, type: 'server_error' } })
      }
    }
  }

  // Stream: NDJSON -> SSE
  // Attempt Ollama stream; on immediate failure try llama SSE
  let upstream: Response
  try {
    upstream = await doFetch(getOllamaChatUrl(ollamaPort), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ ...ollamaReq, stream: true }),
      signal: deps.signal,
    } as RequestInit)
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '')
      throw new Error(`ollama upstream ${upstream.status} ${t}`.trim())
    }
  } catch (e) {
    // Llama SSE fallback
    try {
      const prompt = openAiMessagesToPrompt(body.messages)
      const llamaUp = await doFetch(getLlamaCompletionUrl(llamaPort), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ prompt, stream: true, temperature: body.temperature, top_p: body.top_p, stop: ollamaReq.stop }),
        signal: deps.signal,
      } as RequestInit)
      if (!llamaUp.ok) throw new Error(`llama ${llamaUp.status}`)
      // llama already SSE, just pipe with OpenAI wrapper
      const srcStream = llamaUp.body as unknown as ReadableStream<Uint8Array> | null
      if (!srcStream) return jsonRes(502, { error: { message: 'llama upstream has no body', type: 'server_error' } })
      const id = `chatcmpl-${Date.now()}`
      const created = Math.floor(Date.now() / 1000)
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
                const trimmed = line.trim()
                if (!trimmed.startsWith('data:')) continue
                const data = trimmed.slice(5).trim()
                if (!data || data === '[DONE]') continue
                try {
                  const obj = JSON.parse(data) as Record<string, unknown>
                  const content = String(obj['content'] ?? (obj['delta'] as Record<string, unknown>)?.['content'] ?? '')
                  const stop = Boolean(obj['stop'])
                  const chunk = stop
                    ? { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
                    : { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                  if (stop) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                } catch { /* ignore */ }
              }
            }
            if (buf.trim().startsWith('data:')) {
              const data = buf.trim().slice(5).trim()
              if (data && data !== '[DONE]') {
                try {
                  const obj = JSON.parse(data) as Record<string, unknown>
                  const content = String(obj['content'] ?? '')
                  const stop = Boolean(obj['stop'])
                  const chunk = stop
                    ? { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
                    : { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                } catch { /* ignore */ }
              }
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } finally {
            try { reader.releaseLock() } catch { /* ignore */ }
            controller.close()
          }
        },
      })
      return new Response(outStream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
    } catch {
      const msg = (e as Error).message ?? String(e)
      return jsonRes(502, { error: { message: msg, type: 'server_error' } })
    }
  }

  const srcStream = upstream.body as unknown as ReadableStream<Uint8Array> | null
  if (!srcStream) return jsonRes(502, { error: { message: 'upstream has no body', type: 'server_error' } })

  const id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const outStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = (srcStream as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buf = ''
      let sentDone = false
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
            const openAiChunk = ollamaChunkToOpenAIChunk(chunk, body.model, id, created)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`))
            if (chunk.done) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              sentDone = true
            }
          }
          if (deps.signal?.aborted) { await reader.cancel().catch(() => {}); break }
        }
        if (buf.trim()) {
          const chunk = parseOllamaChatLine(buf)
          if (chunk) {
            const openAiChunk = ollamaChunkToOpenAIChunk(chunk, body.model, id, created)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`))
            if (chunk.done && !sentDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            if (chunk.done) sentDone = true
          }
        }
        if (!sentDone) controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      } finally {
        try { reader.releaseLock() } catch { /* ignore */ }
        controller.close()
      }
    },
  })
  return new Response(outStream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } })
}

export async function handleEmbeddings(req: Request, deps: OpenAiDeps = {}): Promise<Response> {
  let body: OpenAIEmbeddingsRequest
  try {
    const text = await req.text()
    body = JSON.parse(text || '{}') as OpenAIEmbeddingsRequest
  } catch {
    return jsonRes(400, { error: { message: 'invalid json body', type: 'invalid_request_error' } })
  }
  const model = (body as Record<string, unknown>)['model'] as string | undefined
  if (!model || typeof model !== 'string') return jsonRes(400, { error: { message: 'model is required', type: 'invalid_request_error' } })
  const inputRaw: unknown = (body as Record<string, unknown>)['input'] ?? (body as Record<string, unknown>)['prompt']
  if (inputRaw === undefined || inputRaw === null || (typeof inputRaw === 'string' && !inputRaw.trim() && (inputRaw as string) !== '' ) && false) { /* keep */ }
  if (inputRaw === undefined || inputRaw === null) return jsonRes(400, { error: { message: 'input is required', type: 'invalid_request_error' } })
  const inputs: string[] = Array.isArray(inputRaw) ? (inputRaw as unknown[]).map((v) => String(v)) : [String(inputRaw)]

  const port = deps.ollamaPort ?? OLLAMA_PORT
  const doFetch = deps.fetchImpl ?? defaultFetch

  // Try /api/embed (new) then fallback /api/embeddings (old)
  const tryUrls = [getOllamaEmbedUrl(port), getOllamaEmbeddingsUrl(port)]
  let lastErr: string | undefined
  for (const url of tryUrls) {
    try {
      const isNew = url.endsWith('/api/embed')
      const payload = isNew ? { model, input: inputs.length === 1 ? inputs[0] : inputs } : { model, prompt: inputs[0] }
      // For new embed, batch support; for old embeddings we loop
      if (!isNew && inputs.length > 1) {
        // fallback per-item
        const allEmbeddings: number[][] = []
        for (const inp of inputs) {
          const r = await doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ model, prompt: inp }),
            signal: deps.signal,
          } as RequestInit)
          if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`${r.status} ${t}`) }
          const j = (await r.json()) as Record<string, unknown>
          const emb = (j['embedding'] as number[] | undefined) ?? (j['embeddings'] as number[][] | undefined)?.[0]
          if (!emb) throw new Error('no embedding in response')
          allEmbeddings.push(emb as number[])
        }
        return jsonRes(200, {
          object: 'list',
          data: allEmbeddings.map((e, i) => ({ object: 'embedding', index: i, embedding: e })),
          model,
          usage: { prompt_tokens: 0, total_tokens: 0 },
        })
      }
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: deps.signal,
      } as RequestInit)
      if (!res.ok) {
        const t = await res.text().catch(() => '')
        // 404 -> try next url
        if (res.status === 404) { lastErr = `${res.status} ${t}`; continue }
        return jsonRes(res.status, { error: { message: t || `ollama error ${res.status}`, type: 'server_error' } })
      }
      const j = (await res.json()) as Record<string, unknown>
      let embeddings: number[][] = []
      if (Array.isArray(j['embeddings'])) embeddings = j['embeddings'] as number[][]
      else if (Array.isArray(j['embedding'])) embeddings = [j['embedding'] as number[]]
      else if (Array.isArray(j['data'])) {
        // already OpenAI shape passthrough
        return jsonRes(200, j)
      } else {
        // single embedding or unknown
        const maybe = j['embedding'] ?? j['embeddings']
        if (maybe) embeddings = Array.isArray((maybe as number[])?.[0]) ? (maybe as number[][]) : [maybe as number[]]
      }
      if (!embeddings.length) return jsonRes(502, { error: { message: 'ollama returned no embeddings', type: 'server_error' } })
      // If single input but multiple embeddings, map 1:1; if Ollama new API returns N
      // Ensure length matches inputs
      if (embeddings.length === 1 && inputs.length > 1) {
        // replicate? no, error
        // but we will expand single to first only
      }
      return jsonRes(200, {
        object: 'list',
        data: embeddings.map((e, i) => ({ object: 'embedding', index: i, embedding: e })),
        model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      })
    } catch (e) {
      lastErr = (e as Error).message ?? String(e)
      // if not 404, continue to next url only on 404; otherwise break
      if (!lastErr.includes('404')) break
    }
  }
  return jsonRes(502, { error: { message: lastErr ?? 'embeddings upstream failed', type: 'server_error' } })
}

// ---------------------------------------------------------------------------
// Fetch-style router — mountable in node http / electron net / tests
// ---------------------------------------------------------------------------

export async function handleOpenAiRequest(req: Request, deps: OpenAiDeps = {}): Promise<Response | null> {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    url = new URL(req.url, `http://${OPENAI_HOST}:${deps.ollamaPort ?? OPENAI_PORT}`)
  }
  const pathname = url.pathname

  // Auth gate — if key supplied and invalid -> 401 early
  const authFail = assertAuthorized(req)
  if (authFail) return authFail

  const method = req.method.toUpperCase()

  // GET /v1/models
  if ((pathname === MODELS_PATH || pathname === `${MODELS_PATH}/`) && method === 'GET') {
    return handleModels(req, deps)
  }
  if ((pathname === MODELS_PATH || pathname === `${MODELS_PATH}/`) && method !== 'GET') {
    return jsonRes(405, { error: { message: `method ${method} not allowed, use GET`, type: 'invalid_request_error' } })
  }

  // POST /v1/chat/completions
  if (pathname === CHAT_COMPLETIONS_PATH || pathname === `${CHAT_COMPLETIONS_PATH}/`) {
    if (method !== 'POST') return jsonRes(405, { error: { message: `method ${method} not allowed, use POST`, type: 'invalid_request_error' } })
    return handleChatCompletions(req, deps)
  }

  // POST /v1/embeddings
  if (pathname === EMBEDDINGS_PATH || pathname === `${EMBEDDINGS_PATH}/`) {
    if (method !== 'POST') return jsonRes(405, { error: { message: `method ${method} not allowed, use POST`, type: 'invalid_request_error' } })
    return handleEmbeddings(req, deps)
  }

  // POST /v1/images/generations（阶段0 生图挂载；非图像路径返回 null 继续走 404）
  const images = await handleImagesRequest(req, deps.images ?? {})
  if (images) return images

  return null
}

export function createOpenAiHandler(deps: OpenAiDeps = {}): (req: Request) => Promise<Response | null> {
  return (req: Request) => handleOpenAiRequest(req, deps)
}

// ---------------------------------------------------------------------------
// Express middleware — (req, res, next)
// ---------------------------------------------------------------------------

export type ExpressReq = { method: string; url: string; headers: Record<string, string>; query?: Record<string, string>; body?: unknown }
export type ExpressRes = { status: (code: number) => ExpressRes; json: (obj: unknown) => void; setHeader: (k: string, v: string) => void; write: (chunk: string) => void; end: (chunk?: string) => void; headersSent?: boolean }
export type ExpressNext = () => void

export function createExpressMiddleware(deps: OpenAiDeps = {}): (req: ExpressReq, res: ExpressRes, next: ExpressNext) => Promise<void> {
  return async (req, res, next) => {
    // Build fetch-like Request
    const protoHost = (req.headers['host'] as string | undefined) ?? `${OPENAI_HOST}:${OPENAI_PORT}`
    const fullUrl = req.url.startsWith('http') ? req.url : `http://${protoHost}${req.url}`
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
    }
    // body handling: express body may already be parsed
    let bodyInit: BodyInit | undefined
    if (req.method.toUpperCase() !== 'GET' && req.method.toUpperCase() !== 'HEAD') {
      if (req.body !== undefined) bodyInit = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
      // if body not parsed, let downstream handle — we treat as empty
    }
    const fetchReq = new Request(fullUrl, { method: req.method, headers, body: bodyInit as string | undefined })
    const result = await handleOpenAiRequest(fetchReq, deps)
    if (!result) { next(); return }
    // SSE streaming case
    const ct = result.headers.get('content-type') ?? ''
    if (ct.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.status(200)
      const reader = (result.body as unknown as ReadableStream<Uint8Array> | null)?.getReader?.()
      if (!reader) {
        const text = await result.text().catch(() => '')
        res.write(text)
        res.end()
        return
      }
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(decoder.decode(value))
        }
      } finally {
        try { reader.releaseLock() } catch { /* ignore */ }
        res.end()
      }
      return
    }
    const status = result.status
    const text = await result.text().catch(() => '')
    let obj: unknown
    try { obj = text ? JSON.parse(text) : {} } catch { obj = { raw: text } }
    res.status(status).json(obj)
  }
}

// Aliases for task spec wording
export const expressMiddleware = createExpressMiddleware
export const createOllamaMiddleware = createExpressMiddleware

// ---------------------------------------------------------------------------
// Elysia plugin — works with Elysia instance or plain route registrar
// ---------------------------------------------------------------------------

export type ElysiaLike = {
  get: (path: string, handler: (ctx: unknown) => unknown) => ElysiaLike
  post: (path: string, handler: (ctx: unknown) => unknown) => ElysiaLike
  all?: (path: string, handler: (ctx: unknown) => unknown) => ElysiaLike
}

export function createElysiaPlugin(deps: OpenAiDeps = {}): (app: ElysiaLike) => ElysiaLike {
  return (app: ElysiaLike) => {
    app.get(MODELS_PATH, async (ctx: unknown) => {
      const c = ctx as { request?: Request; headers?: Record<string, string>; query?: Record<string, string>; set?: { status?: number; headers?: Record<string, string> } }
      const req = c.request ?? new Request(`http://${OPENAI_HOST}:${OPENAI_PORT}${MODELS_PATH}`, { method: 'GET', headers: c.headers as Record<string, string> })
      const res = await handleOpenAiRequest(req, deps)
      if (!res) return
      if (c.set) { c.set.status = res.status; c.set.headers = Object.fromEntries(res.headers.entries()) }
      return res.json()
    })
    app.post(CHAT_COMPLETIONS_PATH, async (ctx: unknown) => {
      const c = ctx as { request?: Request; body?: unknown; headers?: Record<string, string>; set?: { status?: number; headers?: Record<string, string> } }
      // Elysia provides body already parsed; reconstruct Request
      let req: Request
      if (c.request) req = c.request
      else {
        req = new Request(`http://${OPENAI_HOST}:${OPENAI_PORT}${CHAT_COMPLETIONS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
          body: JSON.stringify(c.body ?? {}),
        })
      }
      const res = await handleOpenAiRequest(req, deps)
      if (!res) return
      if (c.set) { c.set.status = res.status; c.set.headers = Object.fromEntries(res.headers.entries()) }
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('text/event-stream')) {
        // For Elysia SSE, return raw stream
        return res.body
      }
      return res.json()
    })
    app.post(EMBEDDINGS_PATH, async (ctx: unknown) => {
      const c = ctx as { request?: Request; body?: unknown; headers?: Record<string, string>; set?: { status?: number; headers?: Record<string, string> } }
      let req: Request
      if (c.request) req = c.request
      else {
        req = new Request(`http://${OPENAI_HOST}:${OPENAI_PORT}${EMBEDDINGS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(c.headers ?? {}) },
          body: JSON.stringify(c.body ?? {}),
        })
      }
      const res = await handleOpenAiRequest(req, deps)
      if (!res) return
      if (c.set) { c.set.status = res.status; c.set.headers = Object.fromEntries(res.headers.entries()) }
      return res.json()
    })
    return app
  }
}

export const elysiaOpenAiPlugin = createElysiaPlugin
export const createElysiaMiddleware = createElysiaPlugin

// ---------------------------------------------------------------------------
// Node http server — binds ONLY to 127.0.0.1
// ---------------------------------------------------------------------------

export function createOpenAiServer(deps: OpenAiDeps & { port?: number; host?: string } = {}): http.Server {
  const host = deps.host ?? OPENAI_HOST
  const port = deps.port ?? OPENAI_PORT
  assertHost(host)
  if (port < 1024 || port > 65535) throw new Error(`port out of range: ${port}`)

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    await new Promise<void>((resolve) => req.on('end', () => resolve()))

    const rawBody = Buffer.concat(chunks).toString('utf-8')
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }
    const protoHost = (req.headers.host as string | undefined) ?? `${host}:${port}`
    const fullUrl = `http://${protoHost}${req.url ?? '/'}`

    const fetchReq = new Request(fullUrl, {
      method: req.method ?? 'GET',
      headers,
      body: rawBody && req.method !== 'GET' && req.method !== 'HEAD' ? rawBody : undefined,
    } as RequestInit)

    const result = await handleOpenAiRequest(fetchReq, deps)
    if (!result) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }))
      return
    }

    const ct = result.headers.get('content-type') ?? 'application/json'
    const status = result.status
    // SSE
    if (ct.includes('text/event-stream')) {
      res.writeHead(status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const body = result.body as unknown as ReadableStream<Uint8Array> | null
      if (!body) { res.end('data: [DONE]\n\n'); return }
      const reader = (body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(decoder.decode(value))
        }
      } finally {
        try { reader.releaseLock() } catch { /* ignore */ }
        res.end()
      }
      return
    }

    const text = await result.text().catch(() => '')
    res.writeHead(status, { 'content-type': ct })
    res.end(text)
  })

  // Ensure server never listens on wildcard — caller must use host param above
  return server
}

export function startOpenAiServer(deps: OpenAiDeps & { port?: number; host?: string } = {}): Promise<http.Server> {
  const server = createOpenAiServer(deps)
  const host = deps.host ?? OPENAI_HOST
  const port = deps.port ?? OPENAI_PORT
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

export function getOpenAiBaseUrl(port: number = OPENAI_PORT): string {
  return `http://${OPENAI_HOST}:${port}/v1`
}
export function getModelsUrl(port: number = OPENAI_PORT): string {
  return `http://${OPENAI_HOST}:${port}${MODELS_PATH}`
}
export function getChatCompletionsUrl(port: number = OPENAI_PORT): string {
  return `http://${OPENAI_HOST}:${port}${CHAT_COMPLETIONS_PATH}`
}
export function getEmbeddingsUrl(port: number = OPENAI_PORT): string {
  return `http://${OPENAI_HOST}:${port}${EMBEDDINGS_PATH}`
}

export default {
  OPENAI_HOST,
  OPENAI_PORT,
  OPENAI_BASE_URL,
  MODELS_PATH,
  CHAT_COMPLETIONS_PATH,
  EMBEDDINGS_PATH,
  handleOpenAiRequest,
  createOpenAiHandler,
  createExpressMiddleware,
  createElysiaPlugin,
  createOpenAiServer,
  startOpenAiServer,
  handleModels,
  handleChatCompletions,
  handleEmbeddings,
}
