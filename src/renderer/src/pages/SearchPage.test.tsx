// @vitest-environment jsdom
/**
 * SearchPage.test.tsx — todo39 混合检索页：mount → rag:status 横幅；hash 模式
 * 显示降级提示；查询 → rag:query → [n] 引用卡片 → 点击弹 dialog；入库 →
 * rag:ingest 备注；网页按钮 → search:run 卡片列表。
 * 回归 pin：setState 收到 bound invoke 函数会被 React 当 updater 调
 * invoke(null) → preload throw（e2e 冒烟曾整机白屏）—— 本测试锁死该路径。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SearchPage } from './SearchPage'
import type { RagCitation } from '../../../main/ipc/whitelist'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function cite(n: number, source: string): RagCitation {
  return {
    n,
    chunkId: `${source}#0`,
    source,
    page: 0,
    line: 3,
    charOffset: 12,
    snippet: `snippet ${n}`,
    rrf: 0.032,
    ranks: { bm25: 1, vector: 1 },
    bm25Score: 1.5,
  }
}

function setApi(overrides: { status?: object; query?: object; ingest?: object; search?: object } = {}) {
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel === 'rag:status') return { ok: true, mode: 'hash', docs: ['D:/docs/a.md'], chunks: 7, ftsAvailable: true, rerankEnabled: false, ...overrides.status }
    if (channel === 'rag:query') return { ok: true, citations: [cite(1, 'D:/docs/a.md'), cite(2, 'D:/docs/b.md')], mode: 'hash', rerank: { attempted: false, ok: false }, ...overrides.query }
    if (channel === 'rag:ingest') return { ok: true, docs: ['D:/docs/new.txt'], chunks: 3, mode: 'hash', ...overrides.ingest }
    if (channel === 'search:run') return { ok: true, result: { cards: [{ id: 1, title: 'Web', url: 'http://127.0.0.1/x', snippet: 's' }] }, ...overrides.search }
    return { ok: true }
  })
  ;(window as unknown as { api: unknown }).api = { invoke, on: vi.fn(() => () => undefined) }
  return invoke
}

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<SearchPage />)
    await new Promise((r) => setTimeout(r, 0))
  })
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

function setInput(el: Element, value: string): void {
  const input = el as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('SearchPage — todo39', () => {
  it('mount 不崩（回归 pin：bound invoke 不得被 setState 当 updater 触发）', async () => {
    setApi()
    await mount()
    expect(container.querySelector('h1.las-page-title')?.textContent).toBe('Search')
    expect(byTestId('rag-status-line')?.textContent).toContain('1 篇 / 7 块')
  })

  it('hash 模式显示降级横幅', async () => {
    setApi()
    await mount()
    expect(byTestId('rag-degraded-banner')).toBeTruthy()
  })

  it('查询 → 引用卡片（lane 徽章 + 页/行）→ 点击弹 dialog', async () => {
    const invoke = setApi()
    await mount()
    setInput(byTestId('rag-query-input')!, '混合检索是什么')
    await act(async () => {
      ;(byTestId('rag-query-button') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('rag:query', { q: '混合检索是什么' })
    expect(byTestId('cite-chip-1')).toBeTruthy()
    expect(byTestId('cite-chip-2')?.textContent).toContain('b.md')
    await act(async () => {
      ;(byTestId('cite-chip-1') as HTMLButtonElement).click()
    })
    expect(byTestId('citation-dialog')).toBeTruthy()
    expect(byTestId('citation-snippet')?.textContent).toContain('snippet 1')
  })

  it('勾选精排 → rag:query 携带 rerank:true；不可用时显示回退提示', async () => {
    const invoke = setApi({
      query: { ok: true, citations: [cite(1, 'a.md')], mode: 'hash', rerank: { attempted: true, ok: false, reason: 'http' } },
    })
    await mount()
    const toggle = byTestId('rag-rerank-toggle') as HTMLInputElement
    act(() => {
      toggle.click()
    })
    setInput(byTestId('rag-query-input')!, 'q')
    await act(async () => {
      ;(byTestId('rag-query-button') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('rag:query', { q: 'q', topK: undefined, rerank: true })
    expect(byTestId('rag-rerank-unavailable')?.textContent).toContain('回退')
  })

  it('入库路径 → rag:ingest 成功备注', async () => {
    const invoke = setApi()
    await mount()
    setInput(byTestId('rag-ingest-input')!, 'D:/docs/corpus')
    await act(async () => {
      ;(byTestId('rag-ingest-button') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('rag:ingest', { path: 'D:/docs/corpus' })
    expect(byTestId('rag-ingest-note')?.textContent).toContain('3 块')
  })

  it('网页搜索 → search:run 卡片渲染（web lane 独立于本地库）', async () => {
    const invoke = setApi()
    await mount()
    setInput(byTestId('rag-query-input')!, 'news')
    await act(async () => {
      ;(byTestId('rag-web-button') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('search:run', { query: 'news' })
    expect(byTestId('web-results')?.textContent).toContain('Web')
  })

  it('无 window.api — 只读横幅，不发任何 IPC', async () => {
    await mount()
    expect(byTestId('rag-query-button')).toBeTruthy()
    expect((byTestId('rag-query-button') as HTMLButtonElement).disabled).toBe(true)
  })
})
