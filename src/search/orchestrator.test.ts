import { describe, it, expect, vi } from 'vitest'
import type { SearchResultItem } from '../core/types'
import {
  deduplicateByUrl,
  normalizeItem,
  toSourceCards,
  normalizeCitations,
  scoreItem,
  rerankResults,
  formatSourcesMarkdown,
  appendSourcesToAnswer,
  SearchOrchestrator,
  orchestrateSearch,
  createOrchestrator,
  DEFAULT_COUNT,
  DEFAULT_RERANK_TOP_K,
  DEFAULT_SNIPPET_MAX_LEN,
} from './orchestrator'

function item(title: string, url: string, snippet: string): SearchResultItem {
  return { title, url, snippet }
}

describe('orchestrator — normalize / dedup / cite 归一', () => {
  it('normalizeItem — 去空白、缺 title 回落 url、snippet 截断', () => {
    expect(normalizeItem({ title: '  hi  ', url: ' https://a.com ', snippet: ' s ' })).toEqual({
      title: 'hi',
      url: 'https://a.com',
      snippet: 's',
    })
    // title 为空回落 url
    expect(normalizeItem({ title: '  ', url: 'https://a.com', snippet: '' }).title).toBe('https://a.com')
    // snippet 截断
    const long = 'x'.repeat(300)
    expect(normalizeItem({ title: 't', url: 'https://a.com', snippet: long }, 200).snippet.length).toBe(201) // 200 + …
    expect(normalizeItem({ title: 't', url: 'https://a.com', snippet: long }, 0).snippet.length).toBe(300)
  })

  it('deduplicateByUrl — 按 url 去重、大小写不敏感、丢弃空 url', () => {
    const items: SearchResultItem[] = [
      item('a', 'https://example.com/1', 's1'),
      item('b', 'https://example.com/1', 's2'),
      item('c', 'https://EXAMPLE.COM/1', 's3'),
      item('d', 'https://example.com/2', 's4'),
      item('e', '', 's5'),
    ]
    const out = deduplicateByUrl(items)
    expect(out).toHaveLength(2)
    expect(out[0].title).toBe('a')
    expect(out[1].title).toBe('d')
  })

  it('toSourceCards / normalizeCitations — id 1-based、title/url/snippet 归一', () => {
    const cards = toSourceCards(
      [item('  Title A  ', 'https://a.com', '  snippet a  '), item('', 'https://b.com', 'b snippet')],
      { snippetMaxLen: 200 },
    )
    expect(cards).toEqual([
      { id: 1, title: 'Title A', url: 'https://a.com', snippet: 'snippet a' },
      { id: 2, title: 'https://b.com', url: 'https://b.com', snippet: 'b snippet' },
    ])
    // 别名
    expect(normalizeCitations).toBe(toSourceCards)
    // startId
    expect(toSourceCards([item('t', 'https://a.com', 's')], { startId: 5 })[0].id).toBe(5)
  })
})

describe('orchestrator — rerank', () => {
  it('scoreItem — 命中越多分数越高，title 权重高于 snippet', () => {
    const q = 'Qwen3 本地部署'
    const a = item('Qwen3 本地部署教程', 'https://a.com', '无关内容')
    const b = item('无关标题', 'https://b.com', 'Qwen3 本地部署 详细步骤')
    const c = item('完全无关', 'https://c.com', 'nothing')
    expect(scoreItem(q, a)).toBeGreaterThan(scoreItem(q, b))
    expect(scoreItem(q, b)).toBeGreaterThan(scoreItem(q, c))
    expect(scoreItem('', a)).toBe(0)
  })

  it('rerankResults — 按 score 降序、稳定排序、topK 截断、rank 1-based', () => {
    const q = 'hello world'
    const items = [
      item('no match', 'https://a.com', 'nothing'),
      item('hello world guide', 'https://b.com', 'hello world snippet'),
      item('hello only', 'https://c.com', 'hello'),
    ]
    const ranked = rerankResults(q, items)
    expect(ranked[0].url).toBe('https://b.com')
    expect(ranked[0].rank).toBe(1)
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)

    const top1 = rerankResults(q, items, { topK: 1 })
    expect(top1).toHaveLength(1)
    expect(top1[0].url).toBe('https://b.com')

    // 空 query 保持原序 score 0
    const empty = rerankResults('', items)
    expect(empty.every((r) => r.score === 0)).toBe(true)
    expect(empty[0].url).toBe('https://a.com')

    // 空数组
    expect(rerankResults(q, [])).toEqual([])
  })

  it('rerankResults — 中文 query 正常打分', () => {
    const q = '本地模型 安装'
    const items = [
      item('本地模型安装指南', 'https://a.com', '本地模型 一键安装'),
      item('other', 'https://b.com', 'other'),
    ]
    const ranked = rerankResults(q, items)
    expect(ranked[0].url).toBe('https://a.com')
  })
})

