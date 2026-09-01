/**
 * MarketCardItem.tsx — 单条搜索结果卡：name/author/quant/sizeLabel/likes + HF 链接 + Download
 */
import type { MarketModelCard } from './types'

export type MarketCardItemProps = {
  card: MarketModelCard
  /** 该 repo 已有进行中任务 → 禁用重复下载 */
  active: boolean
  onDownload: (card: MarketModelCard) => void
}

export function MarketCardItem({ card, active, onDownload }: MarketCardItemProps): React.JSX.Element {
  return (
    <article className="las-market-card" data-repo-id={card.repoId}>
      <header className="las-market-card-head">
        <h3 className="las-market-card-name" title={card.repoId}>
          {card.name}
        </h3>
        <span className="las-market-card-quant">{card.quant || '—'}</span>
      </header>
      <p className="las-market-card-meta">
        <span>{card.author}</span>
        <span aria-hidden="true">·</span>
        <span>{card.sizeLabel || '体积未知'}</span>
        {card.likes !== undefined ? (
          <>
            <span aria-hidden="true">·</span>
            <span>♥ {card.likes}</span>
          </>
        ) : null}
        {card.gguf ? null : <span className="las-market-card-nonGGUF">非 GGUF</span>}
      </p>
      {card.description ? <p className="las-market-card-desc">{card.description}</p> : null}
      <footer className="las-market-card-actions">
        <a
          className="las-market-card-link"
          href={`https://huggingface.co/${card.repoId}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          HF 页面 ↗
        </a>
        <button
          type="button"
          className="las-market-card-download"
          disabled={active}
          title={
            active
              ? '该模型已有进行中的下载任务'
              : card.filename
                ? `下载 ${card.filename}`
                : '下载整个仓库（按量化挑选）'
          }
          onClick={() => onDownload(card)}
        >
          {active ? '下载中…' : '下载'}
        </button>
      </footer>
    </article>
  )
}
