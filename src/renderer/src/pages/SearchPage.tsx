/**
 * SearchPage.tsx — todo39 实装：本地重排 + FTS5 混合检索 (RAG v1).
 *
 * 消费 rag:status / rag:ingest / rag:query 三通道：查询框 → 混合检索
 * (BM25×向量 top20 → RRF 融合) → [n] 引用卡片（source 徽章 + FTS5 页/行 +
 * 精排分数徽章，点击弹原文定位 dialog）；hash 降级态显示「检索质量降级
 * （无本地嵌入引擎）」横幅（三态裁决，r2-fix）。入库支持单文件或顶层目录
 * （路径由主进程围栏校验）。「网页搜索」按钮走既有 search:run 编排器
 * （web lane 保持原样，不与本地库混排）。
 */
import { useCallback, useEffect, useState } from 'react'
import { CitationChips } from '../components/rag/CitationChips'
import { getRagApi, ragIngest, ragQuery, ragStatus, type RagQueryView, type RagStatusView, type InvokeFn } from '../components/rag/api'
import type { RagEmbeddingModeWire } from '../../../main/ipc/whitelist'
import '../components/rag/rag.css'

const MODE_LABELS: Record<RagEmbeddingModeWire, string> = {
  ollama: '嵌入引擎：Ollama /api/embeddings',
  internal: '嵌入引擎：内部 llama-server --embeddings',
  hash: '嵌入引擎：哈希占位（降级）',
}

type WebCard = { id: number; title: string; url: string; snippet: string }
/** search:run reply (web lane) — the orchestrator card subset the UI reads. */
type WebSearchReply = { ok?: boolean; result?: { cards?: WebCard[] }; error?: string }

