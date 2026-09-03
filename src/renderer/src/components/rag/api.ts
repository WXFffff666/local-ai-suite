/**
 * api.ts — renderer IPC client for rag:* channels (todo39). Same structural
 * convention as conversations/api.ts: window.api may be absent (plain browser
 * / vitest) → getRagApi() returns null and pages degrade honestly.
 */
import type {
  AllowedChannel,
  RagCitation,
  RagEmbeddingModeWire,
  RagIngestReply,
  RagQueryReply,
  RagRerankState,
  RagStatusReply,
} from '../../../../main/ipc/whitelist'

export type { RagCitation, RagEmbeddingModeWire, RagRerankState }

export type InvokeFn = (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>

/** Resolve window.api.invoke when bridged; null outside the Electron shell. */
export function getRagApi(): InvokeFn | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: { invoke?: InvokeFn } }).api
  if (api && typeof api.invoke === 'function') return api.invoke.bind(api)
  return null
}

export type RagStatusView = {
  mode: RagEmbeddingModeWire
  model?: string
  docs: string[]
  chunks: number
  ftsAvailable: boolean
  rerankEnabled: boolean
}

export type RagQueryView = {
  citations: RagCitation[]
  mode: RagEmbeddingModeWire
  rerank: RagRerankState
}

function reject(env: { ok?: boolean; error?: unknown } | null | undefined, fallback: string): string {
  if (env && typeof env.error === 'string') return env.error
  return fallback
}

export async function ragStatus(invoke: InvokeFn): Promise<RagStatusView> {
  const reply = (await invoke('rag:status', {})) as RagStatusReply | null
  if (!reply || reply.ok !== true) throw new Error(reject(reply, 'rag:status failed'))
  return {
    mode: reply.mode,
    ...(reply.model === undefined ? {} : { model: reply.model }),
    docs: reply.docs,
    chunks: reply.chunks,
    ftsAvailable: reply.ftsAvailable,
    rerankEnabled: reply.rerankEnabled,
  }
}

export async function ragIngest(invoke: InvokeFn, path: string): Promise<{ docs: string[]; chunks: number; mode: RagEmbeddingModeWire }> {
  const reply = (await invoke('rag:ingest', { path })) as RagIngestReply | null
  if (!reply || reply.ok !== true) throw new Error(reject(reply, 'rag:ingest failed'))
  return { docs: reply.docs, chunks: reply.chunks, mode: reply.mode }
}

export async function ragQuery(
  invoke: InvokeFn,
  q: string,
  opts: { topK?: number; rerank?: boolean } = {},
): Promise<RagQueryView> {
  const reply = (await invoke('rag:query', { q, ...opts })) as RagQueryReply | null
  if (!reply || reply.ok !== true) throw new Error(reject(reply, 'rag:query failed'))
  return { citations: reply.citations, mode: reply.mode, rerank: reply.rerank }
}

/** Filesystem basename for source badges (renderer-side display only). */
export function sourceLabel(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/**
 * Build the grounding preamble a RAG chat turn sends to the model (wire-only;
 * display and chat.db keep the raw question). Numbered [n] blocks mirror the
 * citation chips so the model can cite the same anchors the UI shows.
 */
export function formatRagContext(citations: readonly RagCitation[]): string {
  if (citations.length === 0) return ''
  const blocks = citations
    .map((c) => `[${c.n}] ${sourceLabel(c.source)} 第${c.page + 1}页·行${c.line}\n${c.snippet}`)
    .join('\n\n')
  return `请基于以下本地知识库片段回答；引用时保留 [n] 编号标注：\n\n${blocks}`
}
