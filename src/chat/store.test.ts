import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChatStore, parseSseLine, parseSseBuffer, CHAT_COMPLETION_URL } from './store'

// helpers to mock SSE Response
function sseResponse(chunks: string[], status = 200): Response {
  const text = chunks.join('')
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const enc = new TextEncoder()
      // emit in two halves to test buffering
      const half = Math.ceil(text.length / 2)
      ctrl.enqueue(enc.encode(text.slice(0, half)))
      ctrl.enqueue(enc.encode(text.slice(half)))
      ctrl.close()
    },
  })
  return new Response(stream as unknown as BodyInit, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('parseSseLine — delta.content / reasoning_content 透传', () => {
  it('parses OpenAI choices delta.content', () => {
    const l = 'data: {"choices":[{"delta":{"content":"hello"}}]}'
    expect(parseSseLine(l)?.content).toBe('hello')
  })
  it('parses reasoning_content', () => {
    const l = 'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}'
    expect(parseSseLine(l)?.reasoning).toBe('think')
  })
  it('parses reasoning alias', () => {
    const l = 'data: {"choices":[{"delta":{"reasoning":"r2"}}]}'
    expect(parseSseLine(l)?.reasoning).toBe('r2')
  })
  it('parses content+reasoning together', () => {
    const l = 'data: {"choices":[{"delta":{"content":"hi","reasoning_content":"r"}}]}'
    const d = parseSseLine(l)!
    expect(d.content).toBe('hi')
    expect(d.reasoning).toBe('r')
  })
  it('parses llama delta.content', () => {
    expect(parseSseLine('data: {"delta":{"content":"llama"}}')?.content).toBe('llama')
  })
  it('parses llama direct content', () => {
    expect(parseSseLine('data: {"content":"direct","stop":false}')?.content).toBe('direct')
  })
  it('returns done for [DONE]', () => {
    expect(parseSseLine('data: [DONE]')?.done).toBe(true)
  })
  it('returns null for empty/comment', () => {
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine(': keepalive')).toBeNull()
  })
  it('handles finish_reason done', () => {
    expect(parseSseLine('data: {"choices":[{"finish_reason":"stop"}]}')?.done).toBe(true)
  })
})

describe('parseSseBuffer', () => {
  it('splits and carries remainder', () => {
    const { deltas, remainder } = parseSseBuffer('data: {"choices":[{"delta":{"content":"a"}}]}\npartial')
    expect(deltas[0]?.content).toBe('a')
    expect(remainder).toBe('partial')
  })
})

describe('chat store — sessions/messages + SSE + abort/retry', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('create/switch/delete/rename/clear', () => {
    const use = createChatStore()
    const id1 = use.getState().createSession('hello')
    const id2 = use.getState().createSession('world')
    expect(use.getState().sessions.length).toBe(2)
    expect(use.getState().currentId).toBe(id2)
    use.getState().switchSession(id1)
    expect(use.getState().currentId).toBe(id1)
    use.getState().renameSession(id1, 'renamed')
    expect(use.getState().sessions.find((s) => s.id === id1)?.title).toBe('renamed')
    use.getState().deleteSession(id2)
    expect(use.getState().sessions.length).toBe(1)
    // push a msg then clear
    use.getState().sessions[0]!.messages.push({ id: 'x', role: 'user', content: 'hi', createdAt: 1 })
    use.getState().clearCurrentMessages()
    expect(use.getState().sessions[0]!.messages.length).toBe(0)
  })

  it('send streams delta.content + reasoning_content into assistant message', async () => {
    const use = createChatStore()
    use.getState().createSession('t')
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        'data: {"choices":[{"delta":{"content":"lo","reasoning_content":"think"}}]}\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n',
        'data: [DONE]\n',
      ]),
    )
    await use.getState().send('hi', { fetchImpl: fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response> })
    const msgs = use.getState().sessions[0]!.messages
    expect(msgs.length).toBe(2)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.content).toBe('Hello world')
    expect(msgs[1]!.reasoning).toBe('think')
    expect(msgs[1]!.pending).toBe(false)
    expect(use.getState().streaming).toBe(false)
    expect(fetchImpl).toHaveBeenCalled()
    const urlArg = (fetchImpl.mock.calls[0] as unknown as [string])[0] as unknown as string
    expect(urlArg).toBe(CHAT_COMPLETION_URL)
  })

  it('abort cancels streaming and marks aborted', async () => {
    const use = createChatStore()
    use.getState().createSession('a')
    // slow stream
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          const enc = new TextEncoder()
          ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"part"}}]}\n'))
          // wait until aborted
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve()
            else signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          ctrl.close()
        },
      })
      return new Response(stream as unknown as BodyInit, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const p = use.getState().send('hello', { fetchImpl: fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response> })
    // allow first chunk
    await new Promise((r) => setTimeout(r, 20))
    use.getState().abort()
    await p
    const msgs = use.getState().sessions[0]!.messages
    const assistant = msgs[1]!
    expect(assistant.error).toBe('aborted')
    expect(use.getState().streaming).toBe(false)
  })

  it('retry re-sends last user message and appends new assistant', async () => {
    const use = createChatStore()
    use.getState().createSession('r')
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response('oops', { status: 500, statusText: 'err', headers: { 'content-type': 'text/plain' } })
      }
      return sseResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n', 'data: [DONE]\n'])
    })
    await use.getState().send('need retry', { fetchImpl: fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response> })
    expect(use.getState().error).toMatch(/500/)
    expect(use.getState().sessions[0]!.messages.length).toBe(2)
    expect(use.getState().sessions[0]!.messages[1]!.error).toMatch(/500/)

    await use.getState().retry({ fetchImpl: fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response> })
    const msgs = use.getState().sessions[0]!.messages
    // retry removes failed assistant then adds new pair -> total 2 again? actually user+new assistant
    expect(msgs.length).toBe(2)
    expect(msgs[1]!.content).toBe('ok')
    expect(msgs[1]!.error).toBeUndefined()
  })

  it('non-SSE JSON fallback yields single chunk', async () => {
    const use = createChatStore()
    use.getState().createSession('j')
    const fetchImpl = vi.fn(async () => jsonResponse({ content: 'json fallback' }))
    await use.getState().send('hi json', { fetchImpl: fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response> })
    expect(use.getState().sessions[0]!.messages[1]!.content).toBe('json fallback')
  })

  it('ignores empty send and concurrent send guard', async () => {
    const use = createChatStore()
    use.getState().createSession('c')
    await use.getState().send('   ')
    expect(use.getState().sessions[0]!.messages.length).toBe(0)
  })
})
