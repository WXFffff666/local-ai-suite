/**
 * embed.ts — embeddings 三态裁决 client (todo39, r2-fix ruling).
 *
 * The RAG vector lane needs an embedding source; the plan adjudicates three
 * states, checked in this order against the live 127.0.0.1 engines:
 *
 *   'ollama'   — Ollama (or the external-takeover OpenAI-compat peer) answers
 *                GET /api/tags AND exposes an embedding-capable model (the
 *                configured one, or auto-discovered by name); embeds go to
 *                POST /api/embeddings {model, prompt} -> {embedding}.
 *   'internal' — no Ollama, but the internal llama-server answers
 *                POST /v1/embeddings (only true when the embedding GGUF was
 *                launched with --embeddings, see buildLlamaArgs +
 *                services.launchModel capability detection).
 *   'hash'     — neither upstream: deterministic FNV hash-embed placeholder
 *                (RagStore.hashEmbed). UI must surface the degraded notice
 *                「检索质量降级（无本地嵌入引擎）」 whenever mode === 'hash'.
 *
 * Every probe is side-effect-free (GET/1-token POST against already-listening
 * loopback ports) with a short budget; failures collapse to the next state.
 * MIT only, no AGPL.
 */

import { hashEmbed, DEFAULT_EMBED_DIM, type EmbedFn } from './ingest'
import { LLAMA_HOST, LLAMA_PORT } from '../sidecars/llama'
import { OLLAMA_HOST, OLLAMA_PORT } from '../api/openai'

// ---------------------------------------------------------------------------
// Constants / types
// ---------------------------------------------------------------------------

export const EMBEDDING_MODES = ['ollama', 'internal', 'hash'] as const
export type EmbeddingMode = (typeof EMBEDDING_MODES)[number]

/** UI copy for the degraded state (plan wording, verbatim). */
export const DEGRADED_EMBEDDING_NOTICE = '检索质量降级（无本地嵌入引擎）'

/** Ollama model-name heuristic when no embeddingModel is configured. */
export const OLLAMA_EMBED_NAME_RE = /embed|bge|e5|nomic/i

/** /api/tags probes must never stall a search gesture. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_500

export type EmbedFetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type EmbedClientOptions = {
  /** configured embedding model name ('' = auto-detect / unavailable) */
  embeddingModel?: string
  ollamaPort?: number
  llamaPort?: number
  timeoutMs?: number
  fetchImpl?: EmbedFetchLike
  /** hash-mode vector width */
  hashDim?: number
}

