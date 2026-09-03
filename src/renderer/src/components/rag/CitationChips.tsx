/**
 * CitationChips.tsx — todo39 引用卡片: [n] 角标 + 点击定位原文 dialog.
 * Shared by SearchPage (variant 'cards', one full card per hit) and chat
 * MessageBubble (variant 'compact', a chip strip under the answer). Clicking
 * opens a native <dialog> with the source, the FTS5 page/line anchor, the
 * lane/score provenance and the located snippet —「引用卡片带 [n] 角标点击定位
 * 原文片段」 with zero new deps (mirrors the MessageBubble image lightbox).
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import type { RagCitation } from '../../../../main/ipc/whitelist'
import './rag.css'

export type CitationChipsProps = {
  citations: readonly RagCitation[]
  /** compact = chat-bubble chip strip; cards = full SearchPage result cards */
  variant?: 'compact' | 'cards'
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function laneLabel(c: RagCitation): string {
  const bm25 = c.ranks['bm25'] !== undefined
  const vec = c.ranks['vector'] !== undefined
  if (bm25 && vec) return 'FTS5 + 向量'
  if (bm25) return 'FTS5/BM25'
  if (vec) return '向量'
  return 'RRF'
}

function scoreLine(c: RagCitation): string {
  const parts: string[] = [`RRF ${c.rrf.toFixed(4)}`]
  if (c.bm25Score !== undefined) parts.push(`bm25 ${c.bm25Score.toFixed(2)}`)
  if (c.rerankScore !== undefined) parts.push(`精排 ${c.rerankScore.toFixed(3)}`)
  return parts.join(' · ')
}

export function CitationChips({ citations, variant = 'compact' }: CitationChipsProps): React.JSX.Element | null {
  const [open, setOpen] = useState<RagCitation | null>(null)
  if (citations.length === 0) return null
  return (
    <div className={`las-cites las-cites--${variant}`} data-testid="citation-chips">
      {citations.map((c) => (
        <button
          key={c.chunkId}
          type="button"
          className={`las-cite-item${variant === 'cards' ? ' las-cite-card-btn' : ''}`}
          data-testid={`cite-chip-${c.n}`}
          title={`${c.source} · 第 ${c.page + 1} 页 / 行 ${c.line}`}
          onClick={() => setOpen(c)}
        >
          <span className="las-cite-n">[{c.n}]</span>
          <span className="las-cite-src">{basename(c.source)}</span>
          {variant === 'cards' ? (
            <span className="las-cite-card-body">
              <span className="las-cite-lane">{laneLabel(c)}</span>
              <span className="las-cite-page">第 {c.page + 1} 页 · 行 {c.line}</span>
              <span className="las-cite-snippet-inline">{c.snippet}</span>
              <span className="las-cite-score">{scoreLine(c)}</span>
            </span>
          ) : null}
          {c.rerankScore !== undefined ? (
            <span className="las-cite-badge" data-testid={`cite-rerank-${c.n}`}>
              精排 {Math.round(c.rerankScore * 100) / 100}
            </span>
          ) : null}
        </button>
      ))}
      {open !== null && (
        <dialog
          open
          className="las-cite-dialog"
          data-testid="citation-dialog"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(null)
          }}
        >
          <div className="las-cite-detail">
            <div className="las-cite-detail-head">
              <span className="las-cite-n las-cite-n--big">[{open.n}]</span>
              <div className="las-cite-meta">
                <strong>{open.source}</strong>
                <span>
                  第 {open.page + 1} 页 · 行 {open.line} · {laneLabel(open)}
                </span>
                <span>{scoreLine(open)}</span>
              </div>
              <button type="button" aria-label="close-citation" className="las-cite-close" onClick={() => setOpen(null)}>
                <X size={16} aria-hidden />
              </button>
            </div>
            <pre className="las-cite-snippet" data-testid="citation-snippet">{open.snippet}</pre>
          </div>
        </dialog>
      )}
    </div>
  )
}

export default CitationChips
