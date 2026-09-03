import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  chunkText,
  chunkDocument,
  isSupportedFile,
  hashEmbed,
  cosine,
  SUPPORTED_EXTS,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_EMBED_DIM,
  RagStore,
  asQueryEngine,
  ingestFiles,
  ingestText,
} from './ingest'

function memStore(overrides: ConstructorParameters<typeof RagStore>[0] = {}) {
  const db = new Database(':memory:') as unknown as import('better-sqlite3').Database
  return new RagStore({ db: db as never, ...overrides })
}

describe('chunk — 切块', () => {
  it('短文本不切', () => {
    expect(chunkText('hello world')).toEqual(['hello world'])
    expect(chunkText('  hello  ')).toEqual(['hello'])
  })

  it('空/空白返回空', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('长文本按 chunkSize 切块且 overlap 生效', () => {
    const text = 'a'.repeat(100)
    const cs = chunkText(text, { chunkSize: 30, overlap: 5 })
    // 30, then 25 step each
    expect(cs.length).toBeGreaterThan(1)
    expect(cs[0]!.length).toBe(30)
    // overlap: end of chunk0 last 5 chars == start of chunk1 first 5
    expect(cs[0]!.slice(-5)).toBe(cs[1]!.slice(0, 5))
  })

  it('overlap 边界 clamp 不死循环', () => {
    const text = 'x'.repeat(50)
    const cs = chunkText(text, { chunkSize: 10, overlap: 20 }) // clamp to 9
    expect(cs.length).toBeGreaterThan(1)
    expect(cs.every((c) => c.length > 0)).toBe(true)
  })

  it('chunkDocument 生成 Chunk 对象', () => {
    const cs = chunkDocument('hello world foo bar', 'note.md', { chunkSize: 5, overlap: 1 })
    expect(cs[0]!.source).toBe('note.md')
    expect(cs[0]!.id).toBe('note.md#0')
    expect(cs[0]!.index).toBe(0)
    expect(cs[1]!.id).toBe('note.md#1')
    expect(cs.every((c) => c.content.length > 0)).toBe(true)
  })
})

describe('isSupportedFile — pdf/md/txt', () => {
  it('支持 pdf/md/txt/markdown', () => {
    expect(isSupportedFile('a.pdf')).toBe(true)
    expect(isSupportedFile('a.PDF')).toBe(true)
    expect(isSupportedFile('doc.md')).toBe(true)
    expect(isSupportedFile('note.txt')).toBe(true)
    expect(isSupportedFile('note.markdown')).toBe(true)
  })
  it('不支持 exe 等', () => {
    expect(isSupportedFile('a.exe')).toBe(false)
    expect(isSupportedFile('a.png')).toBe(false)
    expect(isSupportedFile('noext')).toBe(false)
  })
})

describe('hashEmbed — deterministic 且归一化', () => {
  it('相同文本相同向量、不同文本不同', () => {
    const [v1] = hashEmbed(['hello world'], 8)
    const [v2] = hashEmbed(['hello world'], 8)
    const [v3] = hashEmbed(['goodbye'], 8)
    expect(v1).toEqual(v2)
    expect(v1).not.toEqual(v3)
    // 归一化
    const norm = Math.sqrt(v1!.reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
  })
  it('cosine 自相似 1', () => {
    const [v] = hashEmbed(['local ai suite'], 16)
    expect(cosine(v!, v!)).toBeCloseTo(1, 5)
  })
})

describe('RagStore — sqlite-vec(可选) 入库与召回', () => {
  let store: RagStore
  beforeEach(() => {
    store = memStore()
  })

  it('ingestText → count 增长、可检索', async () => {
    const chunks = await store.ingestText('本地 AI 套件 支持 离线 模型 推理 与 RAG 召回', 'doc.md')
    expect(chunks.length).toBeGreaterThan(0)
    expect(store.count()).toBe(chunks.length)
    expect(store.listSources()).toContain('doc.md')

    const res = await store.query('RAG 召回')
    expect(res.chunks.length).toBeGreaterThan(0)
    expect(res.answer).toContain('RAG')
  })

  it('ingestFiles — 拖入 pdf/md/txt 多文件', async () => {
    const files = [
      { path: 'a.md', content: '# Title\n本地模型 一键安装 离线工作流' },
      { path: 'b.txt', content: 'stable diffusion 生图 prompt to image' },
      { path: 'c.pdf', content: 'pdf 内容：向量数据库 sqlite-vec 存储' },
    ]
    const all = await store.ingestFiles(files)
    expect(all.length).toBeGreaterThan(0)
    expect(store.count()).toBe(all.length)

    // 查询生图相关应召回 b.txt
    const r = await store.retrieve('prompt to image')
    expect(r.length).toBeGreaterThan(0)
    expect(r[0]!.source).toBe('b.txt')

    // 查向量数据库应命中 c.pdf
    const r2 = await store.retrieve('sqlite-vec 向量')
    expect(r2[0]!.source).toBe('c.pdf')
  })

  it('不支持的文件类型抛错', async () => {
    await expect(store.ingestFile({ path: 'bad.exe', content: 'x' })).rejects.toThrow(/unsupported/)
  })

  it('空查询返回空', async () => {
    await store.ingestText('some content', 'a.txt')
    expect(await store.retrieve('   ')).toEqual([])
    // 空库查询
    const empty = memStore()
    expect(await empty.retrieve('hello')).toEqual([])
  })

  it('clear 清空', async () => {
    await store.ingestText('hello world', 'a.txt')
    expect(store.count()).toBeGreaterThan(0)
    store.clear()
    expect(store.count()).toBe(0)
  })

  it('chunk 切块后召回——长文档跨块可召回', async () => {
    // 造一个长文档确保切多块
    const long = Array.from({ length: 20 }, (_, i) => `段落${i}：本地 AI 套件 内容块 ${i} 关键词${i % 3 === 0 ? ' 特殊锚点 ALPHA' : ''}`).join('\n')
    await store.ingestText(long, 'long.md', { chunkSize: 80, chunkOverlap: 10 })
    expect(store.count()).toBeGreaterThan(1)
    const res = await store.retrieve('特殊锚点 ALPHA')
    expect(res.length).toBeGreaterThan(0)
    expect(res.some((c) => c.content.includes('ALPHA'))).toBe(true)
  })
})

describe('as_query_engine(streaming=true) — 流式召回', () => {
  it('asQueryEngine 与 store.asQueryEngine 等价，且 streaming 流式输出', async () => {
    const s = memStore()
    await s.ingestText('本地 AI 套件 模型文件夹 models 热加载', 'm1.md')
    await s.ingestText('搜索 编排 rerank 引用 来源卡片', 'm2.md')

    const engine = s.asQueryEngine({ streaming: true, topK: 2 })
    const engine2 = asQueryEngine(s, { streaming: true, topK: 2 })
    expect(engine.query).toBeDefined()
    expect(engine2.query).toBeDefined()

    const res = await engine.query('模型热加载')
    expect(res.chunks.length).toBeGreaterThan(0)
    expect(res.sources[0]!.source).toBe('m1.md')

    // streaming
    let collected = ''
    let done = false
    let sources: unknown = null
    for await (const evt of engine.queryStream('模型热加载')) {
      collected += evt.delta
      if (evt.done) {
        done = true
        sources = evt.sources
      }
    }
    expect(done).toBe(true)
    expect(collected).toContain('热加载')
    expect(sources).toBeDefined()
    expect(Array.isArray(sources)).toBe(true)
  })

  it('streaming 无结果时 done 仍返回', async () => {
    const s = memStore()
    const eng = s.asQueryEngine({ streaming: true })
    const deltas: string[] = []
    let done = false
    for await (const e of eng.queryStream('no such content xyz')) {
      deltas.push(e.delta)
      if (e.done) done = true
    }
    expect(done).toBe(true)
  })

  it('retrieve 透传 topK', async () => {
    const s = memStore()
    await s.ingestText('a a a', 'a.txt')
    await s.ingestText('b b b', 'b.txt')
    await s.ingestText('c c c', 'c.txt')
    const eng = s.asQueryEngine({ streaming: true, topK: 1 })
    const cs = await eng.retrieve('a')
    expect(cs.length).toBe(1)
  })
})

describe('ingest helpers — 拖入封装', () => {
  it('ingestFiles / ingestText 无 store 时自动建内存库', async () => {
    const { store, chunks } = await ingestFiles([{ path: 'x.md', content: 'hello rag world' }])
    expect(chunks.length).toBeGreaterThan(0)
    expect(store.count()).toBe(chunks.length)
    const r = await store.retrieve('rag')
    expect(r.length).toBeGreaterThan(0)

    const { store: s2, chunks: c2 } = await ingestText('another doc', 'y.txt')
    expect(c2.length).toBeGreaterThan(0)
    expect(s2.count()).toBe(1)
  })

  it('ingestFiles 注入已有 store 累加', async () => {
    const s = memStore()
    await ingestFiles([{ path: 'a.md', content: 'doc a' }], s)
    const { chunks } = await ingestFiles([{ path: 'b.md', content: 'doc b' }], s)
    expect(chunks.length).toBeGreaterThan(0)
    expect(s.count()).toBe(2)
  })
})

describe('常量与边界', () => {
  it('常量符合预期', () => {
    expect(SUPPORTED_EXTS).toEqual(expect.arrayContaining(['.pdf', '.md', '.txt']))
    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(0)
    expect(DEFAULT_CHUNK_OVERLAP).toBeGreaterThanOrEqual(0)
    expect(DEFAULT_EMBED_DIM).toBe(64)
  })
})

// ---------------------------------------------------------------------------
// todo39 — BM25 lane + hybrid fusion (检索质量回归)
// ---------------------------------------------------------------------------

describe('RagStore — BM25 通道 (todo39)', () => {
  let store: RagStore
  beforeEach(async () => {
    store = memStore()
    await store.ingestText('SQLite vector search with sqlite-vec extension for embeddings', 'db.md')
    await store.ingestText('Ranking functions: bm25 and reciprocal rank fusion for search ranking', 'rank.md')
    await store.ingestText('Hybrid search combines bm25 lexical ranking with vector embeddings for retrieval', 'mix.md')
    await store.ingestText('完全无关的烹饪食谱内容与本查询无关', 'cook.md')
  })

  it('isFtsAvailable — 注入库同样自动建 fts 索引', () => {
    expect(store.isFtsAvailable()).toBe(true)
  })

  it('bm25Search 命中含词文档并按相关度降序；topK 生效', () => {
    const hits = store.bm25Search('bm25 ranking fusion', 10)
    expect(hits.length).toBeGreaterThan(0)
    const ids = hits.map((h) => h.id)
    expect(ids).toContain('rank.md#0')
    // scores are flipped so higher = better, strictly descending
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
    expect(store.bm25Search('bm25 ranking fusion', 2).length).toBeLessThanOrEqual(2)
  })

  it('bm25Search 空查询/无命中 → 空数组；引号注入被安全转义', () => {
    expect(store.bm25Search('   ')).toEqual([])
    expect(store.bm25Search('zzzqqq nonexistent', 5)).toEqual([])
    expect(() => store.bm25Search('rm -rf " \" OR match", 1')).not.toThrow()
  })

  it('buildFtsMatch — ASCII 精确词、CJK 前缀、引号转义', () => {
    expect(RagStore.buildFtsMatch('hello world')).toBe('"hello" OR "world"')
    expect(RagStore.buildFtsMatch('本地部署')).toBe('"本地部署"*')
    expect(RagStore.buildFtsMatch('say "hi"')).toBe('"say" OR "hi"')
    expect(RagStore.buildFtsMatch('')).toBe('')
  })

  it('CJK 整段前缀匹配可用（unicode61 单 token 语义）', async () => {
    const s = memStore()
    await s.ingestText('本地部署指南适用于飞牛 NAS', 'deploy.txt')
    expect(s.bm25Search('本地部署', 5).map((h) => h.id)).toEqual(['deploy.txt#0'])
  })

  it('hybridRetrieve — 融合召回覆盖优于任一单路（固定语料确定性断言）', async () => {
    const fused = await store.hybridRetrieve('hybrid bm25 vector ranking fusion', { topK: 3, laneDepth: 20 })
    const fusedIds = new Set(fused.map((f) => f.chunk.id))
    const bm25Ids = new Set(store.bm25Search('hybrid bm25 vector ranking fusion', 20).map((h) => h.id))
    const vecIds = new Set((await store.retrieve('hybrid bm25 vector ranking fusion', { topK: 20 })).map((c) => c.id))
    const relevant = new Set(['mix.md#0', 'rank.md#0', 'db.md#0'])
    const hitsOf = (s: Set<string>): number => [...relevant].filter((r) => s.has(r)).length
    // 融合 top-3 的相关命中数 >= 单路 top-3 命中数（两路互补时严格大于亦可）
    const fusedTop3 = new Set(fused.slice(0, 3).map((f) => f.chunk.id))
    expect(hitsOf(fusedTop3)).toBeGreaterThanOrEqual(Math.max(hitsOf(top3(bm25Ids)), hitsOf(top3(vecIds))))
    void fusedIds
    // 双路共同命中的文档必须排在单路文档之前
    const dual = fused.filter((f) => f.ranks['bm25'] !== undefined && f.ranks['vector'] !== undefined)
    const single = fused.filter((f) => !(f.ranks['bm25'] !== undefined && f.ranks['vector'] !== undefined))
    if (dual.length > 0 && single.length > 0) {
      const bestDualIdx = fused.findIndex((f) => f.chunk.id === dual[0]!.chunk.id)
      const bestSingleIdx = fused.findIndex((f) => f.chunk.id === single[0]!.chunk.id)
      expect(bestDualIdx).toBeLessThan(bestSingleIdx)
    }
  })

  it('hybridRetrieve — 确定性（reranker 关闭时纯融合路径稳定）', async () => {
    const a = await store.hybridRetrieve('vector ranking', { topK: 4 })
    const b = await store.hybridRetrieve('vector ranking', { topK: 4 })
    expect(a.map((x) => [x.chunk.id, x.rrf])).toEqual(b.map((x) => [x.chunk.id, x.rrf]))
  })

  it('hybridRetrieve — 空查询空结果；未入库时为空', async () => {
    expect(await store.hybridRetrieve('')).toEqual([])
    const empty = memStore()
    expect(await empty.hybridRetrieve('anything')).toEqual([])
  })
})

function top3<T>(s: Set<T>): Set<T> {
  return new Set([...s].slice(0, 3))
}
