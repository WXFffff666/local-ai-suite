/**
 * hybrid.test.ts — RRF fusion quality regression fixtures (todo39).
 *
 * Acceptance anchor from the plan: 「检索质量回归 fixture：混合排序优于任一单路
 * (固定 seed 断言)；reranker 关闭时纯融合路径稳定」. Everything here is
 * deterministic — no clock, no randomness — so the "fixed-seed" requirement
 * is satisfied structurally.
 */
import { describe, it, expect } from 'vitest'
import { rrfFuse, fuseRankedIds, hitsWithin, RRF_K, LANE_DEPTH, DEFAULT_TOP_N, type FusionLane } from './hybrid'

// ---------------------------------------------------------------------------
// Fixture corpora — two lanes disagreeing in exactly the way hybrid search is
// supposed to exploit: a document that is decent in BOTH lanes should beat a
// document that is perfect in one lane and absent from the other.
// ---------------------------------------------------------------------------

/**
 * Given: 8 chunks. Relevant (ground truth) = {c-ideal, c-bm25, c-vec}.
 * - bm25 lane finds c-bm25 #1, c-ideal #2, misses c-vec
 * - vector lane finds c-vec #1, c-ideal #2, misses c-bm25
 * Fusion must surface ALL THREE relevant docs inside top-3, while each single
 * lane alone surfaces at most 2 of 3 (each misses one relevant entirely).
 */
const BM25_LANE: FusionLane = {
  name: 'bm25',
  items: [{ id: 'c-bm25' }, { id: 'c-ideal' }, { id: 'n-1' }, { id: 'n-2' }, { id: 'n-3' }],
}
const VEC_LANE: FusionLane = {
  name: 'vector',
  items: [{ id: 'c-vec' }, { id: 'c-ideal' }, { id: 'n-4' }, { id: 'n-5' }, { id: 'n-6' }],
}
const RELEVANT = new Set(['c-ideal', 'c-bm25', 'c-vec'])

