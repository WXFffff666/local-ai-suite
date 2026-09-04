// @vitest-environment jsdom
/**
 * quickask.test.tsx — todo41 快速问答浮窗（jsdom，约定同 overlay.test.tsx：
 * createRoot + act + 假 window.api，事件监听按通道捕获）。
 * 覆盖计划断言：Enter 发送 / Shift+Enter 换行不发送 / 空输入不发送、
 * quickask:delta 按 id 聚合流式、done 收尾、error 上屏、Esc → quickask:hide、
 * blur 300ms 宽限假定时器隐藏（pointer 回窗 mousemove / focus 取消）、
 * 剪贴板预拉（mount pull）与再呼起 push 双路占位、50 条历史上限（capHistory）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QuickAskApp, capHistory, QUICKASK_BLUR_GRACE_MS, QUICKASK_HISTORY_CAP, type QuickAskApi } from './QuickAskApp'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent } from '../../../main/ipc/whitelist'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type Listeners = Record<string, Array<(payload: never) => void>>

function makeFakeApi(prefillReply: unknown = { ok: true, prefill: null }) {
  const asks: Array<{ id: string; model: string; messages: Array<{ role: string; content: string }> }> = []
  let hides = 0
  const listeners: Listeners = {}
  const invoke = vi.fn(async (channel: string, payload: unknown): Promise<unknown> => {
    if (channel === 'quickask:ask') {
      asks.push(payload as (typeof asks)[number])
      return { ok: true, id: (payload as { id: string }).id, streaming: true }
    }
    if (channel === 'quickask:hide') {
      hides += 1
      return { ok: true }
    }
    if (channel === 'quickask:prefill:get') return prefillReply
    throw new Error(`unexpected channel ${channel}`)
  })
  const on = vi.fn((channel: string, l: (payload: never) => void) => {
    const list = (listeners[channel] ??= [])
    list.push(l)
    return () => {
      const i = list.indexOf(l)
      if (i >= 0) list.splice(i, 1)
    }
  })
  const emit = (channel: string, payload: unknown): void => {
    for (const l of [...(listeners[channel] ?? [])]) (l as (p: unknown) => void)(payload)
  }
  const api = { invoke, on } as unknown as QuickAskApi
  return { api, invoke, asks, emit, getHides: () => hides, listeners }
}

let container: HTMLDivElement
let root: Root

async function mount(api: QuickAskApi | null): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = <QuickAskApp api={api} />
  await act(async () => {
    root.render(tree)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function input(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>('[data-testid="las-quickask-input"]')
  if (!el) throw new Error('quickask input not mounted')
  return el
}

function typeText(text: string): void {
  const el = input()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function key(target: Element, k: string, shift = false): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }))
  })
}

function winEvent(type: string): void {
  act(() => {
    window.dispatchEvent(new Event(type))
  })
}

function bubbles(): string[] {
  return Array.from(container.querySelectorAll('[data-role]')).map((el) => `${el.getAttribute('data-role')}:${el.textContent}`)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
})

afterEach(() => {
  unmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('QuickAskApp 发送通路', () => {
  it('Enter → quickask:ask（model local + user 轮次），气泡显示两角色', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    typeText('什么是 GQA？')
    key(input(), 'Enter')
    expect(f.asks).toHaveLength(1)
    expect(f.asks[0]?.model).toBe('local')
    expect(f.asks[0]?.messages).toEqual([{ role: 'user', content: '什么是 GQA？' }])
    expect(bubbles()).toContain('user:什么是 GQA？')
    // 输入框清空待流式
    expect(input().value).toBe('')
  })

  it('delta 按 id 聚合流式 → done 收尾（挂起占位消失，内容累积）', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    typeText('hi')
    key(input(), 'Enter')
    const id = f.asks[0]?.id as string
    await act(async () => {
      f.emit('quickask:delta', { id, delta: 'Hello' } satisfies ChatDeltaEvent)
    })
    await act(async () => {
      f.emit('quickask:delta', { id, delta: ' world!' } satisfies ChatDeltaEvent)
    })
    expect(bubbles()).toContain(`assistant:Hello world!`)
    await act(async () => {
      f.emit('quickask:done', { id, model: 'local' } satisfies ChatDoneEvent)
    })
    expect(container.textContent).not.toContain('…')
  })

  it('error 事件：终止挂起并把消息文本渲染到 role=alert', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    typeText('hi')
    key(input(), 'Enter')
    const id = f.asks[0]?.id as string
    await act(async () => {
      f.emit('quickask:error', { id, message: '上游 500' } satisfies ChatErrorEvent)
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('上游 500')
    expect(container.textContent).not.toContain('…')
  })

  it('多轮：第二轮 ask 的 messages 携带已定稿历史（user+assistant 成对）', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    typeText('第一问')
    key(input(), 'Enter')
    const id1 = f.asks[0]?.id as string
    await act(async () => {
      f.emit('quickask:delta', { id: id1, delta: '答一' } satisfies ChatDeltaEvent)
      f.emit('quickask:done', { id: id1 } satisfies ChatDoneEvent)
    })
    typeText('第二问')
    key(input(), 'Enter')
    expect(f.asks[1]?.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '第二问' },
    ])
  })

  it('Shift+Enter 换行不发送；空输入 Enter 不发送', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    key(input(), 'Enter') // 空输入 → 不发送
    expect(f.asks).toHaveLength(0)
    typeText('multi')
    key(input(), 'Enter', true) // Shift+Enter → 交回 textarea 换行，不发送
    expect(f.asks).toHaveLength(0)
    expect(input().value).toBe('multi')
    key(input(), 'Enter') // 纯 Enter → 现在发送
    expect(f.asks).toHaveLength(1)
  })
})

describe('QuickAskApp 隐藏通路', () => {
  it('Esc（任意焦点）→ quickask:hide', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(f.getHides()).toBe(1)
  })

  it('blur → 300ms 宽限到期 hide；宽限内 focus 取消', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    winEvent('blur')
    await act(async () => {
      vi.advanceTimersByTime(QUICKASK_BLUR_GRACE_MS - 50)
    })
    expect(f.getHides()).toBe(0)
    winEvent('focus')
    await act(async () => {
      vi.advanceTimersByTime(QUICKASK_BLUR_GRACE_MS + 100)
    })
    expect(f.getHides(), 'focus cancels the pending hide').toBe(0)
    winEvent('blur')
    await act(async () => {
      vi.advanceTimersByTime(QUICKASK_BLUR_GRACE_MS + 10)
    })
    expect(f.getHides(), 'a fresh blur re-arms the grace timer').toBe(1)
  })

  it('blur 后 pointer 回窗（mousemove）取消隐藏 — 计划"pointer re-enter cancels"', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    winEvent('blur')
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    winEvent('mousemove')
    await act(async () => {
      vi.advanceTimersByTime(QUICKASK_BLUR_GRACE_MS + 100)
    })
    expect(f.getHides()).toBe(0)
  })
})

describe('QuickAskApp 剪贴板预填', () => {
  it('mount pull 非空 prefill → 占位含剪贴板文本', async () => {
    const f = makeFakeApi({ ok: true, prefill: '参考这段报错' })
    await mount(f.api)
    expect(input().placeholder).toContain('参考这段报错')
    expect(f.invoke).toHaveBeenCalledWith('quickask:prefill:get', {})
  })

  it('mount pull no-window（陈旧帧）→ 保持默认占位，不崩', async () => {
    const f = makeFakeApi({ ok: false, error: 'no-window' })
    await mount(f.api)
    expect(input().placeholder).toContain('输入问题')
  })

  it('再呼起 push（quickask:prefill 事件）→ 占位更新', async () => {
    const f = makeFakeApi()
    await mount(f.api)
    await act(async () => {
      f.emit('quickask:prefill', { text: '新的一段' })
    })
    expect(input().placeholder).toContain('新的一段')
  })
})

describe('capHistory — 50 条内存上限（纯函数）', () => {
  it('≤cap 原样；>cap 丢最旧保尾 50', () => {
    const small = [1, 2, 3]
    expect(capHistory(small)).toEqual([1, 2, 3])
    const big = Array.from({ length: 80 }, (_, i) => i)
    const capped = capHistory(big)
    expect(capped).toHaveLength(QUICKASK_HISTORY_CAP)
    expect(capped[0]).toBe(80 - QUICKASK_HISTORY_CAP)
    expect(capped.at(-1)).toBe(79)
  })
})

describe('QuickAskApp 无 IPC 环境', () => {
  it('api=null（非 Electron）→ 渲染 null，不崩', async () => {
    await mount(null)
    expect(container.textContent).toBe('')
  })
})
