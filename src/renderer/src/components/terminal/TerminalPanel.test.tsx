// @vitest-environment jsdom
/**
 * TerminalPanel.test.tsx — todo28 xterm panel jsdom tests. @xterm/xterm and
 * @xterm/addon-fit are mocked (jsdom has no canvas/render loop); the tests
 * pin the panel's OWN logic: null render without window.api, per-callId tabs,
 * live write of new chunks into the active terminal, full rewrite on tab
 * switch, and the tool_result collapse transition.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import TerminalPanel from './TerminalPanel'
import type { AgentTermEvent } from '../../../../main/ipc/whitelist'
import type { AgentEvent } from '../../../../agent/runner/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// --- xterm fakes (module-mocked; written via hoisted spies) ---------------------
const termWrites = vi.hoisted(() => vi.fn())
const termResets = vi.hoisted(() => vi.fn())

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    readonly options: Record<string, unknown>
    private el_: HTMLElement | null = null
    constructor(options?: Record<string, unknown>) {
      this.options = options ?? {}
    }
    open(el: HTMLElement): void {
      this.el_ = el
    }
    get element(): HTMLElement | null {
      return this.el_
    }
    write = termWrites
    reset = termResets
    dispose(): void {
      /* noop */
    }
    loadAddon(): void {
      /* noop */
    }
    onResize(): { dispose(): void } {
      return { dispose: (): void => undefined }
    }
  }
  return { Terminal: FakeTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate(): void {
      /* noop */
    }
    fit(): void {
      /* noop */
    }
  },
}))

type FakeApi = {
  on: ReturnType<typeof vi.fn>
  emit: (channel: 'agent:term' | 'agent:event', payload: AgentTermEvent | AgentEvent) => void
}

function fakeApi(): FakeApi {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  return {
    on: vi.fn((channel: string, listener: (p: unknown) => void) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      return () => set?.delete(listener)
    }),
    emit(channel, payload) {
      for (const l of listeners.get(channel) ?? []) l(payload)
    },
  }
}

function toolResult(callId: string): AgentEvent {
  return { type: 'tool_result', sessionId: 's1', callId, name: 'run_shell', ok: true, content: '{}', durationMs: 9 }
}

let api: FakeApi
let container: HTMLDivElement
let root: Root

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<TerminalPanel />)
  })
}

function tabs(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="term-tab"]'))
}

beforeEach(() => {
  termWrites.mockClear()
  termResets.mockClear()
  api = fakeApi()
  Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true })
  mount()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TerminalPanel', () => {
  it('renders nothing outside Electron (no window.api)', () => {
    act(() => root.unmount())
    Object.defineProperty(window, 'api', { value: undefined, configurable: true, writable: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<TerminalPanel />)
    })
    expect(container.querySelector('[data-testid="terminal-panel"]')).toBeNull()
  })

  it('renders no panel chrome until the first chunk arrives', () => {
    expect(container.querySelector('[data-testid="terminal-panel"]')).toBeNull()
  })

  it('shows a tab per callId and streams the active buffer into xterm', () => {
    act(() => api.emit('agent:term', { id: 'c1', chunk: 'hello' }))
    expect(tabs().map((t) => t.textContent)).toEqual(['c1'])
    expect(termWrites).toHaveBeenCalledWith(expect.stringContaining('hello'))
    act(() => api.emit('agent:term', { id: 'c1', chunk: ' world' }))
    expect(termWrites).toHaveBeenLastCalledWith(' world') // live delta, no rewrite
  })

  it('rewrites the terminal (reset + full write) when switching tabs', () => {
    act(() => {
      api.emit('agent:term', { id: 'c1', chunk: 'one' })
      api.emit('agent:term', { id: 'c2', chunk: 'two' })
    })
    act(() => {
      tabs()[1]?.click()
    })
    expect(termResets).toHaveBeenCalled()
    expect(termWrites).toHaveBeenLastCalledWith(expect.stringContaining('two'))
  })

  it('collapses the active buffer when its tool_result event lands', () => {
    act(() => {
      api.emit('agent:term', { id: 'c1', chunk: 'done soon' })
      api.emit('agent:event', toolResult('c1'))
    })
    const panel = container.querySelector('[data-testid="terminal-panel"]')
    const active = container.querySelector('[data-testid="term-view"]')
    expect(active?.hasAttribute('hidden')).toBe(true)
    expect(tabs()[0]?.getAttribute('data-done')).toBe('true')
    // re-expanding through the tab restores the full buffer text
    act(() => {
      tabs()[0]?.click()
    })
    expect(container.querySelector('[data-testid="term-view"]')?.hasAttribute('hidden')).toBe(false)
    expect(termWrites).toHaveBeenLastCalledWith(expect.stringContaining('done soon'))
    expect(panel).not.toBeNull()
  })
})
