/**
 * rerank.test.ts — graceful-unavailable state machine + deterministic order
 * (todo39). No real network: the fetch seam is always a fake, and the timeout
 * path is driven through an AbortSignal-aware stub.
 */
import { describe, it, expect } from 'vitest'
import {
  rerankDocuments,
  parseRerankBody,
  applyRerankToHits,
  getRerankUrl,
  RERANK_PATH,
  DEFAULT_RERANK_MODEL,
  MAX_RERANK_DOCUMENTS,
} from './rerank'
import { LLAMA_HOST, LLAMA_PORT } from '../sidecars/llama'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** fetch stub that rejects with AbortError once its signal fires (timeout sim). */
function abortableFetch(delayMs: number) {
  return (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const t = setTimeout(() => reject(new DOMException('This operation was aborted', 'AbortError')), delayMs)
      signal?.addEventListener('abort', () => {
        clearTimeout(t)
        reject(new DOMException('This operation was aborted', 'AbortError'))
      })
    })
}

describe('getRerankUrl — 127.0.0.1 confinement + llama port default', () => {
  it('defaults to the internal llama-server, never the facade port', () => {
    expect(getRerankUrl()).toBe(`http://${LLAMA_HOST}:${LLAMA_PORT}${RERANK_PATH}`)
    expect(getRerankUrl(12345)).toContain(':12345/v1/rerank')
  })
})

describe('parseRerankBody — llama.cpp results[] shape', () => {
  it('scores normalize descending, ties by ascending index', () => {
    const parsed = parseRerankBody(
      {
        results: [
          { index: 0, relevance_score: 0.2 },
          { index: 1, relevance_score: 0.9 },
          { index: 2, relevance_score: 0.2 },
        ],
      },
      3,
    )
    expect(parsed).toEqual([
      { index: 1, score: 0.9 },
      { index: 0, score: 0.2 },
      { index: 2, score: 0.2 },
    ])
  })

  it('rejects non-array results / out-of-range index / NaN score', () => {
    expect(parseRerankBody({ results: 'x' }, 2)).toBeNull()
    expect(parseRerankBody({}, 2)).toBeNull()
    expect(parseRerankBody({ results: [{ index: 5, relevance_score: 0.1 }] }, 2)).toBeNull()
    expect(parseRerankBody({ results: [{ index: 1, relevance_score: Number.NaN }] }, 2)).toBeNull()
    expect(parseRerankBody(null, 1)).toBeNull()
  })
})

describe('rerankDocuments — happy path', () => {
  it('posts the llama.cpp wire body and returns ordered scores', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null
    const outcome = await rerankDocuments({
      query: 'what is rrf',
      documents: ['doc a', 'doc b', 'doc c'],
      port: 11999,
      fetchImpl: async (url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> }
        return jsonResponse(200, {
          results: [
            { index: 2, relevance_score: 0.91 },
            { index: 0, relevance_score: 0.42 },
            { index: 1, relevance_score: 0.1 },
          ],
        })
      },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map((r) => r.index)).toEqual([2, 0, 1])
    expect(seen!.url).toContain(':11999')
    expect(seen!.body.model).toBe(DEFAULT_RERANK_MODEL)
    expect(seen!.body.query).toBe('what is rrf')
    expect(seen!.body.documents).toEqual(['doc a', 'doc b', 'doc c'])
    expect(seen!.body.top_n).toBe(3)
  })

  it('topN truncates after descending normalization', async () => {
    const outcome = await rerankDocuments({
      query: 'q',
      documents: ['a', 'b', 'c'],
      topN: 2,
      fetchImpl: async () =>
        jsonResponse(200, {
          results: [
            { index: 0, relevance_score: 0.1 },
            { index: 1, relevance_score: 0.8 },
            { index: 2, relevance_score: 0.5 },
          ],
        }),
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      { index: 1, score: 0.8 },
      { index: 2, score: 0.5 },
    ])
  })

  it('empty documents short-circuit without a request', async () => {
    let called = false
    const outcome = await rerankDocuments({
      query: 'q',
      documents: [],
      fetchImpl: async () => {
        called = true
        return jsonResponse(200, { results: [] })
      },
    })
    expect(outcome).toEqual({ ok: false, reason: 'empty-documents' })
    expect(called).toBe(false)
  })

  it('documents are capped at MAX_RERANK_DOCUMENTS', async () => {
    let sentCount = -1
    await rerankDocuments({
      query: 'q',
      documents: Array.from({ length: MAX_RERANK_DOCUMENTS + 10 }, (_, i) => `d${i}`),
      fetchImpl: async (_u, init) => {
        const body = JSON.parse(String(init?.body)) as { documents: string[] }
        sentCount = body.documents.length
        return jsonResponse(200, { results: [{ index: 0, relevance_score: 1 }] })
      },
    })
    expect(sentCount).toBe(MAX_RERANK_DOCUMENTS)
  })
})

