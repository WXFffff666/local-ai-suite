/**
 * embed.test.ts — embeddings 三态裁决 (todo39 r2-fix ruling). Every upstream
 * is a fake fetch: the probes, the per-arm embed wire shapes, and the
 * degradation order ollama → internal → hash are all pinned here.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveEmbeddingMode,
  probeOllamaEmbedModel,
  probeInternalEmbeddings,
  embedFnForMode,
  ollamaEmbed,
  internalEmbed,
  DEGRADED_EMBEDDING_NOTICE,
  type EmbedFetchLike,
} from './embed'
import { hashEmbed } from './ingest'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** route table: exact URL substring → response factory; miss => throw (ECONNREFUSED sim) */
function router(routes: Record<string, (init?: RequestInit) => Response>): EmbedFetchLike {
  return async (url, init) => {
    for (const [key, make] of Object.entries(routes)) {
      if (url.includes(key)) return make(init)
    }
    throw new Error(`ECONNREFUSED ${url}`)
  }
}

describe('probeOllamaEmbedModel — ollama 在位裁决', () => {
  it('configured model present in tags wins', async () => {
    const model = await probeOllamaEmbedModel({
      embeddingModel: 'bge-m3:latest',
      fetchImpl: router({
        '/api/tags': () => json(200, { models: [{ name: 'llama3' }, { name: 'bge-m3:latest' }] }),
      }),
    })
    expect(model).toBe('bge-m3:latest')
  })

  it('configured-but-absent model refuses the arm (embeddings would 404)', async () => {
    const model = await probeOllamaEmbedModel({
      embeddingModel: 'ghost-embed',
      fetchImpl: router({ '/api/tags': () => json(200, { models: [{ name: 'nomic-embed-text' }] }) }),
    })
    expect(model).toBeNull()
  })

  it('auto-discovers an embed-capable tag by name heuristic', async () => {
    const model = await probeOllamaEmbedModel({
      fetchImpl: router({
        '/api/tags': () => json(200, { models: [{ name: 'llama3:latest' }, { name: 'nomic-embed-text:v1.5' }] }),
      }),
    })
    expect(model).toBe('nomic-embed-text:v1.5')
  })

  it('server down (tags probe throws) or 500 → null', async () => {
    expect(await probeOllamaEmbedModel({ fetchImpl: router({}) })).toBeNull()
    expect(
      await probeOllamaEmbedModel({ fetchImpl: router({ '/api/tags': () => json(500, {}) }) }),
    ).toBeNull()
  })
})

describe('probeInternalEmbeddings — llama-server --embeddings 在位裁决', () => {
  it('200 data[] answers true', async () => {
    const up = await probeInternalEmbeddings({
      embeddingModel: 'bge-m3',
      fetchImpl: router({ '/v1/embeddings': () => json(200, { data: [{ index: 0, embedding: [0.1, 0.2] }] }) }),
    })
    expect(up).toBe(true)
  })

  it('404 (chat instance without --embeddings) / empty data / throw → false', async () => {
    const notFound = await probeInternalEmbeddings({ fetchImpl: router({ '/v1/embeddings': () => json(404, {}) }) })
    expect(notFound).toBe(false)
    const empty = await probeInternalEmbeddings({ fetchImpl: router({ '/v1/embeddings': () => json(200, { data: [] }) }) })
    expect(empty).toBe(false)
    expect(await probeInternalEmbeddings({ fetchImpl: router({}) })).toBe(false)
  })
})

