/**
 * manager.ts — RagManager: the RAG v1 service object (todo39). Owns the
 * RagStore handle (backed by the migrated vec.db — FTS5 + sqlite-vec live in
 * parallel namespaces there, Appendix C LLM08), the embeddings 三态裁决 cache,
 * and the hybrid query → citation → optional-rerank pipeline the IPC layer
 * consumes.
 *
 * Lazy contract (speech/ocr precedent): construction opens NOTHING — the db
 * handle, the embedding-mode probes and the rerank client all start work on
 * the first verb call. No side effects at import time.
 *
 * MIT only, no AGPL.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { getVecDb } from '../main/storage/db'
import { getConfig } from '../main/storage/config'

import { RagStore, isSupportedFile, LANE_DEPTH_DEFAULT, type HybridHit } from './ingest'
import { resolveEmbeddingMode, embedFnForMode, type EmbedClientOptions, type EmbeddingMode, type EmbeddingResolution, type EmbedFetchLike } from './embed'
import { buildCitations, applyRerankToCitations, type Citation } from './citations'
import { rerankDocuments, applyRerankToHits, DEFAULT_RERANK_MODEL, type RerankUnavailableReason } from '../search/rerank'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RagManagerConfig = {
  /** served embedding model ('' = auto-detect / hash fallback) */
  embeddingModel: string
  rerankEnabled: boolean
  /** served reranker model name (bge-reranker gguf default lives in rerank.ts) */
  rerankModel?: string
}

export type RagManagerDeps = {
  /** shared vec.db handle provider (main: storage/db.getVecDb; tests: :memory:) */
  getDb: () => BetterSqlite3Database | null
  config: () => RagManagerConfig
  ports?: { ollama?: () => number; llama?: () => number }
  fetchImpl?: EmbedFetchLike
  /** rerank probe/upload seam (tests fake the /v1/rerank wire) */
  rerankFetch?: (url: string, init?: RequestInit) => Promise<Response>
}

export type RagIngestOutcome = {
  docs: string[]
  chunks: number
  mode: EmbeddingMode
}

export type RagQueryOutcome = {
  citations: Citation[]
  mode: EmbeddingMode
  rerank: { attempted: boolean; ok: boolean; reason?: RerankUnavailableReason }
}

export type RagStatus = {
  mode: EmbeddingMode
  model?: string
  docs: string[]
  chunks: number
  ftsAvailable: boolean
  rerankEnabled: boolean
}

