// @vitest-environment jsdom
/**
 * Chat.characterization.test.tsx — todo29 baseline lock: pins Chat.tsx's
 * EXISTING behavior (chat-mode send path, composer/abort controls) so the
 * additive agent-mode integration provably changes nothing by default.
 * Same jsdom/createRoot harness as Chat.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let Chat: typeof import('./Chat').Chat

function setFakeApi(): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'chat:send') return { ok: true, id: (payload as { id: string }).id, streaming: true }
    return { ok: true }
  })
  const on = vi.fn(() => () => undefined)
  ;(window as unknown as { api: unknown }).api = { invoke, on }
  return { invoke }
}

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Chat presets={[]} />)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('./Chat')
  Chat = mod.Chat
})

afterEach(() => {
  unmount()
  delete (window as unknown as { api?: unknown }).api
  vi.restoreAllMocks()
})

describe('Chat baseline (chat mode = default, pre-29 behavior)', () => {
  it('composer Send routes to chat:send, never agent:start', async () => {
    const { invoke } = setFakeApi()
    await mount()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'ping')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send')
    expect(sendBtn).toBeDefined()
    await act(async () => {
      sendBtn!.click()
      await Promise.resolve()
    })
    expect(invoke.mock.calls.some((c) => c[0] === 'chat:send')).toBe(true)
    expect(invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(false)
  })

  it('no agent timeline is mounted in chat mode', async () => {
    setFakeApi()
    await mount()
    expect(container.querySelector('[data-testid="agent-timeline"]')).toBeNull()
    expect(container.querySelector('[data-testid="permission-dialog"]')).toBeNull()
  })

  it('todo29 additive path: 代理 mode routes the composer to agent:start, chat:send untouched', async () => {
    const { invoke } = setFakeApi()
    await mount()
    await act(async () => {
      ;(container.querySelector('[data-testid="mode-agent"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="agent-timeline"]')).toBeTruthy()
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'fix the build')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const runBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '运行')
    expect(runBtn).toBeDefined()
    await act(async () => {
      runBtn!.click()
      await Promise.resolve()
    })
    expect(invoke.mock.calls.some((c) => c[0] === 'agent:start')).toBe(true)
    expect(invoke.mock.calls.some((c) => c[0] === 'chat:send')).toBe(false)
  })
})
