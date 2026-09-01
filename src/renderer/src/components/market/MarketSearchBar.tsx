/**
 * MarketSearchBar.tsx — 搜索框 + 量化筛选 + GGUF-only 开关 → 'hf:search' 参数
 */
import { useState } from 'react'
import { MARKET_QUANTS } from './types'

export type MarketSearchParams = {
  query: string
  /** '' = 不过滤（提交时省略该键，避免与 hfSearchSchema/后端筛选语义打架） */
  quant: string
  ggufOnly: boolean
}

export const DEFAULT_SEARCH_PARAMS: MarketSearchParams = {
  query: '',
  quant: '',
  ggufOnly: true,
}

export type MarketSearchBarProps = {
  busy: boolean
  onSearch: (params: MarketSearchParams) => void
}

export function MarketSearchBar({ busy, onSearch }: MarketSearchBarProps): React.JSX.Element {
  const [query, setQuery] = useState(DEFAULT_SEARCH_PARAMS.query)
  const [quant, setQuant] = useState(DEFAULT_SEARCH_PARAMS.quant)
  const [ggufOnly, setGgufOnly] = useState(DEFAULT_SEARCH_PARAMS.ggufOnly)

  return (
    <form
      className="las-market-search"
      role="search"
      aria-label="HuggingFace 模型搜索"
      onSubmit={(e) => {
        e.preventDefault()
        onSearch({ query: query.trim(), quant, ggufOnly })
      }}
    >
      <input
        className="las-market-search-input"
        type="search"
        placeholder="搜索模型，如 qwen3 gguf…"
        aria-label="搜索关键词"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select
        className="las-market-search-select"
        aria-label="量化筛选"
        value={quant}
        onChange={(e) => setQuant(e.target.value)}
      >
        <option value="">全部量化</option>
        {MARKET_QUANTS.map((q) => (
          <option key={q} value={q}>
            {q}
          </option>
        ))}
      </select>
      <label className="las-market-search-toggle">
        <input
          type="checkbox"
          checked={ggufOnly}
          onChange={(e) => setGgufOnly(e.target.checked)}
        />
        仅 GGUF
      </label>
      <button className="las-market-search-submit" type="submit" disabled={busy}>
        {busy ? '搜索中…' : '搜索'}
      </button>
    </form>
  )
}
