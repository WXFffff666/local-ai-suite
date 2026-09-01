/**
 * MarketPage.tsx — todo14：HF 市场页接入 hf:search / models:download
 *
 * 数据流（仅消费既有白名单通道，见 src/main/ipc/whitelist.ts）：
 *   搜索栏 → invoke('hf:search',{query?,quant?,ggufOnly}) → {ok,cards} → 结果卡
 *   卡片「下载」→ invoke('models:download',{repoId,filename?}) → ack{id}
 *   订阅 'download:progress' {id,repoId,received,total,state,error?} → 任务面板进度条
 *
 * 诚实状态：
 * - gated 仓库需要 HF token（todo16 设置页加密存储），未配置时下载会以后端报错呈现；
 * - 磁盘余量预检与取消（download:cancel）后端通道尚不存在 → 界面 disabled + 说明，
 *   偏差已记录交 orchestrator（不得改 whitelist.ts/handlers.ts，IPC lane 冻结）。
 */
import { useCallback, useEffect, useState } from 'react'
import '../components/market/market.css'
import {
  DEFAULT_SEARCH_PARAMS,
  MarketSearchBar,
  type MarketSearchParams,
} from '../components/market/MarketSearchBar'
import { MarketCardItem } from '../components/market/MarketCardItem'
import { DownloadJobList } from '../components/market/DownloadJobList'
import { useDownloadJobs } from '../components/market/useDownloadJobs'
import {
  formatIssues,
  type HfSearchReply,
  type MarketModelCard,
} from '../components/market/types'

type SearchView = {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  cards: MarketModelCard[]
  message?: string
}

const INITIAL_VIEW: SearchView = { phase: 'idle', cards: [] }

/** MarketSearchParams → hfSearchSchema 载荷（空串筛选项省略键，遵守后端默认语义）。 */
export function buildSearchPayload(p: MarketSearchParams): Record<string, unknown> {
  return {
    ...(p.query === '' ? {} : { query: p.query }),
    ...(p.quant === '' ? {} : { quant: p.quant }),
    ggufOnly: p.ggufOnly,
  }
}

export function MarketPage(): React.JSX.Element {
  const [view, setView] = useState<SearchView>(INITIAL_VIEW)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const { jobs, isActive, start } = useDownloadJobs()

  const runSearch = useCallback(async (p: MarketSearchParams) => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) {
      setView({
        phase: 'error',
        cards: [],
        message: '未检测到 window.api — 市场搜索仅在 Electron 主窗口内可用',
      })
      return
    }
    setView({ phase: 'loading', cards: [] })
    try {
      const reply = (await api.invoke('hf:search', buildSearchPayload(p))) as HfSearchReply
      if (!reply.ok) {
        setView({ phase: 'error', cards: [], message: `hf:search 被拒绝 — ${formatIssues(reply)}` })
        return
      }
      setView({ phase: 'ready', cards: reply.cards })
    } catch (err) {
      setView({
        phase: 'error',
        cards: [],
        message: `hf:search 调用失败 — ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }, [])

  // 首屏以默认筛选拉一次列表（离线时后端 searchHF 自带 featured 兜底）
  useEffect(() => {
    void runSearch(DEFAULT_SEARCH_PARAMS)
  }, [runSearch])

  const onDownload = useCallback(
    async (card: MarketModelCard) => {
      setDownloadError(null)
      const message = await start(card)
      if (message) setDownloadError(message)
    },
    [start],
  )

  return (
    <section className="las-page" aria-labelledby="page-title-market">
      <h1 id="page-title-market" className="las-page-title">
        Market
      </h1>
      <p className="las-page-subtitle">
        HuggingFace 模型市场 — 搜索并断点续传下载到本地 models/
      </p>

      <MarketSearchBar busy={view.phase === 'loading'} onSearch={(p) => void runSearch(p)} />

      <p className="las-market-note">
        受限（gated）仓库需要先在设置中配置 HuggingFace token，否则下载将以错误呈现。
        磁盘余量预检与任务取消依赖后端通道（download:cancel / 预检），尚未接入 —
        下载前请自行确认目标磁盘空间充足。
      </p>

      {view.phase === 'error' && view.message ? (
        <p className="las-market-error" role="alert">
          {view.message}
        </p>
      ) : null}
      {downloadError ? (
        <p className="las-market-error" role="alert">
          {downloadError}
        </p>
      ) : null}

      <div className="las-market-layout">
        <div>
          {view.phase === 'loading' ? <p className="las-market-status">正在搜索…</p> : null}
          {view.phase !== 'loading' && view.cards.length === 0 ? (
            <p className="las-market-status">没有符合条件的模型 — 换个关键词或放宽量化筛选。</p>
          ) : null}
          {view.phase !== 'loading' && view.cards.length > 0 ? (
            <div className="las-market-results">
              {view.cards.map((card) => (
                <MarketCardItem
                  key={`${card.repoId}::${card.quant}`}
                  card={card}
                  active={isActive(card.repoId)}
                  onDownload={(c) => void onDownload(c)}
                />
              ))}
            </div>
          ) : null}
        </div>
        <DownloadJobList jobs={jobs} />
      </div>
    </section>
  )
}

export default MarketPage
