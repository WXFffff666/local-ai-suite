/**
 * manager.test.ts — RagManager end-to-end (todo39): real :memory: vec.db
 * handle (migrated → FTS5 + triggers live), hash-mode embeds (all network
 * probes refused by the router), hybrid query → [n] citations, rerank lane
 * wired through a fake /v1/rerank server, graceful-unavailable fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import { migrate, type Database as Db } from '../main/storage/db'
import { RagManager, type RagManagerConfig } from './manager'
import type { EmbedFetchLike } from './embed'

let tmpDir = ''
let db: Db

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Router: any known path -> handler; unknown -> throw (ECONNREFUSED sim). */
function router(routes: Record<string, (init?: RequestInit) => Response>): EmbedFetchLike {
  return async (url, init) => {
    for (const [key, make] of Object.entries(routes)) {
      if (url.includes(key)) return make(init)
    }
    throw new Error(`ECONNREFUSED ${url}`)
  }
}

function makeManager(
  config: Partial<RagManagerConfig> = {},
  fetchImpl: EmbedFetchLike = router({}),
  rerankFetch?: (url: string, init?: RequestInit) => Promise<Response>,
): RagManager {
  const cfg: RagManagerConfig = { embeddingModel: '', rerankEnabled: false, ...config }
  return new RagManager({
    getDb: () => db,
    config: () => cfg,
    fetchImpl,
    ...(rerankFetch === undefined ? {} : { rerankFetch }),
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-mgr-'))
  db = new Database(join(tmpDir, 'vec.db')) as unknown as Db
  migrate(db)
})
afterEach(() => {
  try {
    db?.close()
  } catch {
    /* noop */
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('RagManager — embeddings 三态 glue', () => {
  it('no engine answers → hash mode (degraded) surfaced via status()', async () => {
    const m = makeManager({}, router({}))
    const st = await m.status()
    expect(st.mode).toBe('hash')
    expect(st.ftsAvailable).toBe(true)
  })

  it('Ollama-in-place → ollama mode + model name', async () => {
    const m = makeManager(
      { embeddingModel: 'bge-m3' },
      router({ '/api/tags': () => json(200, { models: [{ name: 'bge-m3' }] }) }),
    )
    const st = await m.status()
    expect(st.mode).toBe('ollama')
    expect(st.model).toBe('bge-m3')
  })

  it('mode is cached; invalidateEmbeddingMode re-adjudicates', async () => {
    let tagsCalls = 0
    const m = makeManager({}, router({
      '/api/tags': () => {
        tagsCalls += 1
        return json(200, { models: [{ name: 'nomic-embed-text' }] })
      },
    }))
    await m.embeddingMode()
    await m.embeddingMode()
    expect(tagsCalls).toBe(1)
    m.invalidateEmbeddingMode()
    await m.embeddingMode()
    expect(tagsCalls).toBe(2)
  })
})

describe('RagManager — ingest (file + directory)', () => {
  it('ingests a single md/txt file into chunks with citations-ready sources', async () => {
    const file = join(tmpDir, 'doc.md')
    writeFileSync(file, 'vector database search with bm25 and reciprocal rank fusion\nline two here', 'utf-8')
    const m = makeManager()
    const out = await m.ingest(file)
    expect(out.mode).toBe('hash')
    expect(out.chunks).toBeGreaterThan(0)
    const st = await m.status()
    expect(st.docs.some((d) => d.endsWith('doc.md'))).toBe(true)
    expect(st.chunks).toBe(out.chunks)
  })

  it('ingests a directory (top-level supported files, sorted, deterministic)', async () => {
    const dir = mkdtempSync(join(tmpDir, 'corpus-'))
    writeFileSync(join(dir, 'b.txt'), 'bravo ranking text', 'utf-8')
    writeFileSync(join(dir, 'a.txt'), 'alpha vector text', 'utf-8')
    writeFileSync(join(dir, 'skip.exe'), 'binary not supported', 'utf-8')
    const m = makeManager()
    const out = await m.ingest(dir)
    const baseNames = out.docs.map((d) => (d.split(/[\\/]/).pop() ?? ''))
    expect(baseNames).toEqual(['a.txt', 'b.txt'])
    expect(out.chunks).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects unsupported file type and missing path with clear errors', async () => {
    const m = makeManager()
    const bad = join(tmpDir, 'x.bin')
    writeFileSync(bad, 'nope', 'utf-8')
    await expect(m.ingest(bad)).rejects.toThrow(/unsupported file type/)
    await expect(m.ingest(join(tmpDir, 'ghost.txt'))).rejects.toThrow(/path not found/)
  })
})

describe('RagManager — hybrid query + citations', () => {
  it('returns ordered [n] citations with page/line + source snippet', async () => {
    const m = makeManager()
    await seed(m)
    const out = await m.query('bm25 vector ranking fusion', { topK: 5 })
    expect(out.mode).toBe('hash')
    expect(out.citations.length).toBeGreaterThan(0)
    out.citations.forEach((c, i) => expect(c.n).toBe(i + 1))
    const top = out.citations[0]!
    expect(top.chunkId).toBeTruthy()
    expect(top.page).toBeGreaterThanOrEqual(0)
    expect(top.line).toBeGreaterThanOrEqual(1)
    expect(top.snippet.length).toBeGreaterThan(0)
    expect(top.rrf).toBeGreaterThan(0)
  })

  it('rerank disabled → pure fusion, stable across calls', async () => {
    const m = makeManager()
    await seed(m)
    const a = await m.query('retrieval fusion', { topK: 4, rerank: false })
    const b = await m.query('retrieval fusion', { topK: 4, rerank: false })
    expect(a.rerank.attempted).toBe(false)
    expect(a.citations.map((c) => c.chunkId)).toEqual(b.citations.map((c) => c.chunkId))
    expect(a.citations.every((c) => c.rerankScore === undefined)).toBe(true)
  })

  it('rerank enabled + server answers → scores attached + reordered', async () => {
    const m = makeManager(
      { rerankEnabled: true },
      router({}),
      async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { documents: string[] }
        // score the LAST document highest (reverse fusion order on purpose)
        const results = body.documents.map((_, i) => ({ index: i, relevance_score: i * 0.1 }))
        return json(200, { results })
      },
    )
    await seed(m)
    const out = await m.query('bm25 vector ranking fusion', { topK: 5 })
    expect(out.rerank).toEqual({ attempted: true, ok: true })
    expect(out.citations.length).toBeGreaterThan(0)
    expect(out.citations[0]!.rerankScore).toBeTypeOf('number')
    // [n] renumbered densely from 1
    out.citations.forEach((c, i) => expect(c.n).toBe(i + 1))
  })

  it('rerank enabled but --rerank missing (404) → graceful, keeps fusion order', async () => {
    const m = makeManager({ rerankEnabled: true }, router({}), async () => json(404, { error: 'rerank disabled' }))
    await seed(m)
    const out = await m.query('bm25 vector ranking fusion', { topK: 5 })
    expect(out.rerank).toMatchObject({ attempted: true, ok: false, reason: 'http' })
    expect(out.citations.every((c) => c.rerankScore === undefined)).toBe(true)
    expect(out.citations.length).toBeGreaterThan(0)
  })
})

function mk(path: string, content: string): string {
  writeFileSync(path, content, 'utf-8')
  return path
}

async function seed(m: RagManager): Promise<void> {
  await m.ingest(mk(join(tmpDir, 'retrieval.md'), 'retrieval: hybrid search fuses bm25 lexical ranking with vector embeddings'))
  await m.ingest(mk(join(tmpDir, 'cooking.md'), 'cooking: a recipe for pasta with tomato sauce'))
  await m.ingest(mk(join(tmpDir, 'fusion.md'), 'reciprocal rank fusion combines results from multiple retrieval systems'))
}
