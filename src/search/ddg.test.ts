/**
 * ddg.test.ts — DuckDuckGo 免费搜索适配器：HTML 解析 + 降级语义。
 */

import { describe, expect, it, vi } from 'vitest'

import { DdgAdapter, parseDdgHtml } from './ddg'

const HTML = `
<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc"><b>结果一</b> 标题</a>
  <a class="result__snippet" href="#">这是 <b>第一条</b> 摘要 &amp; 说明</a>
</div>
<div class="result">
  <a class="result__a" href="https://direct.com/b">直接链接</a>
  <a class="result__snippet" href="#">第二条摘要</a>
</div>
`

describe('parseDdgHtml', () => {
  it('解析标题/跳转链接/摘要，strip 标签与实体', () => {
    const items = parseDdgHtml(HTML, 8)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      title: '结果一 标题',
      url: 'https://example.com/a',
      snippet: '这是 第一条 摘要 & 说明',
    })
    expect(items[1]!.url).toBe('https://direct.com/b')
  })
  it('limit 截断', () => {
    expect(parseDdgHtml(HTML, 1)).toHaveLength(1)
  })
})

describe('DdgAdapter', () => {
  it('search 成功 → 归一结果', async () => {
    const fetchImpl = vi.fn(async () => new Response(HTML, { status: 200 }))
    const a = new DdgAdapter({ fetchImpl: fetchImpl as never })
    const items = await a.search('qwen3 本地部署')
    expect(items).toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('q='), expect.anything())
  })
  it('非 2xx / 网络错误 → 空数组（编排器降级）', async () => {
    const a = new DdgAdapter({ fetchImpl: (async () => new Response('nope', { status: 403 })) as never })
    await expect(a.search('x')).resolves.toEqual([])
    const b = new DdgAdapter({ fetchImpl: (async () => { throw new Error('net') }) as never })
    await expect(b.search('x')).resolves.toEqual([])
  })
  it('空 query → 空数组', async () => {
    const a = new DdgAdapter({ fetchImpl: vi.fn() as never })
    await expect(a.search('  ')).resolves.toEqual([])
  })
})