export function SearchPage(): React.JSX.Element {
  const [api, setApi] = useState<InvokeFn | null>(null)
  const [status, setStatus] = useState<RagStatusView | null>(null)
  const [query, setQuery] = useState('')
  const [rerank, setRerank] = useState(false)
  const [result, setResult] = useState<RagQueryView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ingestPath, setIngestPath] = useState('')
  const [ingestNote, setIngestNote] = useState<string | null>(null)
  const [webCards, setWebCards] = useState<WebCard[] | null>(null)

  useEffect(() => {
    const invoke = getRagApi()
    // setState(fn) would treat the bound invoke AS an updater — wrap it.
    setApi(() => invoke)
    if (!invoke) return
    let cancelled = false
    void ragStatus(invoke)
      .then((st) => {
        if (cancelled) return
        setStatus(st)
        setRerank(st.rerankEnabled)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (!api) return
    try {
      setStatus(await ragStatus(api))
    } catch {
      /* keep the stale view */
    }
  }, [api])

  const runIngest = useCallback(async (): Promise<void> => {
    if (!api) return
    const path = ingestPath.trim()
    if (!path) return
    setBusy(true)
    setError(null)
    setIngestNote(null)
    try {
      const out = await ragIngest(api, path)
      setIngestNote(`已入库 ${out.docs.length} 篇 · ${out.chunks} 块`)
      await refreshStatus()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [api, ingestPath, refreshStatus])

  const runQuery = useCallback(async (): Promise<void> => {
    if (!api) return
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setError(null)
    setWebCards(null)
    try {
      setResult(await ragQuery(api, q, rerank ? { rerank: true } : {}))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }, [api, query, rerank])

  const runWebSearch = useCallback(async (): Promise<void> => {
    if (!api) return
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const reply = (await api('search:run', { query: q })) as WebSearchReply
      if (!reply || reply.ok !== true || !reply.result) {
        throw new Error(reply?.error ?? 'search:run failed')
      }
      setWebCards(reply.result.cards ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setWebCards(null)
    } finally {
      setBusy(false)
    }
  }, [api, query])

  const degraded = status?.mode === 'hash'
  return (
    <section className="las-page" aria-labelledby="page-title-search">
      <h1 id="page-title-search" className="las-page-title">
        Search
      </h1>
      <p className="las-page-subtitle">本地 FTS5 × 向量混合检索（RRF 融合 · 可选 llama.cpp 精排）</p>

      {!api ? (
        <div className="las-rag-banner las-rag-banner--warn" role="status">
          未检测到 window.api — 混合检索仅在桌面端可用，当前为只读预览。
        </div>
      ) : null}
      {api && status && degraded ? (
        <div className="las-rag-banner las-rag-banner--warn" role="status" data-testid="rag-degraded-banner">
          检索质量降级（无本地嵌入引擎）：向量通道使用哈希占位。启动 Ollama（或带 --embeddings
          的 llama-server 嵌入实例）后自动恢复。
        </div>
      ) : null}
      {api && status && !status.ftsAvailable ? (
        <div className="las-rag-banner las-rag-banner--warn" role="status" data-testid="rag-fts-banner">
          FTS5 索引不可用 — 仅向量通道生效（旧库会在下次启动自动重建索引）。
        </div>
      ) : null}
      {error ? (
        <div className="las-rag-banner las-rag-banner--error" role="alert" data-testid="rag-error">
          {error}
        </div>
      ) : null}

      <div className="las-rag-toolbar">
        <input
          className="las-rag-input"
          placeholder={api ? '向本地知识库提问…（Enter 检索）' : '检索需要桌面端运行时'}
          value={query}
          data-testid="rag-query-input"
          disabled={!api || busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runQuery()
          }}
        />
        <button type="button" onClick={() => void runQuery()} disabled={!api || busy || !query.trim()} data-testid="rag-query-button">
          本地检索
        </button>
        <button type="button" onClick={() => void runWebSearch()} disabled={!api || busy || !query.trim()} data-testid="rag-web-button">
          网页搜索
        </button>
        <label className="las-rag-hint" data-testid="rag-rerank-label">
          <input type="checkbox" checked={rerank} disabled={!api} onChange={(e) => setRerank(e.target.checked)} data-testid="rag-rerank-toggle" />{' '}
          精排（--rerank）
        </label>
      </div>

      {api ? (
        <div className="las-rag-toolbar">
          <input
            className="las-rag-input"
            placeholder="入库路径：.md/.txt/.pdf 文件或顶层目录（绝对路径）"
            value={ingestPath}
            data-testid="rag-ingest-input"
            disabled={busy}
            onChange={(e) => setIngestPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runIngest()
            }}
          />
          <button type="button" onClick={() => void runIngest()} disabled={busy || !ingestPath.trim()} data-testid="rag-ingest-button">
            入库
          </button>
          {ingestNote ? <span className="las-rag-hint" data-testid="rag-ingest-note">{ingestNote}</span> : null}
        </div>
      ) : null}

      {status ? (
        <p className="las-rag-hint" data-testid="rag-status-line">
          {MODE_LABELS[status.mode]} · 库内 {status.docs.length} 篇 / {status.chunks} 块
        </p>
      ) : null}

      {result ? (
        <div data-testid="rag-results">
          {result.rerank.attempted && !result.rerank.ok ? (
            <div className="las-rag-banner las-rag-banner--warn" role="status" data-testid="rag-rerank-unavailable">
              精排不可用（{result.rerank.reason ?? 'unknown'}）— 已回退纯 RRF 融合排序。确认已用 --rerank 加载 bge-reranker 后重试。
            </div>
          ) : null}
          {result.citations.length === 0 ? (
            <p className="las-rag-hint" data-testid="rag-no-results">
              无命中 — 先入库文档再检索。
            </p>
          ) : (
            <CitationChips citations={result.citations} variant="cards" />
          )}
        </div>
      ) : null}

      {webCards ? (
        <div data-testid="web-results">
          {webCards.length === 0 ? <p className="las-rag-hint">网页搜索无结果。</p> : null}
          {webCards.map((c) => (
            <div key={c.id} className="las-page-card" style={{ marginBottom: 8 }}>
              <strong>
                [{c.id}] {c.title}
              </strong>
              <div className="las-rag-hint">{c.url}</div>
              <div>{c.snippet}</div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

export default SearchPage
