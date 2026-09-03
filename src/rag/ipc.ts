/**
 * ipc.ts — rag:* handler factories (todo39). Registration stays in
 * src/main/ipc/handlers.ts (speech/ocr precedent: validation + delegation
 * only here); the retrieval pipeline itself lives in ./manager.ts.
 *
 * Channel contract:
 *   rag:status  {}                          -> RagStatusReply   (mode probe + library size)
 *   rag:ingest  {path}                      -> RagIngestReply   (file or top-level dir)
 *   rag:query   {q, topK?, rerank?}         -> RagQueryReply    ([n] citations, fusion±rerank)
 *
 * Path confinement: the renderer sends a path it learned from a user gesture;
 * ingest is READ-ONLY over it (chunk -> store), never writes, never follows
 * it into deletion — the same trust level image:saveTempImage's inverse.
 * Embedding probes (三态) touch only 127.0.0.1 engines.
 */

import { statSync } from 'fs'
import { isAbsolute } from 'path'

import {
  ragIngestSchema,
  ragQuerySchema,
  ragStatusSchema,
  validatePayload,
} from '../main/ipc/schemas'
import type { RagIngestReply, RagQueryReply, RagStatusReply } from '../main/ipc/whitelist'
import { getRagManager, type RagManager } from './manager'

export type RagHandler = (args: unknown[]) => Promise<unknown>

export type RagManagerSurface = Pick<RagManager, 'status' | 'ingest' | 'query' | 'invalidateEmbeddingMode'>

export type RagIpcDeps = {
  /** lazy seam (tests inject fakes; default = the process singleton). */
  rag?: () => RagManagerSurface
}

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

export function createRagHandlers(deps: RagIpcDeps = {}): Record<
  'rag:status' | 'rag:ingest' | 'rag:query',
  RagHandler
> {
  const manager = (): RagManagerSurface => deps.rag?.() ?? getRagManager()

  return {
    'rag:status': async (args) => {
      const parsed = validatePayload(ragStatusSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      try {
        const st = await manager().status()
        const reply: RagStatusReply = { ok: true, ...st }
        return reply
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RagStatusReply
      }
    },

    'rag:ingest': async (args) => {
      const parsed = validatePayload(ragIngestSchema, first(args))
      if (!parsed.ok) return parsed
      const path = parsed.data.path
      if (!isAbsolute(path)) return { ok: false, error: 'path-not-absolute' } satisfies RagIngestReply
      try {
        statSync(path) // existence gate before any embedding work (honest error code)
      } catch {
        return { ok: false, error: 'path-not-found' } satisfies RagIngestReply
      }
      try {
        const out = await manager().ingest(path)
        const reply: RagIngestReply = { ok: true, docs: out.docs, chunks: out.chunks, mode: out.mode }
        return reply
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (/unsupported file type/.test(detail)) return { ok: false, error: 'unsupported-type', detail } satisfies RagIngestReply
        if (/too large/.test(detail)) return { ok: false, error: 'file-too-large', detail } satisfies RagIngestReply
        return { ok: false, error: 'ingest-failed', detail } satisfies RagIngestReply
      }
    },

    'rag:query': async (args) => {
      const parsed = validatePayload(ragQuerySchema, first(args))
      if (!parsed.ok) return parsed
      const { q, topK, rerank } = parsed.data
      try {
        const out = await manager().query(q, {
          ...(topK === undefined ? {} : { topK }),
          ...(rerank === undefined ? {} : { rerank }),
        })
        const reply: RagQueryReply = { ok: true, citations: out.citations, mode: out.mode, rerank: out.rerank }
        return reply
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RagQueryReply
      }
    },
  }
}