describe('resolveEmbeddingMode — 三态裁决顺序', () => {
  it('Ollama-in-place wins over internal', async () => {
    const resolution = await resolveEmbeddingMode({
      embeddingModel: 'bge-m3',
      fetchImpl: router({
        '/api/tags': () => json(200, { models: [{ name: 'bge-m3' }] }),
        '/v1/embeddings': () => json(200, { data: [{ embedding: [1] }] }),
      }),
    })
    expect(resolution).toEqual({ mode: 'ollama', model: 'bge-m3' })
  })

  it('no Ollama but --embeddings llama-server answers → internal', async () => {
    const resolution = await resolveEmbeddingMode({
      embeddingModel: 'bge-m3-gguf',
      fetchImpl: router({ '/v1/embeddings': () => json(200, { data: [{ embedding: [0.5] }] }) }),
    })
    expect(resolution).toEqual({ mode: 'internal', model: 'bge-m3-gguf' })
  })

  it('neither upstream → hash placeholder (UI degraded notice constant exists)', async () => {
    const resolution = await resolveEmbeddingMode({ fetchImpl: router({}) })
    expect(resolution).toEqual({ mode: 'hash' })
    expect(DEGRADED_EMBEDDING_NOTICE).toContain('检索质量降级')
  })

  it('internal default model name when none configured', async () => {
    const resolution = await resolveEmbeddingMode({
      fetchImpl: router({ '/v1/embeddings': () => json(200, { data: [[0]] }) as never }),
    })
    // data[] must be objects with embedding; malformed here => falls to hash
    expect(resolution.mode).toBe('hash')
    const resolution2 = await resolveEmbeddingMode({
      fetchImpl: router({ '/v1/embeddings': () => json(200, { data: [{ embedding: [0.1] }] }) }),
    })
    expect(resolution2).toEqual({ mode: 'internal', model: 'internal-embeddings' })
  })
})

describe('embed wire shapes', () => {
  it('ollamaEmbed loops prompts sequentially, preserving order', async () => {
    const seen: string[] = []
    const out = await ollamaEmbed(['one', 'two'], 'bge-m3', {
      fetchImpl: async (_u, init) => {
        const body = JSON.parse(String(init?.body)) as { prompt: string; model: string }
        seen.push(body.prompt)
        expect(body.model).toBe('bge-m3')
        return json(200, { embedding: [seen.length, 0] })
      },
    })
    expect(seen).toEqual(['one', 'two'])
    expect(out).toEqual([[1, 0], [2, 0]])
  })

  it('ollamaEmbed rejects on non-numeric / missing embedding', async () => {
    await expect(
      ollamaEmbed(['x'], 'm', { fetchImpl: async () => json(200, { embedding: 'nope' }) }),
    ).rejects.toThrow(/no embedding/)
  })

  it('internalEmbed batches input[] and maps data[] 1:1', async () => {
    let sent: { input?: string[] } | null = null
    const out = await internalEmbed(['a', 'b'], 'bge', {
      fetchImpl: async (_u, init) => {
        sent = JSON.parse(String(init?.body)) as { input?: string[] }
        return json(200, { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] })
      },
    })
    expect(sent).toEqual({ model: 'bge', input: ['a', 'b'] })
    expect(out).toEqual([[1, 2], [3, 4]])
  })

  it('internalEmbed length mismatch throws (never silently misstores)', async () => {
    await expect(
      internalEmbed(['a', 'b'], 'm', { fetchImpl: async () => json(200, { data: [{ embedding: [1] }] }) }),
    ).rejects.toThrow(/mismatched/)
  })
})

describe('embedFnForMode', () => {
  it('hash mode is local, deterministic and dim-pinned', async () => {
    const fn = embedFnForMode({ mode: 'hash' }, { hashDim: 32 })
    const [v1, v2] = await fn(['hello world', 'hello world'])
    expect(v1).toHaveLength(32)
    expect(v1).toEqual(v2)
    expect(v1).toEqual(hashEmbed(['hello world'], 32)[0])
  })

  it('ollama/internal modes delegate through the injected fetch seam', async () => {
    const ollama = embedFnForMode({ mode: 'ollama', model: 'bge-m3' }, {
      fetchImpl: router({ '/api/embeddings': () => json(200, { embedding: [9] }) }),
    })
    expect(await ollama(['x'])).toEqual([[9]])
    const internal = embedFnForMode({ mode: 'internal', model: 'bge' }, {
      fetchImpl: router({ '/v1/embeddings': () => json(200, { data: [{ embedding: [7, 7] }] }) }),
    })
    expect(await internal(['x'])).toEqual([[7, 7]])
  })

  it('ollama resolution missing model is a hard programming error', () => {
    expect(() => embedFnForMode({ mode: 'ollama' })).toThrow(/missing model/)
  })
})
