/**
 * SearchSection.tsx — todo39 设置页「检索」区（SpeechSection 数据流先例）：
 *   mount → rag:status → 嵌入引擎三态行 + rerank 开关 + FTS/库统计；
 *   开关 → config:set {rerankEnabled}（主进程 zod strict 面已扩展）。
 * hash 模式显示 plan 原文降级提示「检索质量降级（无本地嵌入引擎）」；
 * rerank 打开但 /v1/rerank 不可用时查询侧会回退融合序（rag:query 应答携带
 * rerank 状态），本区只做偏好持久化，不做引擎探测式 spawn。
 */
import { useCallback, useEffect, useState } from 'react'
import { getRagApi, ragStatus, type RagStatusView } from '../rag/api'
import type { RagEmbeddingModeWire } from '../../../../main/ipc/whitelist'

const MODE_ROWS: Record<RagEmbeddingModeWire, { label: string; note: string }> = {
  ollama: { label: 'Ollama /api/embeddings', note: '外部引擎在位，向量通道为真实嵌入' },
  internal: { label: 'llama-server --embeddings', note: '内部嵌入实例在位（facade /v1/embeddings 同源）' },
  hash: { label: '哈希占位（降级）', note: '检索质量降级（无本地嵌入引擎）— 启动 Ollama 或 --embeddings 实例后自动恢复' },
}

export function SearchSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<RagStatusView | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)

  const fetchStatus = useCallback(async (): Promise<void> => {
    const invoke = getRagApi()
    if (!invoke) return
    try {
      setStatus(await ragStatus(invoke))
      setNote(null)
    } catch (error) {
      setNote(`rag:status 失败 — ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const toggleRerank = useCallback(
    async (enabled: boolean): Promise<void> => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (!api) return
      setPersisted(enabled)
      try {
        const reply = (await api.invoke('config:set', { rerankEnabled: enabled })) as { ok?: boolean }
        if (reply?.ok === true) {
          setStatus((s) => (s ? { ...s, rerankEnabled: enabled } : s))
          setPersisted(null)
        } else {
          setNote('config:set 被拒绝 — 精排开关未保存')
          setPersisted(null)
        }
      } catch {
        setNote('config:set 失败 — 精排开关未保存')
        setPersisted(null)
      }
    },
    [],
  )

  if (status === null) {
    // window.api 缺席（纯浏览器预览）：整区隐藏（SpeechSection 同契约）。
    if (note === null || typeof window === 'undefined' || !window.api) return null
  }

  const s = status
  const rerankOn = s?.rerankEnabled ?? false
  return (
    <section className="las-settings-group" aria-label="检索">
      <h2 className="las-settings-group-title">检索（RAG v1 · FTS5 混合 + 本地重排）</h2>
      {note !== null ? <p className="las-settings-note">{note}</p> : null}
      {s ? (
        <>
          <div className="las-settings-row">
            <span className="las-settings-label">嵌入引擎（三态裁决）</span>
            <code className="las-settings-value" data-testid="search-embed-mode">
              {MODE_ROWS[s.mode].label}
              {s.model ? ` · ${s.model}` : ''}
            </code>
          </div>
          <div className="las-settings-row">
            <span className="las-settings-note" data-testid="search-embed-note">
              {MODE_ROWS[s.mode].note}
            </span>
          </div>
          <div className="las-settings-row">
            <span className="las-settings-label">本地精排（llama.cpp /v1/rerank）</span>
            <div className="las-settings-pills" role="radiogroup" aria-label="精排开关">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={rerankOn === v}
                  data-testid={`search-rerank-${v}`}
                  className={`las-settings-pill${rerankOn === v ? ' las-settings-pill-on' : ''}`}
                  disabled={persisted !== null}
                  onClick={() => void toggleRerank(v)}
                >
                  {v ? '开' : '关'}
                </button>
              ))}
            </div>
          </div>
          <div className="las-settings-row">
            <span className="las-settings-label">知识库</span>
            <code className="las-settings-value" data-testid="search-library">
              {s.docs.length} 篇 / {s.chunks} 块 · FTS5 {s.ftsAvailable ? '就绪' : '不可用'}
            </code>
          </div>
          <p className="las-settings-note">
            精排需以 --rerank 启动 bge-reranker（llama.cpp 默认关闭该端点）；不可用时查询自动回退 RRF
            融合序，不报错。嵌入模型下载后放入 models/embedding/ 并点「启动」即可被探测。
          </p>
        </>
      ) : null}
    </section>
  )
}

export default SearchSection
