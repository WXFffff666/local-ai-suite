// @vitest-environment jsdom
/**
 * AgentModeToggle + AgentTimeline mount tests (todo29) — segmented switch
 * persists per session, mid-run switch-away is confirm-guarded (and stops
 * the run on accept, keeps agent mode on decline), and the timeline renders
 * a full event matrix (plan card, both phase badges, ok/fail folded
 * results, live text, aborted note, context-length friendly copy) with the
 * Stop button wired to agent:cancel.
 *
 * The components talk to the module-singleton zustand store, so each test
 * resets the module registry and sets window.api to a fake BEFORE importing
 * (the singleton's default resolveApi reads window.api at action time).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AgentEvent } from '../../../../agent/runner/types'
;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no canvas/render loop: stub the xterm pair the drawer mounts
// (same fake strategy as todo28's TerminalPanel tests).
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    reset(): void {}
    dispose(): void {}
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    activate(): void {}
    dispose(): void {}
  },
}))

type Listener = (e: AgentEvent) => void

function fakeApi() {
  const byChannel = new Map<string, Listener[]>()
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'agent:start') {
      return { ok: true, sessionId: (payload as { sessionId: string }).sessionId, started: true }
    }
    return { ok: true, sessionId: (payload as { sessionId: string }).sessionId, cancelled: true }
  })
  const on = vi.fn((channel: string, cb: Listener) => {
    const list = byChannel.get(channel) ?? []
    list.push(cb)
    byChannel.set(channel, list)
    return () => undefined
  })
  const emit = (e: AgentEvent): void => (byChannel.get('agent:event') ?? []).slice().forEach((l) => l(e))
  return { api: { invoke, on }, invoke, emit }
}

let AgentModeToggle: typeof import('./AgentModeToggle').default
let AgentTimeline: typeof import('./AgentTimeline').default
let store: typeof import('./agentStore').useAgentStore
let f: ReturnType<typeof fakeApi>

let container: HTMLDivElement
let root: Root

async function mount(node: React.ReactNode): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
}

async function startRun(sessionKey: string): Promise<string> {
  await act(async () => {
    await store.getState().startRun(sessionKey, 'go')
  })
  return store.getState().sessionIds[sessionKey]
}

async function flush(): Promise<void> {
  await act(async () => undefined)
}

beforeEach(async () => {
  vi.resetModules()
  f = fakeApi()
  Object.defineProperty(window, 'api', { value: f.api, configurable: true, writable: true })
  vi.stubGlobal('confirm', vi.fn(() => true))
  const mod = await import('./agentStore')
  store = mod.useAgentStore
  AgentModeToggle = (await import('./AgentModeToggle')).default
  AgentTimeline = (await import('./AgentTimeline')).default
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete (window as unknown as { api?: unknown }).api
})

describe('AgentModeToggle', () => {
  it('renders two segments, chat active by default; clicking 代理 switches', async () => {
    await mount(<AgentModeToggle sessionKey="s-1" />)
    const chat = container.querySelector('[data-testid="mode-chat"]') as HTMLButtonElement
    const agent = container.querySelector('[data-testid="mode-agent"]') as HTMLButtonElement
    expect(chat.getAttribute('aria-pressed')).toBe('true')
    expect(agent.getAttribute('aria-pressed')).toBe('false')
    await act(async () => agent.click())
    expect(store.getState().modes['s-1']).toBe('agent')
  })

  it('mid-run switch back to 聊天 asks confirm; decline keeps agent mode, accept stops the run', async () => {
    await mount(<AgentModeToggle sessionKey="s-2" />)
    store.getState().setMode('s-2', 'agent')
    const sid = await startRun('s-2')
    const chat = container.querySelector('[data-testid="mode-chat"]') as HTMLButtonElement

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await act(async () => chat.click())
    await flush()
    expect(window.confirm).toHaveBeenCalled()
    expect(store.getState().modes['s-2']).toBe('agent')

    await act(async () => chat.click())
    await flush()
    expect(store.getState().modes['s-2']).toBe('chat')
    expect(f.invoke).toHaveBeenCalledWith('agent:cancel', { sessionId: sid })
    expect(store.getState().runs['s-2']?.phase).toBe('stopping')
  })
})

describe('AgentTimeline render matrix', () => {
  it('idle shows the ready hint and no stop button', async () => {
    await mount(<AgentTimeline sessionKey="t-idle" />)
    expect(container.querySelector('[data-testid="agent-timeline"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="agent-stop"]')).toBeNull()
  })

  it('full task timeline: plan + awaiting→running→result cards + answer + finished', async () => {
    await mount(<AgentTimeline sessionKey="t-1" />)
    const sid = await startRun('t-1')
    await flush()
    expect(container.querySelector('[data-testid="agent-stop"]')).toBeTruthy()

    await act(async () =>
      f.emit({
        type: 'plan',
        sessionId: sid,
        iteration: 1,
        steps: [{ callId: 'c1', name: 'read_file', argsSummary: '{"path":"a.ts"}' }],
      }),
    )
    await act(async () =>
      f.emit({
        type: 'tool_call',
        sessionId: sid,
        callId: 'c1',
        name: 'read_file',
        args: { path: 'a.ts' },
        phase: 'awaiting-permission',
      }),
    )
    expect(container.querySelector('[data-testid="agent-plan"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="agent-phase-badge"]')?.textContent).toBe('待授权')

    await act(async () =>
      f.emit({ type: 'tool_call', sessionId: sid, callId: 'c1', name: 'read_file', args: { path: 'a.ts' }, phase: 'running' }),
    )
    expect(container.querySelector('[data-testid="agent-phase-badge"]')?.textContent).toBe('执行中')

    await act(async () =>
      f.emit({
        type: 'tool_result',
        sessionId: sid,
        callId: 'c1',
        name: 'read_file',
        ok: true,
        content: 'file body',
        durationMs: 7,
      }),
    )
    expect(container.querySelectorAll('[data-testid="agent-tool"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="agent-timeline"]')?.textContent).toContain('7ms')
    expect(container.querySelector('.agent-tool-result pre')?.textContent).toBe('file body')

    await act(async () => {
      f.emit({ type: 'message_delta', sessionId: sid, delta: 'done!' })
      f.emit({ type: 'finished', sessionId: sid, status: 'completed', iterations: 2, text: 'done!' })
    })
    expect(container.querySelector('[data-testid="agent-run-phase"]')?.textContent).toContain('已完成')
    expect(container.querySelector('[data-testid="agent-answer"]')?.textContent).toContain('done!')
    expect(container.querySelector('[data-testid="agent-stop"]')).toBeNull()
  })

  it('failed tool result + error event render failure affordances', async () => {
    await mount(<AgentTimeline sessionKey="t-2" />)
    const sid = await startRun('t-2')
    await act(async () =>
      f.emit({
        type: 'tool_result',
        sessionId: sid,
        callId: 'c9',
        name: 'run_shell',
        ok: false,
        content: 'TOOL_ERROR: denied',
        durationMs: 3,
      }),
    )
    await act(async () =>
      f.emit({ type: 'error', sessionId: sid, code: 'context-length', message: 'too many tokens', iteration: 4 }),
    )
    expect(container.querySelector('.agent-tool-failed')).toBeTruthy()
    const err = container.querySelector('[data-testid="agent-error"]')
    expect(err?.textContent).toContain('上下文窗口不足')
    expect(err?.querySelector('code')?.textContent).toBe('context-length')
    expect(container.querySelector('[data-testid="agent-stop"]')).toBeNull()
  })

  it('stop button invokes agent:cancel and the aborted state is visible', async () => {
    await mount(<AgentTimeline sessionKey="t-3" />)
    const sid = await startRun('t-3')
    await act(async () => f.emit({ type: 'message_delta', sessionId: sid, delta: 'working' }))
    const stop = container.querySelector('[data-testid="agent-stop"]') as HTMLButtonElement
    expect(stop).toBeTruthy()
    await act(async () => stop.click())
    expect(f.invoke).toHaveBeenCalledWith('agent:cancel', { sessionId: sid })
    await act(async () => f.emit({ type: 'finished', sessionId: sid, status: 'aborted', iterations: 1, text: 'working' }))
    expect(container.querySelector('[data-testid="agent-aborted"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="agent-run-phase"]')?.textContent).toContain('已停止')
  })

  it('terminal drawer hosts the collapsible panel shell', async () => {
    await mount(<AgentTimeline sessionKey="t-4" />)
    expect(container.querySelector('[data-testid="agent-term-drawer"]')).toBeTruthy()
  })
})