describe('orchestrator — 来源卡片 Markdown', () => {
  it('formatSourcesMarkdown — 空卡片返回空串', () => {
    expect(formatSourcesMarkdown([])).toBe('')
  })

  it('formatSourcesMarkdown — 渲染 [id] [title](url) — snippet', () => {
    const md = formatSourcesMarkdown([
      { id: 1, title: 'Title A', url: 'https://a.com', snippet: 'snippet a' },
      { id: 2, title: 'Title B', url: 'https://b.com', snippet: '' },
    ])
    expect(md).toContain('---')
    expect(md).toContain('**来源**')
    expect(md).toContain('[1] [Title A](https://a.com) — snippet a')
    expect(md).toContain('[2] [Title B](https://b.com)')
    // 无多余的 — 当 snippet 为空
    expect(md.split('\n').find((l) => l.startsWith('[2]'))).not.toContain(' — ')
  })

  it('appendSourcesToAnswer — 拼接到回答末尾、空卡片原样返回', () => {
    const ans = '这是回答。'
    expect(appendSourcesToAnswer(ans, [])).toBe(ans)
    const appended = appendSourcesToAnswer(ans, [{ id: 1, title: 'T', url: 'https://a.com', snippet: 's' }])
    expect(appended.startsWith('这是回答。')).toBe(true)
    expect(appended).toContain('---')
    expect(appended).toContain('[1] [T](https://a.com)')
    // 去除末尾多余换行后仍正确拼接
    expect(appendSourcesToAnswer('ans\n\n\n', [{ id: 1, title: 'T', url: 'https://a.com', snippet: '' }])).toBe(
      'ans\n\n---\n**来源**\n[1] [T](https://a.com)',
    )
  })
})

