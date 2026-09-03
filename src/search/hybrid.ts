/**
 * hybrid.ts — RRF (Reciprocal Rank Fusion) for the BM25 × vector hybrid lane
 * (todo39, RAG v1). Pure functions, zero I/O: the ranked id lists come from
 * RagStore.bm25Search (FTS5) and RagStore.retrieve (sqlite-vec / brute cosine),
 * each truncated to LANE_DEPTH=20, and are fused here into one deterministic
 * ranking. k=60 is the canonical RRF smoothing constant (Cormack et al.).
 *
 * Determinism contract: contribution sums are floats added in fixed lane
 * order; ties fall back to first-seen lane position (bm25 before vector when
 * lanes are passed in that order). Same inputs => byte-identical output, no
 * clock, no randomness — the "sorting beats either single lane" fixture in
 * hybrid.test.ts relies on this.
 *
 * MIT only, no AGPL.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical RRF smoothing constant. */
export const RRF_K = 60
/** Each retrieval lane contributes at most this many ranked candidates. */
export const LANE_DEPTH = 20
/** Fused output size default (citation card count for one RAG answer). */
export const DEFAULT_TOP_N = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One candidate inside a ranked lane (order = rank, score is lane-local). */
export type ScoredRef = {
  id: string
  /** lane-local relevance score (bm25 is negative-is-better, cosine positive) */
  score?: number
}

/** A named retrieval lane, already sorted best-first. */
export type FusionLane = {
  name: string
  items: readonly ScoredRef[]
}

/** One fused candidate with its per-lane rank provenance. */
export type FusedItem = {
  id: string
  /** Σ_lane 1 / (RRF_K + rank) — higher is better */
  score: number
  /** lane name -> 1-based rank the item held in that lane */
  ranks: Record<string, number>
}

export type FuseOptions = {
  /** RRF smoothing constant, default 60 */
  k?: number
  /** output size, default DEFAULT_TOP_N; 0/negative => all items */
  topN?: number
}

// ---------------------------------------------------------------------------
// Core fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion over N ranked lanes.
 * - an item's fused score = Σ over lanes containing it of 1/(k + rank),
 *   rank being 1-based within the lane
 * - item order for tie-breaking is first-appearance across lanes in the
 *   given lane order (stable, deterministic)
 * - duplicate ids inside ONE lane are ignored after the first occurrence
 */
export function rrfFuse(lanes: readonly FusionLane[], opts: FuseOptions = {}): FusedItem[] {
  const k = opts.k ?? RRF_K
  const fused = new Map<string, FusedItem>()
  for (const lane of lanes) {
    let rank = 0
    for (const item of lane.items) {
      if (!item || typeof item.id !== 'string' || item.id.length === 0) continue
      rank += 1
      if (fused.has(item.id)) continue
      fused.set(item.id, { id: item.id, score: 0, ranks: {} })
    }
  }
  // second pass: add contributions in lane order (float adds stay ordered)
  for (const lane of lanes) {
    let rank = 0
    for (const item of lane.items) {
      if (!item || typeof item.id !== 'string' || item.id.length === 0) continue
      rank += 1
      const entry = fused.get(item.id)
      if (entry === undefined) continue
      if (entry.ranks[lane.name] !== undefined) continue // dup inside same lane: first wins
      entry.ranks[lane.name] = rank
      entry.score += 1 / (k + rank)
    }
  }
  const ordered = [...fused.values()]
  ordered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return firstSeenIndex(a.id, lanes) - firstSeenIndex(b.id, lanes)
  })
  const topN = opts.topN ?? DEFAULT_TOP_N
  const sliced = topN > 0 ? ordered.slice(0, topN) : ordered
  return sliced
}

// memoization is unnecessary: lanes are ≤ LANE_DEPTH long; the index scan
// keeps rrfFuse allocation-light and pure.
function firstSeenIndex(id: string, lanes: readonly FusionLane[]): number {
  let idx = 0
  for (const lane of lanes) {
    for (const item of lane.items) {
      if (item?.id === id) return idx
      idx += 1
    }
  }
  return idx
}

/** Convenience: fuse two already-ordered id lists (bm25 lane + vector lane). */
export function fuseRankedIds(
  bm25Ids: readonly string[],
  vectorIds: readonly string[],
  opts: FuseOptions = {},
): FusedItem[] {
  return rrfFuse(
    [
      { name: 'bm25', items: bm25Ids.map((id) => ({ id })) },
      { name: 'vector', items: vectorIds.map((id) => ({ id })) },
    ],
    opts,
  )
}

/**
 * Evaluate a ranking against a ground-truth relevant set: returns precision@topN
 * style hit count. Used by the quality-regression fixture (fusion must hit >=
 * either single lane) — pure so the assertion cannot drift from the data.
 */
export function hitsWithin(fused: readonly FusedItem[], relevant: ReadonlySet<string>): number {
  let n = 0
  for (const f of fused) if (relevant.has(f.id)) n += 1
  return n
}