// Per-file read guard — a 2 GB "document" must not OOM the main process.
const MAX_INGEST_BYTES = 32 * 1024 * 1024

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class RagManager {
  private storeInstance: RagStore | null = null
  private modePromise: Promise<EmbeddingResolution> | null = null
  /** the rerank lane only after an explicit enable; graceful otherwise */
  constructor(private readonly deps: RagManagerDeps) {}

  // --- embedding 三态 --------------------------------------------------------

  /** Cached three-state adjudication (ollama > internal > hash). */
  embeddingMode(): Promise<EmbeddingResolution> {
    this.modePromise ??= resolveEmbeddingMode(this.embedOptions())
    return this.modePromise
  }

  /** Force re-adjudication (settings changed the model, engine came up…). */
  invalidateEmbeddingMode(): void {
    this.modePromise = null
  }

  private embedOptions(): EmbedClientOptions {
    const cfg = this.deps.config()
    return {
      embeddingModel: cfg.embeddingModel,
      ...(this.deps.ports?.ollama === undefined ? {} : { ollamaPort: this.deps.ports.ollama() }),
      ...(this.deps.ports?.llama === undefined ? {} : { llamaPort: this.deps.ports.llama() }),
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    }
  }

  // --- store ----------------------------------------------------------------

  /** Lazy RagStore on the shared vec.db; hash embedFn until mode confirms. */
  private store(): RagStore | null {
    if (this.storeInstance !== null) return this.storeInstance
    const db = this.deps.getDb()
    if (db === null) return null
    const manager = this
    this.storeInstance = new RagStore({
      db,
      embedFn: async (texts: string[], dim?: number): Promise<number[][]> => {
        const resolution = await manager.embeddingMode()
        const fn = embedFnForMode(resolution, manager.embedOptions())
        return fn(texts, dim)
      },
    })
    return this.storeInstance
  }

  // --- verbs (ipc surface) ----------------------------------------------------

  async status(): Promise<RagStatus> {
    const store = this.store()
    const resolution = await this.embeddingMode()
    const cfg = this.deps.config()
    return {
      mode: resolution.mode,
      ...(resolution.model === undefined ? {} : { model: resolution.model }),
      docs: store?.listSources() ?? [],
      chunks: store?.count() ?? 0,
      ftsAvailable: store?.isFtsAvailable() ?? false,
      rerankEnabled: cfg.rerankEnabled,
    }
  }

  /** Ingest one file or every supported top-level file of a directory. */
  async ingest(path: string): Promise<RagIngestOutcome> {
    const store = this.store()
    if (store === null) throw new Error('rag storage unavailable (vec.db could not open)')
    const resolution = await this.embeddingMode()
    if (!existsSync(path)) throw new Error(`path not found: ${path}`)
    const stat = statSync(path)
    const docs: string[] = []
    let chunks = 0
    if (stat.isDirectory()) {
      // deterministic order; top-level only (recursive crawl is backlog, not v1)
      const entries = readdirSync(path).sort()
      for (const name of entries) {
        const full = join(path, name)
        let s: ReturnType<typeof statSync>
        try {
          s = statSync(full)
        } catch {
          continue
        }
        if (!s.isFile() || !isSupportedFile(full) || s.size > MAX_INGEST_BYTES) continue
        const cs = await store.ingestFile({ path: full, content: readFileSync(full, 'utf-8') })
        if (cs.length > 0) docs.push(full)
        chunks += cs.length
      }
    } else {
      if (!isSupportedFile(path)) {
        throw new Error(`unsupported file type: ${path} (allowed: .pdf .md .txt .markdown)`)
      }
      if (stat.size > MAX_INGEST_BYTES) throw new Error(`file too large (>32MiB): ${path}`)
      const cs = await store.ingestFile({ path })
      if (cs.length > 0) docs.push(path)
      chunks = cs.length
    }
    return { docs, chunks, mode: resolution.mode }
  }

  /** Hybrid query: BM25×vec lanes → RRF topN → [n] citations → optional rerank. */
  async query(
    q: string,
    opts: { topK?: number; rerank?: boolean } = {},
  ): Promise<RagQueryOutcome> {
    const store = this.store()
    if (store === null) throw new Error('rag storage unavailable (vec.db could not open)')
    const topK = opts.topK ?? 5
    const resolution = await this.embeddingMode()
    // fuse a wider head when rerank may follow so the精排 has candidates
    const wantRerank = opts.rerank ?? this.deps.config().rerankEnabled
    const fuseN = wantRerank ? Math.max(topK, 10) : topK
    const hits: HybridHit[] = await store.hybridRetrieve(q, { topK: fuseN, laneDepth: LANE_DEPTH_DEFAULT })
    let citations = buildCitations(hits, q)
    let rerank: RagQueryOutcome['rerank'] = { attempted: false, ok: false }
    if (wantRerank && citations.length > 0) {
      const outcome = await rerankDocuments({
        query: q,
        documents: hits.map((h) => h.chunk.content),
        model: this.deps.config().rerankModel ?? DEFAULT_RERANK_MODEL,
        topN: topK,
        ...(this.deps.ports?.llama === undefined ? {} : { port: this.deps.ports.llama() }),
        ...(this.deps.rerankFetch === undefined ? {} : { fetchImpl: this.deps.rerankFetch }),
      })
      if (outcome.ok) {
        const ordered = applyRerankToHits(citations, outcome)
        const scoreByChunk = new Map(
          ordered.flatMap((o) => (o.rerankScore === undefined ? [] : [[o.hit.chunkId, o.rerankScore] as const])),
        )
        citations = applyRerankToCitations(
          ordered.map((o) => o.hit),
          scoreByChunk,
        ).slice(0, topK)
        rerank = { attempted: true, ok: true }
      } else {
        rerank = { attempted: true, ok: false, reason: outcome.reason }
        citations = citations.slice(0, topK)
      }
    } else {
      citations = citations.slice(0, topK)
    }
    return {
      citations,
      mode: resolution.mode,
      rerank,
    }
  }

  /** Test/shutdown seam: drop the store handle (never closes the shared db). */
  resetStore(): void {
    this.storeInstance = null
  }
}

let instance: RagManager | null = null

export function getRagManager(deps?: RagManagerDeps): RagManager {
  instance ??= new RagManager(deps ?? defaultRagDeps())
  return instance
}

export function resetRagManager(): void {
  instance = null
}

/** Production wiring: shared vec.db + AppConfig (lazy getters, no import-time IO). */
function defaultRagDeps(): RagManagerDeps {
  return {
    getDb: () => getVecDb() as unknown as BetterSqlite3Database | null,
    config: () => {
      const c = getConfig() as unknown as Record<string, unknown>
      return {
        embeddingModel: typeof c['embeddingModel'] === 'string' ? c['embeddingModel'] : '',
        rerankEnabled: c['rerankEnabled'] === true,
        ...(typeof c['rerankModel'] === 'string' && c['rerankModel'] !== '' ? { rerankModel: c['rerankModel'] } : {}),
      }
    },
  }
}