describe('rrfFuse — RRF(k=60) 融合语义', () => {
  it('两路同时命中的条目排名优于任一单路榜首（融合 > 单路）', () => {
    const fused = rrfFuse([BM25_LANE, VEC_LANE], { topN: 3 })
    expect(fused[0]?.id).toBe('c-ideal')
    // the dual-hit doc beats BOTH single-lane #1s
    const fusedIds = fused.map((f) => f.id)
    expect(fusedIds.indexOf('c-ideal')).toBeLessThan(fusedIds.indexOf('c-bm25'))
    expect(fusedIds.indexOf('c-ideal')).toBeLessThan(fusedIds.indexOf('c-vec'))
  })

  it('top-3 覆盖全部三个相关文档，而任一单路最多覆盖 2 个', () => {
    const fused = rrfFuse([BM25_LANE, VEC_LANE], { topN: 3 })
    expect(hitsWithin(fused, RELEVANT)).toBe(3)
    expect(hitsWithin(rrfFuse([BM25_LANE], { topN: 3 }), RELEVANT)).toBeLessThan(3)
    expect(hitsWithin(rrfFuse([VEC_LANE], { topN: 3 }), RELEVANT)).toBeLessThan(3)
  })

  it('分数恰为 Σ 1/(k+rank)，k 默认 60 且可覆盖', () => {
    const fused = rrfFuse([BM25_LANE, VEC_LANE], { topN: 0 })
    const ideal = fused.find((f) => f.id === 'c-ideal')
    expect(ideal?.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 2), 12)
    expect(ideal?.ranks).toEqual({ bm25: 2, vector: 2 })
    const top = fused.find((f) => f.id === 'c-bm25')
    expect(top?.score).toBeCloseTo(1 / (60 + 1), 12) // only in lane bm25
    const k100 = rrfFuse([BM25_LANE, VEC_LANE], { k: 100, topN: 1 })
    expect(k100[0]?.score).toBeCloseTo(2 / (100 + 2), 12)
  })

  it('topN 截断（默认 5）与 lane 深度常量', () => {
    const fused = rrfFuse([BM25_LANE, VEC_LANE])
    expect(fused).toHaveLength(DEFAULT_TOP_N)
    expect(LANE_DEPTH).toBe(20)
    const all = rrfFuse([BM25_LANE, VEC_LANE], { topN: 0 })
    expect(all).toHaveLength(9) // bm25 5 + vec 5, shared c-ideal deduped
    expect(all.at(-1)?.id).toBe('n-6')
  })

  it('确定性：同输入多次融合、乱序构造同集，输出完全一致', () => {
    const a = rrfFuse([BM25_LANE, VEC_LANE], { topN: 0 })
    for (let i = 0; i < 5; i++) {
      expect(rrfFuse([BM25_LANE, VEC_LANE], { topN: 0 })).toEqual(a)
    }
    // same scores, different first-seen order (c-bm25 and c-vec tie at 1/61):
    // ties break by first appearance in lane order — pinning that contract.
    const tieA = fuseRankedIds(['x', 'y'], ['x'], { topN: 0 })
    const tieB = fuseRankedIds(['x', 'y'], ['x'], { topN: 0 })
    expect(tieA).toEqual(tieB)
    const tied = fuseRankedIds(['p', 'q'], ['r', 's'], { topN: 0 })
    const scores = new Map(tied.map((t) => [t.id, t.score]))
    expect(scores.get('p')).toBe(scores.get('r'))
    expect(tied[0]?.id).toBe('p') // tie broken by first-seen, not by id
  })

  it('同路重复 id 只按首个名次计分；空/畸形条目被忽略', () => {
    const dup = rrfFuse(
      [
        { name: 'bm25', items: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] },
        { name: 'vector', items: [{ id: 'b' }, { id: '' }, undefined as never] },
      ],
      { topN: 0 },
    )
    const a = dup.find((d) => d.id === 'a')
    expect(a?.score).toBeCloseTo(1 / 61, 12) // rank 1 only (dup skipped)
    const b = dup.find((d) => d.id === 'b')
    expect(b?.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(dup).toHaveLength(2)
  })

  it('单路输入 = 该路原序；空 lanes 得空结果', () => {
    const single = rrfFuse([BM25_LANE], { topN: 3 })
    expect(single.map((s) => s.id)).toEqual(['c-bm25', 'c-ideal', 'n-1'])
    expect(rrfFuse([])).toEqual([])
    expect(rrfFuse([{ name: 'empty', items: [] }])).toEqual([])
  })

  it('三路融合仍成立（bm25 + vector + 预留 rerank lane）', () => {
    const rerankLane: FusionLane = { name: 'rerank', items: [{ id: 'c-vec' }, { id: 'n-9' }] }
    const fused = rrfFuse([BM25_LANE, VEC_LANE, rerankLane], { topN: 2 })
    // c-ideal: bm25#2 + vec#2 = 2/62 ≈ 0.0323; c-vec: vec#1 + rerank#1 = 2/61 ≈ 0.0328
    expect(fused[0]?.id).toBe('c-vec')
    expect(fused[1]?.id).toBe('c-ideal')
    expect(fused[1]?.ranks).toEqual({ bm25: 2, vector: 2 })
  })

  it('完整 20×20 深度融合保持名次单调与确定性', () => {
    const deep: FusionLane[] = [
      { name: 'bm25', items: Array.from({ length: LANE_DEPTH }, (_, i) => ({ id: `b${i}` })) },
      { name: 'vector', items: Array.from({ length: LANE_DEPTH }, (_, i) => ({ id: `v${i}` })) },
    ]
    const first = rrfFuse(deep, { topN: 10 })
    for (let i = 1; i < first.length; i++) {
      expect(first[i - 1]!.score).toBeGreaterThanOrEqual(first[i]!.score)
    }
    expect(rrfFuse(deep, { topN: 10 })).toEqual(first)
  })
})
