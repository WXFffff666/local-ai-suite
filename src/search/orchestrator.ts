/**
 * Search Orchestrator — search → rerank → cite 链路 (Wave4 T18)
 *
 * MIT only. No AGPL code is imported or bundled here.
 * - search: 任意 ISearchAdapter (SearXNG / Tavily / Exa / Brave) 的统一 search()
 * - rerank: 本地轻量相关度重排 (title/snippet term overlap + 覆盖度)，零网络、可注入自定义 reranker
 * - cite: 去重归一 + 来源卡片 { title, url, snippet } 规范化
 * - answer 末尾附来源卡片: Markdown 卡片列表 + appendSourcesToAnswer() 一键拼接
 *
 * 使用:
 *   const orch = new SearchOrchestrator(adapter, { rerankTopK: 5 })
 *   const { ranked, cards, markdown } = await orch.search("Qwen3 本地部署")
 *   const final = orch.appendToAnswer(llmAnswer, cards)
 */

import type { ISearchAdapter, SearchResultItem } from '../core/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 归一后的来源卡片 — 回答末尾展示所需全部字段 */
export type SourceCard = {
  /** 1-based 序号，用于 [1] [2] 引用 */
  id: number
  title: string
  url: string
  snippet: string
}

/** rerank 后的条目，附加 score / rank */
export type RankedItem = SearchResultItem & {
  score: number
  rank: number
}

/** 可注入的自定义 reranker 签名 */
export type RerankerFn = (query: string, items: SearchResultItem[]) => RankedItem[] | Promise<RankedItem[]>

export type OrchestratorOptions = {
  /** 搜索请求条数 (透传给 adapter.search) 默认 10 */
  count?: number
  /** rerank 后保留 TopK (来源卡片数量) 默认 5 */
  rerankTopK?: number
  /** snippet 最大长度，超出截断 (默认 200) 0=不限长 */
  snippetMaxLen?: number
  /** 自定义 reranker，传入则覆盖内置本地 rerank */
  reranker?: RerankerFn
  /** 去重策略 默认 'url' */
  dedupBy?: 'url'
}

export type OrchestratorResult = {
  /** 原始搜索结果 (去重前) */
  raw: SearchResultItem[]
  /** 去重后数量 */
  deduped: SearchResultItem[]
  /** rerank 后 TopK */
  ranked: RankedItem[]
  /** 归一来源卡片 (id/title/url/snippet) */
  cards: SourceCard[]
  /** Markdown 来源卡片块 (可直接拼在回答末尾) */
  markdown: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_COUNT = 10
export const DEFAULT_RERANK_TOP_K = 5
export const DEFAULT_SNIPPET_MAX_LEN = 200

// ---------------------------------------------------------------------------
// Helpers — tokenize / normalize
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return (s ?? '').trim()
}

function truncateSnippet(s: string, maxLen: number): string {
  const t = normalizeText(s)
  if (maxLen <= 0 || t.length <= maxLen) return t
  return t.slice(0, maxLen).trimEnd() + '…'
}

/** 归一单条 SearchResultItem 的 title/url/snippet (去空白、补默认值) */
export function normalizeItem(item: SearchResultItem, snippetMaxLen = DEFAULT_SNIPPET_MAX_LEN): SearchResultItem {
  const url = normalizeText(item.url)
  const title = normalizeText(item.title) || url || 'Untitled'
  const snippet = truncateSnippet(normalizeText(item.snippet), snippetMaxLen)
  return { title, url, snippet }
}

/** 按 url 去重 (保留首条)，空 url 条目被丢弃 */
export function deduplicateByUrl(items: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>()
  const out: SearchResultItem[] = []
  for (const it of items) {
    const key = normalizeText(it.url).toLowerCase()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
  }
  return out
}

// ---------------------------------------------------------------------------
// cite 归一 — SearchResultItem[] -> SourceCard[]
// ---------------------------------------------------------------------------

/**
 * 将 (已 rerank 的) 条目归一为来源卡片
 * - 自动 normalize title/url/snippet
 * - snippet 按 snippetMaxLen 截断
 * - id 为 1-based 序号
 */
export function toSourceCards(
  items: SearchResultItem[],
  opts: { snippetMaxLen?: number; startId?: number } = {},
): SourceCard[] {
  const maxLen = opts.snippetMaxLen ?? DEFAULT_SNIPPET_MAX_LEN
  const start = opts.startId ?? 1
  return items.map((it, idx) => {
    const n = normalizeItem(it, maxLen)
    return {
      id: start + idx,
      title: n.title,
      url: n.url,
      snippet: n.snippet,
    }
  })
}