describe('SearchOrchestrator — search→rerank→cite 链路', () => {
  const mockItems: SearchResultItem[] = [
    item('Qwen3 本地部署 教程', 'https://a.com/qwen3', 'Qwen3 本地部署 详细步骤 一键安装'),
    item('无关内容', 'https://b.com/other', 'nothing relevant here'),
    item('Qwen3 本地部署', 'https://c.com/qwen3-deploy', '本地模型 安装 Qwen3'),
    item('重复链接', 'https://a.com/qwen3', 'duplicate url should be deduped'),
    item('hello world', 'https://d.com/hello', 'Qwen3 相关 hello'),
  ]

  function makeAdapter(items: SearchResultItem[] = mockItems) {
    return {
      search: vi.fn(async (_q: string, opts?: { count?: number }) => {
        if (typeof opts?.count === 'number') return items.slice(0, opts.count)
        return items
      }),
    }
  }

  it('构造函数校验 — 无 search 抛错', () => {
    expect(() => new SearchOrchestrator(null as never)).toThrow(/search/)
    expect(() => new SearchOrchestrator({} as never)).toThrow(/search/)
  })

  it('常量默认值', () => {
    expect(DEFAULT_COUNT).toBe(10)
    expect(DEFAULT_RERANK_TOP_K).toBe(5)
    expect(DEFAULT_SNIPPET_MAX_LEN).toBe(200)
  })

  it('空 query 返回空结果不调 adapter', async () => {
    const adapter = makeAdapter()
    const orch = new SearchOrchestrator(adapter)
    const res = await orch.search('  ')
    expect(res.raw).toEqual([])
    expect(res.cards).toEqual([])
    expect(res.markdown).toBe('')
    expect(adapter.search).not.toHaveBeenCalled()
  })

  it('完整链路: 去重 → rerank TopK → 来源卡片 → markdown', async () => {
    const adapter = makeAdapter()
    const orch = new SearchOrchestrator(adapter, { rerankTopK: 2 })
    const res = await orch.search('Qwen3 本地部署')

    // raw 含重复
    expect(res.raw).toHaveLength(5)
    // deduped 去重后 4 (a.com/qwen3 重复)
    expect(res.deduped).toHaveLength(4)
    // ranked TopK=2 且按相关度排序
    expect(res.ranked).toHaveLength(2)
    // 最相关的应是含 Qwen3 本地部署 的条目
    expect(res.ranked[0].title).toContain('Qwen3')
    // 卡片 id 1-based
    expect(res.cards[0].id).toBe(1)
    expect(res.cards[1].id).toBe(2)
    // 卡片含 title/url/snippet
    for (const c of res.cards) {
      expect(c.title).toBeTruthy()
      expect(c.url).toMatch(/^https:\/\//)
    }
    // markdown 非空且包含来源标题
    expect(res.markdown).toContain('**来源**')
    expect(res.markdown).toContain('[1]')
  })

  it('snippetMaxLen 截断', async () => {
    const longSnippet = 'x'.repeat(500)
    const adapter = makeAdapter([item('t', 'https://a.com', longSnippet)])
    const orch = new SearchOrchestrator(adapter, { snippetMaxLen: 20, rerankTopK: 5 })
    const res = await orch.search('t')
    expect(res.cards[0].snippet.length).toBeLessThanOrEqual(21) // 20 + …
    expect(res.cards[0].snippet.endsWith('…')).toBe(true)
  })

  it('count 透传给 adapter.search', async () => {
    const adapter = makeAdapter()
    const orch = new SearchOrchestrator(adapter, { count: 3 })
    await orch.search('Qwen3')
    expect(adapter.search).toHaveBeenCalledWith(expect.any(String), { count: 3 })
    // override 优先
    await orch.search('Qwen3', { count: 2 })
    expect(adapter.search).toHaveBeenLastCalledWith(expect.any(String), { count: 2 })
  })

  it('自定义 reranker 注入', async () => {
    const adapter = makeAdapter()
    const custom: SearchResultItem[] = [item('custom top', 'https://custom.com', 'custom')]
    const reranker = vi.fn(async (_q: string, _items: SearchResultItem[]) =>
      custom.map((it, idx) => ({ ...it, score: 100 - idx, rank: idx + 1 })),
    )
    const orch = new SearchOrchestrator(adapter, { reranker })
    const res = await orch.search('anything')
    expect(reranker).toHaveBeenCalled()
    expect(res.ranked[0].url).toBe('https://custom.com')
    expect(res.cards[0].url).toBe('https://custom.com')
  })

  it('searchAndAppend — 回答末尾附来源卡片', async () => {
    const adapter = makeAdapter()
    const orch = new SearchOrchestrator(adapter, { rerankTopK: 1 })
    const { result, appended } = await orch.searchAndAppend('Qwen3', '这是 LLM 回答。')
    expect(result.cards.length).toBe(1)
    expect(appended).toContain('这是 LLM 回答。')
    expect(appended).toContain('**来源**')
    expect(appended).toContain(result.cards[0].url)
  })

  it('实例方法 rerank / cite / format / appendToAnswer 代理', () => {
    const orch = new SearchOrchestrator(makeAdapter(), { rerankTopK: 1 })
    const ranked = orch.rerank('Qwen3', mockItems.slice(0, 2))
    expect(ranked).toHaveLength(1)
    const cards = orch.cite([item('t', 'https://a.com', 's')])
    expect(cards[0].title).toBe('t')
    expect(orch.format(cards)).toContain('[1]')
    expect(orch.appendToAnswer('ans', cards)).toContain('---')
  })

  it('orchestrateSearch / createOrchestrator 函数式入口', async () => {
    const adapter = makeAdapter()
    const res = await orchestrateSearch('Qwen3', { adapter, rerankTopK: 1 })
    expect(res.cards).toHaveLength(1)

    const orch = createOrchestrator(adapter, { rerankTopK: 1 })
    expect(orch).toBeInstanceOf(SearchOrchestrator)
    const res2 = await orch.search('Qwen3')
    expect(res2.cards).toHaveLength(1)
  })

  it('來源卡片 title/url/snippet 完整 — 回答末尾可渲染', async () => {
    const adapter = makeAdapter([item('My Title', 'https://example.com/page', 'Some snippet for citation')])
    const orch = new SearchOrchestrator(adapter)
    const { cards, markdown } = await orch.search('My Title')
    expect(cards[0]).toEqual({ id: 1, title: 'My Title', url: 'https://example.com/page', snippet: 'Some snippet for citation' })
    // markdown 中三要素齐全
    expect(markdown).toContain('My Title')
    expect(markdown).toContain('https://example.com/page')
    expect(markdown).toContain('Some snippet')
  })
})
