/**
 * citations.ts — build the [n] citation cards the RAG answer surfaces (todo39).
 * Pure + deterministic: given a HybridHit and the query, computes a page/line
 * anchor the UI turns into a clickable「定位原文片段」chip. No I/O, no clock.
 *
 * page/line semantics for a flat text/PDF chunk stream:
 *   page = chunk_index (0-based within its source doc) — the FTS5 chunk page
 *   line = 1-based line (within that chunk) of the first query-term occurrence
 *          (falls back to the character offset of the first term when the
 *           chunk has no newlines, so the anchor is always meaningful).
 * snippet = a ≤ SNIPPET_LEN window centred on that first match for display.
 *
 * MIT only, no AGPL.
 */

import type { HybridHit } from './ingest'
import type { RagCitation } from '../main/ipc/whitelist'

export const SNIPPET_LEN = 200

/** Tokens used for the locate pass — lowercased, punctuation-stripped. */
export function citationTerms(query: string): string[] {
  const q = (query ?? '').toLowerCase()
  const re = /[a-z0-9_]+|[\u3400-\u9fff\uf900-\ufaff]/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(q))) {
    if (!out.includes(m[0])) out.push(m[0])
  }
  return out
}

/** The [n] citation card shape IS the IPC wire contract (single definition). */
export type Citation = RagCitation

/** First occurrence (byte offset) of any term in content, -1 if none. */
export function firstMatchOffset(content: string, terms: readonly string[]): number {
  const hay = content.toLowerCase()
  let best = -1
  for (const t of terms) {
    const idx = hay.indexOf(t)
    if (idx !== -1 && (best === -1 || idx < best)) best = idx
  }
  return best
}

/** 1-based line number of a char offset within content. */
export function lineAtOffset(content: string, offset: number): number {
  if (offset <= 0) return 1
  let line = 1
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1
  }
  return line
}

function windowSnippet(content: string, center: number): string {
  const text = content.replace(/\s+/g, ' ').trim()
  if (text.length <= SNIPPET_LEN) return text
  const anchor = center < 0 ? 0 : Math.min(center, text.length)
  const half = Math.floor(SNIPPET_LEN / 2)
  const start = Math.max(0, anchor - half)
  const end = Math.min(text.length, start + SNIPPET_LEN)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end) + suffix
}

/**
 * Turn fused hybrid hits into ordered [n] citation cards. Index `n` follows
 * the array order the caller supplies (fusion or rerank order — the caller
 * owns the final ranking, this stays a faithful projection).
 */
export function buildCitations(hits: readonly HybridHit[], query: string): Citation[] {
  const terms = citationTerms(query)
  return hits.map((h, i) => {
    const content = h.chunk.content
    const offset = firstMatchOffset(content, terms)
    const line = offset === -1 ? 1 : lineAtOffset(content, offset)
    const citation: Citation = {
      n: i + 1,
      chunkId: h.chunk.id,
      source: h.chunk.source,
      page: h.chunk.index,
      line,
      charOffset: offset,
      snippet: windowSnippet(content, offset),
      rrf: h.rrf,
      ranks: h.ranks,
    }
    if (h.bm25Score !== undefined) citation.bm25Score = h.bm25Score
    return citation
  })
}

/**
 * Re-apply [n] numbering after a rerank reorder + attach rerank scores.
 * `ordered` is the post-rerank citation list (already best-first); rerankScores
 * maps chunkId -> relevance.
 */
export function applyRerankToCitations(
  ordered: readonly Citation[],
  rerankScores: ReadonlyMap<string, number>,
): Citation[] {
  return ordered.map((c, i) => {
    const merged: Citation = { ...c, n: i + 1 }
    const score = rerankScores.get(c.chunkId)
    if (score !== undefined) merged.rerankScore = score
    return merged
  })
}