/** 兼容别名 — cite 归一入口 */
export const normalizeCitations = toSourceCards

// ---------------------------------------------------------------------------
// rerank — 本地轻量相关度
// ---------------------------------------------------------------------------

function tokenize(query: string): string[] {
  const q = query.toLowerCase().trim()
  if (!q) return []
  // 按空白 / 标点切分，保留中文连续字符，过滤单字符噪音(英文单字母除外保留? 这里过滤长度<2的英文)
  const raw = q.split(/[\s,.!?;:"'()[\]{}|/\\\-_，。！？；：""''（）【】《》、]+/).filter(Boolean)
  // 进一步对中文做字符级展开以提升召回
  const out: string[] = []
  for (const tok of raw) {
    if (/^[\u4e00-\u9fa5]+$/.test(tok) && tok.length > 2) {
      // 中文长词同时保留整词 + 单字(用于覆盖度)
      out.push(tok)
      // 单字不单独加入，避免噪音；整词已足够做 substring 匹配
    } else {
      out.push(tok)
    }
  }
  return [...new Set(out)].filter((t) => t.length > 0)
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count++
    pos = idx + needle.length
  }
  return count
}

/**
 * 单条相关度打分 (确定性、无网络)
 * - title 命中权重 2.5x
 * - snippet 命中权重 1.0x
 * - 覆盖的 query term 数量额外加分
 * - 完全匹配 query 原串额外加分
 */
export function scoreItem(query: string, item: SearchResultItem): number {
  const q = query.toLowerCase().trim()
  if (!q) return 0
  const terms = tokenize(q)
  if (terms.length === 0) return 0
  const title = (item.title ?? '').toLowerCase()
  const snippet = (item.snippet ?? '').toLowerCase()
  let score = 0
  let matchedTerms = 0
  for (const term of terms) {
    const inTitle = countOccurrences(title, term)
    const inSnippet = countOccurrences(snippet, term)
    if (inTitle > 0 || inSnippet > 0) matchedTerms++
    score += inTitle * 2.5 + inSnippet * 1.0
  }
  // 覆盖度奖励: 命中 term 比例
  score += (matchedTerms / terms.length) * 1.5
  // 完整 query 子串奖励
  if (title.includes(q)) score += 2
  if (snippet.includes(q)) score += 1
  return score
}

/**
 * 本地 rerank — 按 score 降序，稳定排序 (score 相同保持原序)
 * 返回 RankedItem[] (含 score/rank)
 */
export function rerankResults(
  query: string,
  items: SearchResultItem[],
  opts: { topK?: number } = {},
): RankedItem[] {
  const q = query?.trim() ?? ''
  if (!q || items.length === 0) {
    return items.map((it, idx) => ({ ...it, score: 0, rank: idx + 1 }))
  }
  const scored: RankedItem[] = items.map((it, idx) => ({
    ...it,
    score: scoreItem(q, it),
    // 临时 rank，用原序作 tie-breaker
    rank: idx,
  }))
  // 稳定降序：score 高优先，相等则原序
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.rank - b.rank
  })
  const sliced = typeof opts.topK === 'number' && opts.topK >= 0 ? scored.slice(0, opts.topK) : scored
  return sliced.map((it, idx) => ({ ...it, rank: idx + 1 }))
}

// ---------------------------------------------------------------------------
// Markdown 来源卡片
// ---------------------------------------------------------------------------

/**
 * 渲染来源卡片 Markdown 块
 * 格式:
 *   ---
 *   **来源**
 *   [1] [Title](url) — snippet
 *   ...
 */
export function formatSourcesMarkdown(cards: SourceCard[]): string {
  if (cards.length === 0) return ''
  const lines: string[] = ['---', '**来源**']
  for (const c of cards) {
    const safeTitle = c.title.replace(/[\[\]]/g, '')
    const snippetPart = c.snippet ? ` — ${c.snippet}` : ''
    lines.push(`[${c.id}] [${safeTitle}](${c.url})${snippetPart}`)
  }
  return lines.join('\n')
}

/**
 * 将来源卡片 Markdown 拼接到回答末尾
 * - 空卡片则原样返回
 * - 自动处理末尾换行，避免多余空行堆积
 */
export function appendSourcesToAnswer(answer: string, cards: SourceCard[]): string {
  const block = formatSourcesMarkdown(cards)
  if (!block) return answer
  const trimmed = answer.trimEnd()
  return `${trimmed}\n\n${block}`
}

