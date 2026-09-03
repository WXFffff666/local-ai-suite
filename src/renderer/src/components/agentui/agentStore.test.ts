// @vitest-environment jsdom
/**
 * agentStore.test.ts — todo29 slice behavior with a fake window.api:
 * per-session mode map, startRun → agent:start (placeholder baseUrl/model,
 * fresh agent session id), event routing through reduceTimeline, stopRun →
 * agent:cancel + stopping phase, ack failures surface as error cards, and
 * outside-Electron honest degradation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent } from '../../../../agent/runner/types'
import type { AgentStartReply } from '../../../../main/ipc/whitelist'
import { createAgentStore, type AgentApi } from './agentStore'

type Listener = (e: AgentEvent) => void

function fakeApi(opts: { startReply?: AgentStartReply } = {}) {
  const byChannel = new Map<string, Listener[]>()
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'agent:start') {
      return opts.startReply ?? { ok: true, sessionId: (payload as { sessionId: string }).sessionId, started: true }
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
  const api = { invoke, on } as unknown as AgentApi
  return { api, invoke, emit }
}

const delta = (sessionId: string, text: string): AgentEvent => ({ type: 'message_delta', sessionId, delta: text })

beforeEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('mode map', () => {
  it('defaults to chat and persists per session key', () => {
    const store = createAgentStore()
    expect(store.getState().modes['s-a'] ?? 'chat').toBe('chat')
    store.getState().setMode('s-a', 'agent')
    store.getState().setMode('s-b', 'chat')
    expect(store.getState().modes['s-a']).toBe('agent')
    expect(store.getState().modes['s-b']).toBe('chat')
    expect(store.getState().modeFor('s-a')).toBe('agent')
    expect(store.getState().modeFor('never-set')).toBe('chat')
  })
})

describe('run lifecycle', () => {
  it('startRun invokes agent:start and folds events for the active session only', async () => {
    const f = fakeApi()
    const store = createAgentStore({ resolveApi: () => f.api })
    await store.getState().startRun('s-a', '  fix the build  ')
    const call = f.invoke.mock.calls.find((c) => c[0] === 'agent:start')
    expect(call).toBeDefined()
    const payload = call?.[1] as { sessionId: string; baseUrl: string; model: string; goal: string }
    expect(payload.baseUrl).toBe('http://127.0.0.1:11434')
    expect(payload.model).toBe('local')
    expect(payload.goal).toBe('fix the build')
    const sessionId = payload.sessionId

    f.emit(delta(sessionId, 'hal'))
    f.emit(delta('other-session', 'ignored'))
    f.emit(delta(sessionId, 'lo'))
    f.emit({ type: 'finished', sessionId, status: 'completed', iterations: 2, text: 'hallo' })
    const run = store.getState().runs['s-a']
    expect(run?.phase).toBe('completed')
    expect(run?.cards).toEqual([{ kind: 'answer', text: 'hallo', final: true }])
  })

  it('stopRun flips to stopping and invokes agent:cancel for the session id', async () => {
    const f = fakeApi()
    const store = createAgentStore({ resolveApi: () => f.api })
    await store.getState().startRun('s-a', 'go')
    const sessionId = store.getState().sessionIds['s-a']
    await store.getState().stopRun('s-a')
    expect(store.getState().runs['s-a']?.phase).toBe('stopping')
    expect(f.invoke).toHaveBeenCalledWith('agent:cancel', { sessionId })
    f.emit({ type: 'finished', sessionId: sessionId!, status: 'aborted', iterations: 1, text: '' })
    expect(store.getState().runs['s-a']?.phase).toBe('aborted')
    expect(store.getState().runPhase('s-a')).toBe('aborted')
  })

  it('failed ack and missing IPC both land as visible error cards', async () => {
    const f = fakeApi({ startReply: { ok: false, error: 'model-not-selected' } })
    const store = createAgentStore({ resolveApi: () => f.api })
    await store.getState().startRun('s-a', 'go')
    expect(store.getState().runs['s-a']?.phase).toBe('error')
    expect(store.getState().runs['s-a']?.cards[0]?.kind).toBe('error')

    const offline = createAgentStore({ resolveApi: () => null })
    await offline.getState().startRun('s-b', 'go')
    expect(offline.getState().runs['s-b']?.phase).toBe('error')
    const card = offline.getState().runs['s-b']?.cards[0]
    expect(card?.kind === 'error' && card.message).toContain('IPC 不可用')
  })

  it('empty goals never reach the IPC surface', async () => {
    const f = fakeApi()
    const store = createAgentStore({ resolveApi: () => f.api })
    await store.getState().startRun('s-a', '   ')
    expect(f.invoke).not.toHaveBeenCalled()
  })

  it('a second run replaces the first and stale events from the old session are ignored', async () => {
    const f = fakeApi()
    const store = createAgentStore({ resolveApi: () => f.api })
    await store.getState().startRun('s-a', 'first')
    const oldId = store.getState().sessionIds['s-a']
    await store.getState().startRun('s-a', 'second')
    const newId = store.getState().sessionIds['s-a']
    expect(newId).not.toBe(oldId)
    f.emit(delta(oldId!, 'stale'))
    expect(store.getState().runs['s-a']?.cards).toHaveLength(0)
    f.emit(delta(newId!, 'fresh'))
    expect(store.getState().runs['s-a']?.cards).toEqual([{ kind: 'answer', text: 'fresh', final: false }])
  })
})
