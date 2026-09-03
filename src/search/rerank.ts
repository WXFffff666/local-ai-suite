/**
 * rerank.ts — llama.cpp `/v1/rerank` client for the optional second-stage
 * 精排 lane (plan todo39 / Appendix A row 39, R3b LIVE-verified anchor):
 *
 *   llama.cpp exposes POST /v1/rerank but it is DEFAULT-OFF — the server must
 *   be started with `--rerank` (env LLAMA_ARG_RERANKING) for a rerank-capable
 *   GGUF (e.g. bge-reranker-v2-m3). buildLlamaArgs({rerank:true}) emits the
 *   flag; launchModel detects rerank models from the registry path/name.
 *
 * Port semantics (facade-aware): the 11434 OpenAI facade does NOT forward
 * /v1/rerank (its upstream surface is models/chat/embeddings — rerank
 * passthrough was ruled into the todo11 forwarding lane, not this one), so
 * the client dials the internal llama-server port directly. The caller may
 * still inject any baseUrl; nothing here ever leaves 127.0.0.1 by default.
 *
 * Graceful-unavailable contract: every failure mode resolves to
 * { ok:false, reason } — a timeout, a 404 (server up, --rerank not passed),
 * a refused connection (server down) or a malformed body. The hybrid query
 * path then keeps the pure RRF fusion ordering (rerank is an optional
 * polish, never a hard dependency).
 *
 * MIT only, no AGPL.
 */

import { LLAMA_HOST, LLAMA_PORT } from '../sidecars/llama'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RERANK_PATH = '/v1/rerank' as const
/** Rerank is optional; a hung server must never hang the query path. */
export const DEFAULT_RERANK_TIMEOUT_MS = 8_000
/** Cap the scored batch; fusion already truncated the lanes. */
export const MAX_RERANK_DOCUMENTS = 64
/** Default served reranker (GGUF) for the llama-server --rerank path. */
export const DEFAULT_RERANK_MODEL = 'bge-reranker-v2-m3'

export function getRerankUrl(port: number = LLAMA_PORT): string {
  return `http://${LLAMA_HOST}:${port}${RERANK_PATH}`
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RerankFetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type RerankRequest = {
  query: string
  /** Candidate documents, in fusion order. `index` in the outcome refers here. */
  documents: readonly string[]
  /** Reranker model name as served (bge-reranker gguf default below). */
  model?: string
  /** keep top-N after scoring (default: all) */
  topN?: number
  port?: number
  /** full URL override (tests / alternate facade mounts) */
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: RerankFetchLike
  signal?: AbortSignal
}

/** One reranked document: original array index + relevance score. */
export type RerankScore = {
  index: number
  /** llama.cpp sigmoid relevance over the rerank head logits */
  score: number
}

export type RerankUnavailableReason =
  | 'not-configured'
  | 'empty-documents'
  | 'timeout'
  | 'unreachable'
  | 'http'
  | 'malformed'
  | 'aborted'

export type RerankOutcome =
  | { ok: true; model: string; results: RerankScore[] }
  | { ok: false; reason: RerankUnavailableReason; detail?: string }

// ---------------------------------------------------------------------------
// Response parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Parse the llama.cpp /v1/rerank JSON shape
 * `{ results: [{ index, relevance_score, document? }] }`.
 * Output is normalized descending by score, ties by ascending index — the
 * rerank lane ordering is therefore deterministic given the documents array.
 * null => malformed (caller reports the graceful unavailable state).
 */
export function parseRerankBody(json: unknown, expectedCount: number): RerankScore[] | null {
  if (json === null || typeof json !== 'object') return null
  const results = (json as { results?: unknown }).results
  if (!Array.isArray(results)) return null
  const out: RerankScore[] = []
  for (const entry of results) {
    if (entry === null || typeof entry !== 'object') return null
    const e = entry as { index?: unknown; relevance_score?: unknown }
    const index = typeof e.index === 'number' && Number.isInteger(e.index) ? e.index : null
    const score =
      typeof e.relevance_score === 'number' && Number.isFinite(e.relevance_score) ? e.relevance_score : null
    if (index === null || score === null || index < 0 || index >= expectedCount) return null
    out.push({ index, score })
  }
  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
  return out
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * POST /v1/rerank. Never rejects: every error class lands in the
 * RerankOutcome union so the caller branches on `ok` exhaustively instead of
 * juggling unknown throws. `topN` truncates the descending-scored result set.
 */
export async function rerankDocuments(req: RerankRequest): Promise<RerankOutcome> {
  const model = req.model?.trim() || DEFAULT_RERANK_MODEL
  const docs = req.documents.slice(0, MAX_RERANK_DOCUMENTS)
  if (docs.length === 0) return { ok: false, reason: 'empty-documents' }
  const url = req.baseUrl ?? getRerankUrl(req.port ?? LLAMA_PORT)
  const doFetch: RerankFetchLike = req.fetchImpl ?? ((u, init) => fetch(u, init))
  const timeoutMs = req.timeoutMs ?? DEFAULT_RERANK_TIMEOUT_MS
  const outerSignal = req.signal

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuterAbort = (): void => ctrl.abort()
  if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort, { once: true })
  try {
    if (outerSignal?.aborted) return { ok: false, reason: 'aborted' }
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model, query: req.query, documents: [...docs], top_n: docs.length }),
        signal: ctrl.signal,
      })
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      if (aborted && outerSignal?.aborted) return { ok: false, reason: 'aborted', detail: String(error.message) }
      if (aborted) return { ok: false, reason: 'timeout', detail: `rerank timed out after ${timeoutMs}ms` }
      return { ok: false, reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, reason: 'http', detail: `${res.status} ${text}`.trim() }
    }
    let json: unknown
    try {
      json = await res.json()
    } catch (error) {
      if (ctrl.signal.aborted) return { ok: false, reason: 'timeout', detail: `rerank timed out after ${timeoutMs}ms` }
      return { ok: false, reason: 'malformed', detail: error instanceof Error ? error.message : String(error) }
    }
    const parsed = parseRerankBody(json, docs.length)
    if (parsed === null) return { ok: false, reason: 'malformed', detail: 'results[] shape mismatch' }
    const topN = req.topN ?? parsed.length
    return { ok: true, model, results: topN >= 0 ? parsed.slice(0, topN) : parsed }
  } finally {
    clearTimeout(timer)
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * Apply a rerank outcome to a hits array: the caller's documents array must be
 * hits.map(content) so `index` addresses the hit list. Ranked hits come first
 * (rerank order); hits the reranker never mentioned keep their fusion order
 * at the tail. Carries each hit's rerank score through. Pure + deterministic.
 */
export function applyRerankToHits<T>(
  hits: readonly T[],
  outcome: Extract<RerankOutcome, { ok: true }>,
): Array<{ hit: T; rerankScore?: number }> {
  const used = new Set<number>()
  const head: Array<{ hit: T; rerankScore?: number }> = []
  for (const r of outcome.results) {
    if (r.index >= hits.length) continue
    used.add(r.index)
    head.push({ hit: hits[r.index]!, rerankScore: r.score })
  }
  const tail: Array<{ hit: T; rerankScore?: number }> = []
  hits.forEach((hit, idx) => {
    if (!used.has(idx)) tail.push({ hit })
  })
  return [...head, ...tail]
}
