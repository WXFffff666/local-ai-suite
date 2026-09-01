/**
 * W1-8 chat relay tests — two-legal-source upstream rule, SSE pump, abort
 * cascade. fetchImpl is injected; no real net, no electron.
 */
import { describe, expect, it, vi } from 'vitest'

import { ChatRelay, type ChatUpstream } from './chatRelay'
import type { ChatSendInput } from './schemas'
import { OLLAMA_PORT } from '../../api/openai'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent, IpcSendFn } from './whitelist'

function payload(overrides: Partial<ChatSendInput> = {}): ChatSendInput {
  return { id: 's1', model: 'qwen3-4b', messages: [{ role: 'user', content: 'ping' }], ...overrides }
}

function sseResponse(chunks: string[], init?: ResponseInit): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    }
  })
  return new Response(stream, {
    ...init,
    headers: { 'content-type': 'text/event-stream', ...(init?.headers ?? {}) }
  })
}

function openAiChunk(content: string | null, done = false): string {
  const chunk = { choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: done ? 'stop' : null }] }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function collector() {
  const deltas: ChatDeltaEvent[] = []
  const dones: ChatDoneEvent[] = []
  const errors: ChatErrorEvent[] = []
  const send: IpcSendFn = (channel, ev) => {
    if (channel === 'chat:delta') deltas.push(ev as ChatDeltaEvent)
    else if (channel === 'chat:done') dones.push(ev as ChatDoneEvent)
    else if (channel === 'chat:error') errors.push(ev as ChatErrorEvent)
  }
  return { send, deltas, dones, errors }
}

function relayFor(opts: {
  upstream?: (url: string, init?: RequestInit) => Promise<Response>
  llamaStatus?: { running: boolean; port: number; state: string }
  ownership?: 'external-takeover' | 'embedded' | undefined
}) {
  const urls: string[] = []
  const ensureSidecar = vi.fn(async () => opts.llamaStatus ?? { running: true, port: 20001, state: 'running' })
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(url))
    if (opts.upstream) return opts.upstream(String(url), init)
    return sseResponse([openAiChunk('he'), openAiChunk('llo'), openAiChunk(null, true), 'data: [DONE]\n\n'])
  })
  const relay = new ChatRelay({
    services: () => ({ ensureSidecar }),
    ...(opts.ownership === undefined ? {} : { getEngineOwnership: () => ({ mode: opts.ownership as 'external-takeover' | 'embedded' }) }),
    fetchImpl: fetchImpl as unknown as typeof globalThis.fetch
  })
  return { relay, urls, ensureSidecar }
}

describe('ChatRelay upstream selection (two legal sources only)', () => {
  it('default: internal llama-server on the RESOLVED dynamic port', async () => {
    const { relay, urls, ensureSidecar } = relayFor({ llamaStatus: { running: true, port: 24567, state: 'running' } })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(c.dones).toHaveLength(1))
    expect(ensureSidecar).toHaveBeenCalledWith('llama')
    expect(urls[0]).toBe(`http://127.0.0.1:24567/v1/chat/completions`)
    // NEVER the facade port unless external-takeover
    expect(urls[0]).not.toContain(`:${OLLAMA_PORT}`)
  })

  it('external-takeover: dials the external engine at 11434 without spawning llama', async () => {
    const { relay, urls, ensureSidecar } = relayFor({ ownership: 'external-takeover' })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(c.dones).toHaveLength(1))
    expect(urls[0]).toBe(`http://127.0.0.1:${OLLAMA_PORT}/v1/chat/completions`)
    expect(ensureSidecar).not.toHaveBeenCalled()
  })

  it('embedded mode still uses the internal llama port (facade is never self-called)', async () => {
    const { relay, urls } = relayFor({ ownership: 'embedded', llamaStatus: { running: true, port: 21111, state: 'running' } })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(c.dones).toHaveLength(1))
    expect(urls[0]).toContain(':21111')
  })

  it('llama unavailable → chat:error, never a silent hang', async () => {
    const { relay } = relayFor({ llamaStatus: { running: false, port: 11435, state: 'failed' } })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(c.errors).toHaveLength(1))
    expect(c.errors[0]?.message).toMatch(/llama-server unavailable/)
  })
})

describe('ChatRelay stream pump', () => {
  it('streams deltas in order then a single chat:done', async () => {
    const { relay } = relayFor({})
    const c = collector()
    const ack = relay.start(payload(), c.send)
    expect(ack).toEqual({ ok: true, id: 's1', streaming: true })
    await vi.waitFor(() => expect(c.dones).toHaveLength(1))
    expect(c.deltas.map((d) => d.delta)).toEqual(['he', 'llo'])
    expect(c.dones[0]).toEqual({ id: 's1', model: 'qwen3-4b' })
    expect(c.errors).toHaveLength(0)
  })

  it('handles SSE frames split across network chunks', async () => {
    const { relay } = relayFor({
      upstream: async () => {
        const head = openAiChunk('part').slice(0, 12)
        const tail = openAiChunk('part').slice(12) + 'data: [DONE]\n\n'
        return sseResponse([head, tail])
      }
    })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(c.dones).toHaveLength(1))
    expect(c.deltas.map((d) => d.delta)).toEqual(['part'])
  })

  it('upstream non-200 → chat:error with status', async () => {
    const { relay } = relayFor({ upstream: async () => new Response('boom', { status: 500 }) })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(c.errors).toHaveLength(1))
    expect(c.errors[0]?.message).toMatch(/500/)
    expect(c.dones).toHaveLength(0)
  })

  it('duplicate session id is rejected with chat:error', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const { relay } = relayFor({
      upstream: async () => {
        await gate
        return sseResponse(['data: [DONE]\n\n'])
      }
    })
    const c = collector()
    relay.start(payload(), c.send)
    relay.start(payload(), c.send)
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]?.message).toMatch(/already running/)
    release()
  })
})

describe('ChatRelay abort', () => {
  it('chat:abort cancels the in-flight upstream fetch and emits chat:done aborted', async () => {
    const { relay } = relayFor({
      upstream: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(init.signal.reason ?? new Error('aborted'))
            return
          }
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true })
        })
    })
    const c = collector()
    relay.start(payload(), c.send)
    await vi.waitFor(() => expect(relay.active()).toBe(1))
    const res = relay.abort({ id: 's1' })
    expect(res).toEqual({ ok: true, id: 's1', aborted: true })
    await vi.waitFor(() => expect(c.dones).toHaveLength(1))
    expect(c.dones[0]).toEqual({ id: 's1', model: 'qwen3-4b', aborted: true })
    expect(relay.active()).toBe(0)
  })

  it('abort of an unknown id reports aborted:false without touching others', () => {
    const { relay } = relayFor({})
    expect(relay.abort({ id: 'ghost' })).toEqual({ ok: true, id: 'ghost', aborted: false })
  })
})

// type-level guard: ChatUpstream stays a two-variant union (todo11 extends behaviour, not sources)
const _variantCheck: ChatUpstream = { kind: 'internal-llama', port: 1 }
void _variantCheck
