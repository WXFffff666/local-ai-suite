// @vitest-environment jsdom
/**
 * ExportHtmlButton.test.tsx — todo42 导出按钮 → chat:exportHtml 线协议。
 * 约定（App.test.tsx 同型）：act + createRoot + window.api 桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ExportHtmlButton from './ExportHtmlButton'
import type { ChatSession } from '../../../../chat/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

const session: ChatSession = {
  id: 's1',
  title: '报告:<>|bad',
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: 'm1', role: 'user', content: 'hi', createdAt: 1 },
    { id: 'm2', role: 'assistant', content: 'yo', createdAt: 2 },
    { id: 'm3', role: 'assistant', content: 'streaming…', createdAt: 3, pending: true },
  ],
}

let container: HTMLDivElement
let root: Root

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(node)
  })
}

beforeEach(() => {
  setFakeApi(undefined)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

function button(): HTMLButtonElement {
  const b = container.querySelector<HTMLButtonElement>('button[data-testid="export-html-button"]')
  if (!b) throw new Error('export button missing')
  return b
}

describe('ExportHtmlButton (todo42)', () => {
  it('无 window.api → 按钮渲染但禁用（诚实不可用，不隐藏）', () => {
    mount(<ExportHtmlButton session={session} />)
    expect(button().disabled).toBe(true)
  })

  it('点击 → invoke chat:exportHtml {html(已剔除 pending), filename=原标题}', async () => {
    const invoke = vi.fn(async () => ({ ok: true, path: 'C:\\out\\x.html' }))
    setFakeApi({ invoke, on: vi.fn(() => () => undefined) })
    mount(<ExportHtmlButton session={session} />)
    expect(button().disabled).toBe(false)
    await act(async () => {
      button().click()
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    const [channel, payload] = invoke.mock.calls[0] as unknown as [string, { html: string; filename: string }]
    expect(channel).toBe('chat:exportHtml')
    // 主进程负责文件名净化 — 渲染层原样送标题（单一净化点）
    expect(payload.filename).toBe('报告:<>|bad')
    expect(payload.html).toContain('hi')
    expect(payload.html).not.toContain('streaming…')
  })

  it('cancelled 回复不打错误 toast（良性取消静默）', async () => {
    setFakeApi({ invoke: vi.fn(async () => ({ ok: false, error: 'cancelled' })), on: vi.fn(() => () => undefined) })
    mount(<ExportHtmlButton session={session} />)
    await act(async () => {
      button().click()
    })
    // sonner 容器里不应出现失败 toast 文案
    expect(document.body.textContent ?? '').not.toContain('导出失败')
  })
})
