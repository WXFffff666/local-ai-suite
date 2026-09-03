// @vitest-environment jsdom
/**
 * ChatPage.test.tsx — todo11 页面级渲染测试（jsdom docblock 约定同 App.test.tsx）
 * 覆盖：window.api 缺席 → 降级只读 UI（诚实提示 + 输入禁用）；
 *       window.api 在位 → 预设填充 + Send 走 chat:send IPC + delta/done 渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ChatPage from './ChatPage'
import { IPC_UNAVAILABLE_MESSAGE } from '../../../chat/store'
import type { ChatDeltaEvent, ChatDoneEvent } from '../../../main/ipc/whitelist'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type Listener = (payload: never) => void

function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

function makeFakeApi() {
  const listeners: Array<{ channel: string; cb: Listener }> = []
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'chat:send') return { ok: true, id: (payload as { id: string }).id, streaming: true }
    return { ok: true, id: (payload as { id: string }).id, aborted: true }
  })
  const on = vi.fn((channel: string, cb: Listener) => {
    const entry = { channel, cb }
    listeners.push(entry)
    return () => {
      const i = listeners.indexOf(entry)
      if (i >= 0) listeners.splice(i, 1)
    }
  })
  const emit = (channel: 'chat:delta' | 'chat:done', payload: ChatDeltaEvent | ChatDoneEvent) => {
    listeners.filter((l) => l.channel === channel).forEach((l) => l.cb(payload as never))
  }
  return { api: { invoke, on }, invoke, emit }
}

let container: HTMLDivElement
let root: Root

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = <ChatPage />
  act(() => {
    root.render(tree)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

beforeEach(() => {
  setFakeApi(undefined)
})

afterEach(() => {
  unmount()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

describe('ChatPage 降级模式（无 window.api）', () => {
  it('渲染诚实的 IPC 不可用提示且输入被禁用', () => {
    mount()
    expect(container.textContent).toContain('Chat')
    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toContain(IPC_UNAVAILABLE_MESSAGE)
    const textarea = container.querySelector('textarea')
    expect(textarea?.disabled).toBe(true)
  })
})

describe('ChatPage IPC 流式模式', () => {
  it('预设填充输入框，Send 走 chat:send，delta/done 事件渲染流式内容', async () => {
    const fake = makeFakeApi()
    setFakeApi(fake.api)
    mount()

    // 点击第一个对话预设 → prompt 填充
    const presetBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('思考演示'),
    )
    expect(presetBtn).toBeDefined()
    act(() => {
      presetBtn!.click()
    })
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toContain('鸡兔同笼')
    expect(textarea.disabled).toBe(false)

    // 换成可控短文本再发送
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'ping')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send')!
    await act(async () => {
      sendBtn.click()
      await Promise.resolve()
    })
    expect(fake.invoke).toHaveBeenCalledWith('chat:send', expect.objectContaining({ model: 'local' }))
    // todo17 起 window.api 是共享面：侧栏会先调 conversations:*。streamId 必须从
    // chat:send 那一次调用取，而不是固定的 calls[0]。
    const sendCall = fake.invoke.mock.calls.find((c) => c[0] === 'chat:send')
    const streamId = (sendCall as unknown as [string, { id: string }])[1].id

    await act(async () => {
      fake.emit('chat:delta', { id: streamId, delta: 'pong' })
      fake.emit('chat:delta', { id: streamId, delta: '!' })
    })
    expect(container.textContent).toContain('pong')
    // pending 中的 assistant 消息带流式标记
    expect(container.textContent).toContain('streaming')

    await act(async () => {
      fake.emit('chat:done', { id: streamId })
    })
    expect(container.textContent).toContain('pong!')
    expect(container.textContent).not.toContain('streaming…')
  })
})

describe('todo29 agent mode page smoke', () => {
  it('头部模式开关切到代理后时间线挂载；PermissionDialogHost 无请求时不渲染遮罩', async () => {
    const fake = makeFakeApi()
    setFakeApi(fake.api)
    mount()
    expect(container.querySelector('[data-testid="agent-mode-toggle"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="agent-timeline"]')).toBeNull()
    await act(async () => {
      ;(container.querySelector('[data-testid="mode-agent"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="agent-timeline"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="agent-term-drawer"]')).toBeTruthy()
    // 权限对话框宿主挂载但队列为空 -> 不渲染
    expect(container.querySelector('[data-testid="permission-dialog"]')).toBeNull()
    unmount()
  })
})
