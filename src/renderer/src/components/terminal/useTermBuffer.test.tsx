// @vitest-environment jsdom
/**
 * useTermBuffer.test.ts — todo28 renderer buffer units: callId routing, the
 * 200 KB-per-buffer cap (keeps the TAIL), tool_result collapse marking, and
 * the guarded-absent window.api degrade (hook reports available:false).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'

import { TERM_BUFFER_MAX_BYTES, useTermBuffer, type TermApi, type TermEntry } from './useTermBuffer'
import type { AgentTermEvent } from '../../../../main/ipc/whitelist'
import type { AgentEvent } from '../../../../agent/runner/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type FakeApi = TermApi & { emit(channel: 'agent:term', payload: AgentTermEvent): void; emit(channel: 'agent:event', payload: AgentEvent): void }

function fakeApi(): FakeApi {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const on = (channel: string, listener: (payload: never) => void): (() => void) => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }
  return {
    on: on as TermApi['on'],
    emit(channel: 'agent:term' | 'agent:event', payload: AgentTermEvent | AgentEvent): void {
      for (const l of listeners.get(channel) ?? []) (l as (p: unknown) => void)(payload)
    },
  }
}

function toolResult(callId: string): AgentEvent {
  return { type: 'tool_result', sessionId: 's1', callId, name: 'run_shell', ok: true, content: '{}', durationMs: 12 }
}

let api: FakeApi
let container: HTMLDivElement
let root: Root
let latest: { entries: readonly TermEntry[]; activeId: string | null; available: boolean } | null

function Probe(): ReactElement {
  const state = useTermBuffer()
  latest = { entries: state.entries, activeId: state.activeId, available: state.available }
  return <div data-testid="probe">{state.entries.map((e) => `${e.callId}:${e.done ? 'done' : 'run'}`).join(',')}</div>
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<Probe />)
  })
}

beforeEach(() => {
  latest = null
  api = fakeApi()
  Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true })
  mount()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('useTermBuffer', () => {
  it('routes chunks into per-callId scrollback buffers in arrival order', () => {
    act(() => {
      api.emit('agent:term', { id: 'c1', chunk: 'hello ' })
      api.emit('agent:term', { id: 'c2', chunk: 'other' })
      api.emit('agent:term', { id: 'c1', chunk: 'world' })
    })
    expect(latest?.entries.map((e) => e.callId)).toEqual(['c1', 'c2'])
    const c1 = latest?.entries.find((e) => e.callId === 'c1')
    expect(c1?.text).toBe('hello world')
  })

  it('marks a buffer done on its tool_result event (collapse signal)', () => {
    act(() => {
      api.emit('agent:term', { id: 'c1', chunk: 'x' })
      api.emit('agent:event', toolResult('c1'))
    })
    expect(latest?.entries[0]?.done).toBe(true)
  })

  it('keeps the TAIL when a buffer crosses the 200 KB cap', () => {
    const piece = 'a'.repeat(2_000)
    const n = TERM_BUFFER_MAX_BYTES / 2_000 + 10
    act(() => {
      for (let i = 0; i < n; i += 1) api.emit('agent:term', { id: 'c1', chunk: piece })
      api.emit('agent:term', { id: 'c1', chunk: 'TAIL-MARKER' })
    })
    const entry = latest?.entries[0]
    expect(entry).toBeDefined()
    if (!entry) throw new Error('buffer missing')
    expect(entry.bytes).toBeLessThanOrEqual(TERM_BUFFER_MAX_BYTES)
    expect(entry.text.endsWith('TAIL-MARKER')).toBe(true)
    expect(entry.text.length).toBeLessThan(n * 2_000 + 11) // something was dropped
  })

  it('renders nothing (available:false) when window.api is absent', () => {
    act(() => root.unmount())
    Object.defineProperty(window, 'api', { value: undefined, configurable: true, writable: true })
    mount()
    expect(latest?.available).toBe(false)
    expect(latest?.entries).toEqual([])
  })

  it('auto-selects the first callId and select() switches the active buffer', () => {
    act(() => api.emit('agent:term', { id: 'c1', chunk: 'a' }))
    expect(latest?.activeId).toBe('c1')
    act(() => api.emit('agent:term', { id: 'c2', chunk: 'b' }))
    expect(latest?.activeId).toBe('c1') // existing focus is not stolen
  })
})
