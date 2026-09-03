/**
 * sessions.test.ts — the IPC-facing state machine: start acks/validation,
 * per-session event fan-out, abort cascade through cancel(), status snapshots,
 * and the honest error settle when the upstream is unreachable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AGENT_SYSTEM_PROMPT, AgentSessions } from './sessions'
import type { AgentEvent, AgentMessage, ToolDef, ToolExecutor } from './types'

const enc = new TextEncoder()

const noTools: ToolExecutor = { list: () => [], execute: async () => null }

function textStream(text: string): ReadableStream<Uint8Array> {
  const chunk = { choices: [{ delta: { content: text }, index: 0 }] }
  const bytes = [enc.encode(`data: ${JSON.stringify(chunk)}\n\n`), enc.encode('data: [DONE]\n\n')]
  let next = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < bytes.length) {
        controller.enqueue(bytes[next])
        next += 1
      } else {
        controller.close()
      }
    }
  })
}

const valid = {
  sessionId: 's1',
  baseUrl: 'http://127.0.0.1:9999',
  model: 'qwen3',
  goal: 'do the thing'
}

function collect(): { events: AgentEvent[]; emit: (e: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, emit: (e) => { events.push(e) } }
}

const settled = async (sessions: AgentSessions, id: string): Promise<void> => {
  for (let i = 0; i < 100 && sessions.status(id).status?.state === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 5))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AgentSessions.start validation', () => {
  it('rejects missing model, non-127.0.0.1, non-http, garbage urls and duplicate ids', () => {
    const { emit } = collect()
    const sessions = new AgentSessions(noTools, emit)
    expect(sessions.start({ ...valid, model: undefined }, emit)).toEqual({ ok: false, error: 'model-not-selected' })
    expect(sessions.start({ ...valid, baseUrl: 'https://127.0.0.1:1' }, emit)).toEqual({ ok: false, error: 'base-url-not-local' })
    expect(sessions.start({ ...valid, baseUrl: 'http://evil.example' }, emit)).toEqual({ ok: false, error: 'base-url-not-local' })
    expect(sessions.start({ ...valid, baseUrl: 'not a url' }, emit)).toEqual({ ok: false, error: 'invalid-base-url' })
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '', body: textStream('x') }) as never)
    expect(sessions.start(valid, emit)).toEqual({ ok: true, sessionId: 's1', started: true })
    expect(sessions.start(valid, emit)).toEqual({ ok: false, error: 'session-already-running' })
  })
})

describe('AgentSessions lifecycle', () => {
  it('happy: system+goal messages reach fetch, events fan out, status settles completed', async () => {
    const requests: { url: string; messages: AgentMessage[] }[] = []
    vi.stubGlobal(
      'fetch',
      async (url: unknown, init?: { body?: string }) => {
        const parsed = JSON.parse(String(init?.body)) as { messages: AgentMessage[] }
        requests.push({ url: String(url), messages: parsed.messages })
        return { ok: true, status: 200, text: async () => '', body: textStream('done!') }
      }
    )
    const { events, emit } = collect()
    const sessions = new AgentSessions(noTools, emit)
    sessions.start(valid, emit)
    await settled(sessions, 's1')

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('http://127.0.0.1:9999/v1/chat/completions')
    expect(requests[0]?.messages[0]).toEqual({ role: 'system', content: AGENT_SYSTEM_PROMPT })
    expect(requests[0]?.messages[1]).toEqual({ role: 'user', content: 'do the thing' })
    expect(events.some((e) => e.type === 'message_delta')).toBe(true)
    expect(events.some((e) => e.type === 'finished' && e.status === 'completed')).toBe(true)
    expect(sessions.status('s1').status).toMatchObject({ state: 'completed', iterations: 1 })
    expect(sessions.active()).toBe(0)
  })

  it('cancel aborts the in-flight stream and settles aborted', async () => {
    let streamCtrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({ start: (c) => { streamCtrl = c } })
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '', body }) as never)
    const { events, emit } = collect()
    const sessions = new AgentSessions(noTools, emit)
    sessions.start(valid, emit)

    streamCtrl?.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"wait"},"index":0}]}\n\n'))
    await new Promise((r) => setTimeout(r, 10))
    expect(sessions.cancel('s1')).toEqual({ ok: true, sessionId: 's1', cancelled: true })
    streamCtrl?.error(new Error('socket closed'))
    await settled(sessions, 's1')

    expect(sessions.status('s1').status).toMatchObject({ state: 'aborted' })
    expect(events.some((e) => e.type === 'finished' && e.status === 'aborted')).toBe(true)
    // cancel of a settled session is honest no-op
    expect(sessions.cancel('s1').cancelled).toBe(false)
    expect(sessions.cancel('ghost').cancelled).toBe(false)
  })

  it('unreachable upstream settles error with a synthesized error event', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    const { events, emit } = collect()
    const sessions = new AgentSessions(noTools, emit)
    sessions.start(valid, emit)
    await settled(sessions, 's1')

    expect(sessions.status('s1').status).toMatchObject({ state: 'error' })
    expect(String(sessions.status('s1').status?.error)).toContain('ECONNREFUSED')
    expect(events.some((e) => e.type === 'error' && e.code === 'upstream-transport')).toBe(true)
  })

  it('status of an unknown session is {ok:true,status:null}', () => {
    const { emit } = collect()
    const sessions = new AgentSessions(noTools, emit)
    expect(sessions.status('nope')).toEqual({ ok: true, status: null })
  })

  it('executor tool defs are advertised to the model', async () => {
    let sawTools: unknown
    const registryExecutor: ToolExecutor = {
      list: () => [{ name: 't', description: 'd', parameters: { type: 'object', additionalProperties: false } }],
      execute: async () => null
    }
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      const parsed = JSON.parse(String(init?.body)) as { tools?: unknown }
      sawTools = parsed.tools
      return { ok: true, status: 200, text: async () => '', body: textStream('ok') }
    })
    const { emit } = collect()
    const sessions = new AgentSessions(registryExecutor, emit)
    sessions.start(valid, emit)
    await settled(sessions, 's1')
    expect(sawTools).toEqual([
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', additionalProperties: false } } }
    ])
  })
})