export type EmbeddingResolution = {
  mode: EmbeddingMode
  /** served model name; absent in hash mode */
  model?: string
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function fetchWithTimeout(
  doFetch: EmbedFetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  return doFetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

/**
 * Ollama arm: list served models, pick the embedding-capable one.
 * Configured name matches a tag exactly -> it; else the first /embed/i tag;
 * else null (Ollama up but no embed model => not usable for this lane).
 */
export async function probeOllamaEmbedModel(opts: EmbedClientOptions = {}): Promise<string | null> {
  const port = opts.ollamaPort ?? OLLAMA_PORT
  const doFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  try {
    const res = await fetchWithTimeout(doFetch, `http://${OLLAMA_HOST}:${port}/api/tags`, { method: 'GET' }, opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    if (!res.ok) return null
    const json = (await res.json()) as { models?: Array<{ name?: unknown }> }
    const tags = (json.models ?? []).map((m) => (typeof m.name === 'string' ? m.name : '')).filter((n) => n !== '')
    const configured = (opts.embeddingModel ?? '').trim()
    if (configured) {
      if (tags.includes(configured)) return configured
      // configured-but-missing model is still the user's stated intent only
      // when nothing else fits; /api/embeddings would 404 — refuse the arm.
      return null
    }
    return tags.find((t) => OLLAMA_EMBED_NAME_RE.test(t)) ?? null
  } catch {
    return null
  }
}

/**
 * Internal arm: the llama-server answers OpenAI /v1/embeddings ONLY when
 * launched --embeddings. A 1-token probe both detects capability and proves
 * the served model (its name echoes in the body we send). A chat-model
 * instance returns 4xx/5xx => false (never throws).
 */
export async function probeInternalEmbeddings(opts: EmbedClientOptions = {}): Promise<boolean> {
  const port = opts.llamaPort ?? LLAMA_PORT
  const doFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const model = (opts.embeddingModel ?? '').trim() || 'embeddings'
  try {
    const res = await fetchWithTimeout(
      doFetch,
      `http://${LLAMA_HOST}:${port}/v1/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: 'ping' }),
      },
      opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    )
    if (!res.ok) return false
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null
    const data = json?.data
    if (!Array.isArray(data) || data.length === 0) return false
    // a real embeddings server echoes OpenAI shape: data[0].embedding:number[]
    const first = data[0] as { embedding?: unknown } | null
    return first !== null && typeof first === 'object' && isNumberArray(first.embedding)
  } catch {
    return false
  }
}

/** Three-state adjudication (ollama > internal > hash). Never throws. */
export async function resolveEmbeddingMode(opts: EmbedClientOptions = {}): Promise<EmbeddingResolution> {
  const ollamaModel = await probeOllamaEmbedModel(opts)
  if (ollamaModel !== null) return { mode: 'ollama', model: ollamaModel }
  if (await probeInternalEmbeddings(opts)) {
    const model = (opts.embeddingModel ?? '').trim() || 'internal-embeddings'
    return { mode: 'internal', model }
  }
  return { mode: 'hash' }
}

// ---------------------------------------------------------------------------
// Embed functions (RagStore.EmbedFn compatible)
// ---------------------------------------------------------------------------

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n))
}

/** Ollama POST /api/embeddings {model, prompt} -> {embedding}. Sequential. */
export async function ollamaEmbed(
  texts: string[],
  model: string,
  opts: EmbedClientOptions = {},
): Promise<number[][]> {
  const port = opts.ollamaPort ?? OLLAMA_PORT
  const doFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const out: number[][] = []
  for (const text of texts) {
    const res = await fetchWithTimeout(
      doFetch,
      `http://${OLLAMA_HOST}:${port}/api/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      },
      timeoutMs,
    )
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`ollama /api/embeddings ${res.status} ${t}`.trim())
    }
    const json = (await res.json()) as { embedding?: unknown }
    if (!isNumberArray(json.embedding)) throw new Error('ollama /api/embeddings returned no embedding')
    out.push(json.embedding)
  }
  return out
}

/** Internal llama-server POST /v1/embeddings {model, input[]} -> data[].embedding. */
export async function internalEmbed(
  texts: string[],
  model: string,
  opts: EmbedClientOptions = {},
): Promise<number[][]> {
  const port = opts.llamaPort ?? LLAMA_PORT
  const doFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init))
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const res = await fetchWithTimeout(
    doFetch,
    `http://${LLAMA_HOST}:${port}/v1/embeddings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    },
    timeoutMs,
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`llama /v1/embeddings ${res.status} ${t}`.trim())
  }
  const json = (await res.json()) as { data?: unknown }
  const data = Array.isArray(json.data) ? json.data : null
  if (data === null || data.length !== texts.length) throw new Error('llama /v1/embeddings returned mismatched data[]')
  return data.map((d) => {
    const emb = (d as { embedding?: unknown }).embedding
    if (!isNumberArray(emb)) throw new Error('llama /v1/embeddings returned a non-numeric embedding')
    return emb
  })
}

/** Build the RagStore embedFn for a resolved mode (hash stays local). */
export function embedFnForMode(resolution: EmbeddingResolution, opts: EmbedClientOptions = {}): EmbedFn {
  switch (resolution.mode) {
    case 'ollama': {
      const model = resolution.model
      if (model === undefined) throw new Error('ollama resolution missing model')
      return (texts: string[]) => ollamaEmbed(texts, model, opts)
    }
    case 'internal': {
      const model = resolution.model ?? 'internal-embeddings'
      return (texts: string[]) => internalEmbed(texts, model, opts)
    }
    case 'hash': {
      const dim = opts.hashDim ?? DEFAULT_EMBED_DIM
      return (texts: string[]) => hashEmbed(texts, dim)
    }
    default: {
      const unreachable: never = resolution.mode
      throw new Error(`unknown embedding mode: ${String(unreachable)}`)
    }
  }
}