// ---------------------------------------------------------------------------
// Orchestrator — search → rerank → cite
// ---------------------------------------------------------------------------

export class SearchOrchestrator {
  private readonly adapter: Pick<ISearchAdapter, 'search'>
  private readonly opts: Required<Omit<OrchestratorOptions, 'reranker'>> & { reranker?: RerankerFn }

  constructor(adapter: Pick<ISearchAdapter, 'search'>, opts: OrchestratorOptions = {}) {
    if (!adapter || typeof adapter.search !== 'function') {
      throw new Error('SearchOrchestrator requires an adapter with search()')
    }
    this.adapter = adapter
    this.opts = {
      count: opts.count ?? DEFAULT_COUNT,
      rerankTopK: opts.rerankTopK ?? DEFAULT_RERANK_TOP_K,
      snippetMaxLen: opts.snippetMaxLen ?? DEFAULT_SNIPPET_MAX_LEN,
      dedupBy: opts.dedupBy ?? 'url',
      reranker: opts.reranker,
    }
  }

  /** 完整链路: search → dedup → rerank → cite → markdown */
  async search(
    query: string,
    override?: OrchestratorOptions & { count?: number },
  ): Promise<OrchestratorResult> {
    const q = query?.trim() ?? ''
    if (!q) {
      return { raw: [], deduped: [], ranked: [], cards: [], markdown: '' }
    }
    const count = override?.count ?? this.opts.count
    const topK = override?.rerankTopK ?? this.opts.rerankTopK
    const snippetMaxLen = override?.snippetMaxLen ?? this.opts.snippetMaxLen
    const reranker = override?.reranker ?? this.opts.reranker

    const raw = (await this.adapter.search!(q, { count })) ?? []

    // dedup
    const dedupedRaw = deduplicateByUrl(raw).map((it) => normalizeItem(it, snippetMaxLen))

    // rerank
    let ranked: RankedItem[]
    if (reranker) {
      const custom = await reranker(q, dedupedRaw)
      ranked = (custom ?? []).slice(0, topK).map((it, idx) => ({ ...it, rank: idx + 1 }))
    } else {
      ranked = rerankResults(q, dedupedRaw, { topK })
    }

    // cite — ranked 已是归一过的条目，直接转卡片 (snippet 已截断，无需二次截断)
    const cards = toSourceCards(ranked, { snippetMaxLen: 0 })
    // snippetMaxLen 0 表示 toSourceCards 内不再截断 (ranked 已截断)

    const markdown = formatSourcesMarkdown(cards)
    return { raw, deduped: dedupedRaw, ranked, cards, markdown }
  }

  /** 便捷: 将本次检索的来源拼到回答末尾 */
  async searchAndAppend(
    query: string,
    answer: string,
    override?: OrchestratorOptions,
  ): Promise<{ result: OrchestratorResult; appended: string }> {
    const result = await this.search(query, override)
    return { result, appended: this.appendToAnswer(answer, result.cards) }
  }

  /** 纯函数代理 — 便于外部单独使用 */
  rerank(query: string, items: SearchResultItem[], topK?: number): RankedItem[] {
    return rerankResults(query, items, { topK: topK ?? this.opts.rerankTopK })
  }

  cite(items: SearchResultItem[]): SourceCard[] {
    return toSourceCards(items, { snippetMaxLen: this.opts.snippetMaxLen })
  }

  format(cards: SourceCard[]): string {
    return formatSourcesMarkdown(cards)
  }

  appendToAnswer(answer: string, cards: SourceCard[]): string {
    return appendSourcesToAnswer(answer, cards)
  }
}

// ---------------------------------------------------------------------------
// Functional façade — 无需 new 的快捷入口
// ---------------------------------------------------------------------------

export type OrchestrateSearchOptions = OrchestratorOptions & {
  adapter: Pick<ISearchAdapter, 'search'>
}

/**
 * 函数式编排入口 (等价于 new SearchOrchestrator(adapter, opts).search(query))
 */
export async function orchestrateSearch(
  query: string,
  opts: OrchestrateSearchOptions,
): Promise<OrchestratorResult> {
  const { adapter, ...rest } = opts
  const orch = new SearchOrchestrator(adapter, rest)
  return orch.search(query)
}

/** 函数式 append 代理 */
export function createOrchestrator(
  adapter: Pick<ISearchAdapter, 'search'>,
  opts?: OrchestratorOptions,
): SearchOrchestrator {
  return new SearchOrchestrator(adapter, opts)
}

export default SearchOrchestrator
