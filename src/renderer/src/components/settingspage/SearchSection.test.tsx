// @vitest-environment jsdom
/**
 * SearchSection.test.tsx — todo39 设置页检索区：三态行渲染、hash 降级提示、
 * 精排开关 config:set 持久化回显、无 api 整区隐藏（SpeechSection 同契约）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SearchSection } from './SearchSection'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const OK = {
  ok: true as const,
  mode: 'hash' as const,
  docs: ['a.md'],
  chunks: 4,
  ftsAvailable: true,
  rerankEnabled: false,
}

function setApi(status: unknown = OK) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'rag:status') return status
    if (channel === 'config:set') return { ok: true, config: { ...(payload as object) } }
    throw new Error(`unexpected ${channel}`)
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
    root.render(<SearchSection />)
    await new Promise((r) => setTimeout(r, 0))
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('SearchSection', () => {
  it('hash 模式 → 引擎行 + plan 降级提示原文', async () => {
    setApi()
    await mount()
    const mode = container.querySelector('[data-testid="search-embed-mode"]')
    expect(mode?.textContent).toContain('哈希占位')
    expect(container.querySelector('[data-testid="search-embed-note"]')?.textContent).toContain('检索质量降级（无本地嵌入引擎）')
    expect(container.querySelector('[data-testid="search-library"]')?.textContent).toContain('1 篇 / 4 块')
  })

  it('ollama 模式带 model 名 + 无降级提示', async () => {
    setApi({ ...OK, mode: 'ollama', model: 'bge-m3' })
    await mount()
    expect(container.querySelector('[data-testid="search-embed-mode"]')?.textContent).toContain('Ollama')
    expect(container.querySelector('[data-testid="search-embed-mode"]')?.textContent).toContain('bge-m3')
    expect(container.querySelector('[data-testid="search-embed-note"]')?.textContent).not.toContain('降级')
  })

  it('精排开关 → config:set {rerankEnabled:true} 并回显选中态', async () => {
    const invoke = setApi()
    await mount()
    await act(async () => {
      ;(container.querySelector('[data-testid="search-rerank-true"]') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(invoke).toHaveBeenCalledWith('config:set', { rerankEnabled: true })
    expect((container.querySelector('[data-testid="search-rerank-true"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
  })

  it('无 window.api 整区隐藏', async () => {
    await mount()
    expect(container.querySelector('[aria-label="检索"]')).toBeNull()
  })
})
