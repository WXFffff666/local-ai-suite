/**
 * citations.test.ts — pure anchor math for the [n] cards (todo39): line/page
 * location, snippet windowing, dense re-numbering after a rerank reorder.
 */
import { describe, it, expect } from 'vitest'
import { buildCitations, applyRerankToCitations, citationTerms, firstMatchOffset, lineAtOffset, SNIPPET_LEN, type Citation } from './citations'
import type { HybridHit } from './ingest'

function hit(id: string, content: string, source = 'doc.md', index = 0, extra: Partial<HybridHit> = {}): HybridHit {
  return {
    chunk: { id, content, source, index, createdAt: 1 },
    rrf: extra.rrf ?? 0.03,
    ranks: extra.ranks ?? { bm25: 1 },
    ...(extra.bm25Score === undefined ? {} : { bm25Score: extra.bm25Score }),
  }
}

describe('citationTerms / firstMatchOffset / lineAtOffset', () => {
  it('terms dedupe ascii words + single CJK chars', () => {
    expect(citationTerms('Hybrid hybrid 检索 BM25!')).toEqual(['hybrid', '检', '索', 'bm25'])
    expect(citationTerms('')).toEqual([])
  })

  it('firstMatchOffset returns earliest term hit or -1', () => {
    expect(firstMatchOffset('alpha BETA gamma', ['beta', 'gamma'])).toBe(6)
    expect(firstMatchOffset('nothing here', ['zzz'])).toBe(-1)
  })

  it('lineAtOffset counts newlines 1-based', () => {
    expect(lineAtOffset('l1\nl2\nl3', 0)).toBe(1)
    expect(lineAtOffset('l1\nl2\nl3', 5)).toBe(2)
    expect(lineAtOffset('l1\nl2\nl3', 6)).toBe(3)
    expect(lineAtOffset('abc', -1)).toBe(1)
  })
})

describe('buildCitations', () => {
  it('numbers dense [n], records page/line/snippet from the first match', () => {
    const cards = buildCitations(
      [
        hit('a#0', 'intro line\nsecond line about vector search', 'v.md', 0, { ranks: { bm25: 1, vector: 2 }, bm25Score: 3.2 }),
        hit('b#0', 'unrelated prose', 'u.md', 1),
      ],
      'vector search',
    )
    expect(cards.map((c) => c.n)).toEqual([1, 2])
    expect(cards[0]).toMatchObject({ chunkId: 'a#0', source: 'v.md', page: 0, bm25Score: 3.2 })
    expect(cards[0]!.line).toBe(2)
    expect(cards[0]!.snippet).toContain('vector')
    // no-match citation still emits with line 1
    expect(cards[1]).toMatchObject({ line: 1, charOffset: -1, page: 1 })
    expect(cards[1]!.ranks).toEqual({ bm25: 1 })
  })

  it('long chunk content is windowed to <= SNIPPET_LEN (+ ellipses)', () => {
    const big = `${'padding '.repeat(60)}vector core here ${'tail '.repeat(60)}`
    const [card] = buildCitations([hit('c#0', big)], 'vector')
    expect(card!.snippet.length).toBeLessThanOrEqual(SNIPPET_LEN + 2)
    expect(card!.snippet).toContain('vector')
  })
})

describe('applyRerankToCitations', () => {
  it('renumbers by rerank order and attaches scores to the right cards', () => {
    const cards = buildCitations([hit('x#0', 'alpha'), hit('y#0', 'beta'), hit('z#0', 'gamma')], 'nomatch')
    const reordered = [cards[2]!, cards[0]!]
    const out = applyRerankToCitations(reordered, new Map([['z#0', 0.99], ['x#0', 0.5]]))
    expect(out.map((c) => [c.n, c.chunkId, c.rerankScore])).toEqual([
      [1, 'z#0', 0.99],
      [2, 'x#0', 0.5],
    ])
    expect(out[0]).toMatchObject({ rrf: cards[2]!.rrf }) // provenance survives
  })

  it('cards without a rerank score keep undefined (never fabricated)', () => {
    const cards = buildCitations([hit('m#0', 'text')], 'q')
    const out = applyRerankToCitations(cards, new Map<string, number>())
    expect((out[0] as Citation).rerankScore).toBeUndefined()
  })
})