describe('rerankDocuments — graceful unavailable states', () => {
  it('404 (endpoint present, --rerank flag missing) → reason http with status detail', async () => {
    const outcome = await rerankDocuments({
      query: 'q',
      documents: ['a'],
      fetchImpl: async () => jsonResponse(404, { error: 'reranking is not enabled' }),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('http')
    expect(outcome.detail).toContain('404')
  })

  it('connection refused → unreachable', async () => {
    const outcome = await rerankDocuments({
      query: 'q',
      documents: ['a'],
      fetchImpl: async () => {
        throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:11435')
      },
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('unreachable')
    expect(outcome.detail).toContain('ECONNREFUSED')
  })

  it('slow server trips the timeout budget → timeout', async () => {
    const outcome = await rerankDocuments({
      query: 'q',
      documents: ['a'],
      timeoutMs: 5,
      fetchImpl: abortableFetch(5_000),
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('caller abort signal wins over timeout → aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const outcome = await rerankDocuments({
      query: 'q',
      documents: ['a'],
      timeoutMs: 5_000,
      signal: ctrl.signal,
      fetchImpl: abortableFetch(5_000),
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toBe('aborted')
  })

  it('200 with garbage JSON → malformed; 200 with wrong shape → malformed', async () => {
    const garbage = await rerankDocuments({
      query: 'q',
      documents: ['a'],
      fetchImpl: async () => new Response('not-json{', { status: 200 }),
    })
    expect(garbage).toMatchObject({ ok: false, reason: 'malformed' })
    const wrongShape = await rerankDocuments({
      query: 'q',
      documents: ['a'],
      fetchImpl: async () => jsonResponse(200, { object: 'list', data: [] }),
    })
    expect(wrongShape).toMatchObject({ ok: false, reason: 'malformed' })
  })
})

describe('applyRerankToHits — fusion order preserved for unranked tail', () => {
  it('reranked head first, untouched hits keep their original relative order', () => {
    const hits = [{ id: 'h0' }, { id: 'h1' }, { id: 'h2' }, { id: 'h3' }]
    const applied = applyRerankToHits(hits, {
      ok: true,
      model: DEFAULT_RERANK_MODEL,
      results: [
        { index: 2, score: 0.9 },
        { index: 0, score: 0.4 },
      ],
    })
    expect(applied.map((a) => a.hit.id)).toEqual(['h2', 'h0', 'h1', 'h3'])
    expect(applied[0]?.rerankScore).toBe(0.9)
    expect(applied[2]?.rerankScore).toBeUndefined()
  })

  it('out-of-range indexes are ignored, order stays deterministic across runs', () => {
    const hits = ['a', 'b']
    const run = (): string[] =>
      applyRerankToHits(hits, {
        ok: true,
        model: 'm',
        results: [
          { index: 1, score: 0.5 },
          { index: 99, score: 1 },
        ],
      }).map((a) => a.hit)
    expect(run()).toEqual(run())
    expect(run()).toEqual(['b', 'a'])
  })
})
