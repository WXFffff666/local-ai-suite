/**
 * DuckDuckGo 免费搜索适配器（阶段5）— 无 key、零依赖、纯 fetch：
 * 请求 html.duckduckgo.com/html/ 并以正则解析结果（DDG 无官方免费 API，
 * HTML 端点是最稳定的免费通道；被限流/失败时由编排器降级到下一来源）。
 *
 * 与 SearxngAdapter 同实现 ISearchAdapter；免费优先顺序：本地 SearXNG → DDG →
 * 可选云 key 源（Tavily/Exa/Brave）。
 *
 * MIT, 无 AGPL.
 */

import type { ISearchAdapter, SearchResultItem } from '../core/types'

export const DDG_NAME = 'ddg' as const
const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'

export type DdgDeps = {
  fetchImpl?: typeof globalThis.fetch
  count?: number
  timeoutMs?: number
}

/** 从 DDG HTML 结果中解析（a.result__a: 标题+链接；a.result__snippet: 摘要） */
export function parseDdgHtml(html: string, limit = 8): SearchResultItem[] {
  const out: SearchResultItem[] = []
  // 链接形如 //duckduckgo.com/l/?uddg=<encodeURIComponent(target)>&rut=...
  const blockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  const snippetAll = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  while ((sm = snippetAll.exec(html)) !== null) snippets.push(stripTags(sm[1] ?? ''))
  let idx = 0
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null && out.length < limit) {
    const href = m[1] ?? ''
    const title = stripTags(m[2] ?? '')
    if (title === '') continue
    const url = decodeDdgHref(href)
    if (url === null) continue
    out.push({
      title,
      url,
      snippet: snippets[idx] ?? '',
    })
    idx += 1
  }
  return out
}

function decodeDdgHref(href: string): string | null {
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m !== null) {
    try {
      return decodeURIComponent(m[1] ?? '')
    } catch {
      return null
    }
  }
  if (href.startsWith('http')) return href
  if (href.startsWith('//')) return `https:${href}`
  return null
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class DdgAdapter implements Pick<ISearchAdapter, 'search'> {
  name = DDG_NAME
  private readonly doFetch: typeof globalThis.fetch
  private readonly count: number
  private readonly timeoutMs: number

  constructor(opts: DdgDeps = {}) {
    this.doFetch = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
    this.count = opts.count ?? 8
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  async search(query: string, searchOpts?: { count?: number }): Promise<SearchResultItem[]> {
    const q = query.trim()
    if (q === '') return []
    const limit = searchOpts?.count ?? this.count
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.doFetch(`${DDG_ENDPOINT}?q=${encodeURIComponent(q)}&kl=cn-zh`, {
        method: 'GET',
        headers: {
          // DDG HTML 端点对无 UA 的请求会 403
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) local-ai-suite',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        },
        signal: ctrl.signal,
      })
      if (!res.ok) return []
      const html = await res.text()
      return parseDdgHtml(html, limit)
    } catch {
      return [] // 编排器降级到下一来源
    } finally {
      clearTimeout(timer)
    }
  }
}

export default DdgAdapter
