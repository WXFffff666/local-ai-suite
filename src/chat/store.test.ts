import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createChatStore,
  parseSseLine,
  parseSseBuffer,
  IPC_UNAVAILABLE_MESSAGE,
  DEFAULT_CHAT_MODEL,
  type ChatIpcApi,
} from './store'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent } from '../main/ipc/whitelist'
import { toWireContent } from './ipc'

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

// ---------------------------------------------------------------------------
// fake window.api — scripted chat:send / chat:abort + delta/done/error events
// ---------------------------------------------------------------------------
function makeFakeApi(opts: { sendAck?: (payload: unknown) => unknown } = {}) {
  const listeners = {
    'chat:delta': [] as Array<(e: ChatDeltaEvent) => void>,
    'chat:done': [] as Array<(e: ChatDoneEvent) => void>,
    'chat:error': [] as Array<(e: ChatErrorEvent) => void>,
  }
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'chat:send') {
      return opts.sendAck ? opts.sendAck(payload) : { ok: true, id: (payload as { id: string }).id, streaming: true }
    }
    return { ok: true, id: (payload as { id: string }).id, aborted: true }
  })
  const on = vi.fn((channel: keyof typeof listeners, cb: (p: never) => void) => {
    const list = listeners[channel] as Array<(p: never) => void>
    list.push(cb)
    return () => {
      const i = list.indexOf(cb)
      if (i >= 0) list.splice(i, 1)
    }
  })
  const emit = {
    delta: (e: ChatDeltaEvent) => listeners['chat:delta'].slice().forEach((cb) => cb(e)),
    done: (e: ChatDoneEvent) => listeners['chat:done'].slice().forEach((cb) => cb(e)),
    error: (e: ChatErrorEvent) => listeners['chat:error'].slice().forEach((cb) => cb(e)),
  }
  const activeListeners = () =>
    listeners['chat:delta'].length + listeners['chat:done'].length + listeners['chat:error'].length
  const api = { invoke, on } as unknown as ChatIpcApi
  return { api, invoke, emit, activeListeners }
}

describe('chat store — IPC relay: send / abort / retry / events', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('send → chat:send invoke + scripted deltas → done locks the message', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('t')
    const done = use.getState().send('hi')

    expect(fake.invoke).toHaveBeenCalledWith(
      'chat:send',
      expect.objectContaining({
        model: DEFAULT_CHAT_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    const streamId = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    const assistant = use.getState().sessions[0]!.messages[1]!
    expect(assistant.id).toBe(streamId) // events keyed by assistant message id
    expect(assistant.pending).toBe(true)
    expect(use.getState().streaming).toBe(true)

    fake.emit.delta({ id: streamId, delta: 'Hel' })
    fake.emit.delta({ id: streamId, delta: 'lo ' })
    fake.emit.delta({ id: streamId, delta: 'world' })
    fake.emit.done({ id: streamId, model: 'local' })
    await done

    const msgs = use.getState().sessions[0]!.messages
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[1]!.content).toBe('Hello world')
    expect(msgs[1]!.pending).toBe(false)
    expect(msgs[1]!.error).toBeUndefined()
    expect(use.getState().streaming).toBe(false)
    expect(use.getState().error).toBeNull()
    expect(fake.activeListeners()).toBe(0) // all event subscriptions torn down
  })

  it('forwards sampling options and ignores events for foreign ids', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('t')
    const done = use.getState().send('hi', { temperature: 0.2, max_tokens: 64, stop: 'END', model: 'qwen3' })
    const payload = (fake.invoke.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(payload).toMatchObject({ model: 'qwen3', temperature: 0.2, max_tokens: 64, stop: 'END' })
    const id = payload.id as string

    fake.emit.delta({ id: 'someone-else', delta: 'NOISE' })
    fake.emit.delta({ id, delta: 'ok' })
    fake.emit.done({ id })
    await done
    expect(use.getState().sessions[0]!.messages[1]!.content).toBe('ok')
  })

  it('reasoning deltas accumulate into message.reasoning, content stays separate (todo11b)', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('r11b')
    const done = use.getState().send('think for me')
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id

    fake.emit.delta({ id, delta: '', reasoning: 'step 1: ' })
    fake.emit.delta({ id, delta: '', reasoning: 'check' })
    fake.emit.delta({ id, delta: 'answer', reasoning: ' + final' })
    fake.emit.delta({ id, delta: ' plain' }) // content-only: reasoning untouched
    fake.emit.done({ id, model: 'local' })
    await done

    const assistant = use.getState().sessions[0]!.messages[1]!
    expect(assistant.content).toBe('answer plain')
    expect(assistant.reasoning).toBe('step 1: check + final')
    expect(assistant.pending).toBe(false)
  })

  it('empty content-only delta is a no-op (no spurious state writes)', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('noop')
    const done = use.getState().send('hi')
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    const before = use.getState().sessions[0]!.messages[1]!
    fake.emit.delta({ id, delta: '' })
    const after = use.getState().sessions[0]!.messages[1]!
    expect(after).toBe(before) // same object reference — store untouched
    fake.emit.done({ id })
    await done
  })

  it('abort → chat:abort invoke + local aborted state; late done{aborted} is a no-op', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('a')
    const done = use.getState().send('hello')
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.delta({ id, delta: 'part' })
    expect(use.getState().streaming).toBe(true)

    use.getState().abort()
    expect(fake.invoke).toHaveBeenCalledWith('chat:abort', { id })
    expect(use.getState().streaming).toBe(false)
    const assistant = use.getState().sessions[0]!.messages[1]!
    expect(assistant.pending).toBe(false)
    expect(assistant.error).toBe('aborted')
    expect(assistant.content).toBe('part') // streamed prefix is preserved

    fake.emit.done({ id, aborted: true }) // late terminal event must not double-apply
    await done
    const after = use.getState().sessions[0]!.messages[1]!
    expect(after.error).toBe('aborted')
    expect(use.getState().streaming).toBe(false)
    expect(fake.activeListeners()).toBe(0)
  })

  it('upstream chat:error → message error, UI not stuck streaming', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('e')
    const done = use.getState().send('boom')
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.delta({ id, delta: 'partial' })
    fake.emit.error({ id, message: 'upstream internal-llama returned 500' })
    await done
    const assistant = use.getState().sessions[0]!.messages[1]!
    expect(assistant.pending).toBe(false)
    expect(assistant.error).toBe('upstream internal-llama returned 500')
    expect(use.getState().error).toBe('upstream internal-llama returned 500')
    expect(use.getState().streaming).toBe(false)
  })

  it('rejected chat:send ack surfaces the validation error', async () => {
    const fake = makeFakeApi({ sendAck: () => ({ ok: false, error: 'invalid-payload', issues: [{ path: 'model', message: 'too big' }] }) })
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('v')
    await use.getState().send('hi')
    const assistant = use.getState().sessions[0]!.messages[1]!
    expect(assistant.pending).toBe(false)
    expect(assistant.error).toMatch(/invalid-payload/)
    expect(use.getState().streaming).toBe(false)
    expect(fake.activeListeners()).toBe(0)
  })

  it('invoke rejection (thrown) surfaces the message without hanging', async () => {
    const use = createChatStore({
      resolveApi: () =>
        ({
          invoke: vi.fn(async () => {
            throw new Error('ipc bridge down')
          }),
          on: vi.fn(() => () => {}),
        }) as unknown as ChatIpcApi,
    })
    use.getState().createSession('x')
    await use.getState().send('hi')
    expect(use.getState().sessions[0]!.messages[1]!.error).toBe('ipc bridge down')
    expect(use.getState().streaming).toBe(false)
  })

  it('no window.api (degraded env) → honest error state, no crash', async () => {
    const use = createChatStore({ resolveApi: () => null })
    use.getState().createSession('d')
    await use.getState().send('hi')
    expect(use.getState().error).toBe(IPC_UNAVAILABLE_MESSAGE)
    expect(use.getState().sessions[0]!.messages[1]!.error).toBe(IPC_UNAVAILABLE_MESSAGE)
    expect(use.getState().streaming).toBe(false)
  })

  it('concurrent sessions keyed by id do not cross-talk', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    const sA = use.getState().createSession('A')
    const pA = use.getState().send('from A')
    const idA = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    const sB = use.getState().createSession('B')
    const pB = use.getState().send('from B')
    const idB = (fake.invoke.mock.calls[1] as unknown as [string, { id: string }])[1].id
    expect(sA).not.toBe(sB)
    expect(use.getState().streaming).toBe(true)

    fake.emit.delta({ id: idB, delta: 'B1' })
    fake.emit.delta({ id: idA, delta: 'A1' })
    fake.emit.delta({ id: idB, delta: 'B2' })

    const msgA = use.getState().sessions.find((s) => s.id === sA)!.messages[1]!
    const msgB = use.getState().sessions.find((s) => s.id === sB)!.messages[1]!
    expect(msgA.content).toBe('A1')
    expect(msgB.content).toBe('B1B2')

    fake.emit.done({ id: idA })
    await pA
    expect(use.getState().streaming).toBe(true) // B still active
    fake.emit.done({ id: idB })
    await pB
    expect(use.getState().streaming).toBe(false)
    expect(fake.activeListeners()).toBe(0)
  })

  it('retry replays last user turn without duplicating it, into a fresh assistant', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('r')
    const first = use.getState().send('need retry')
    const id1 = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.error({ id: id1, message: 'upstream returned 500' })
    await first
    expect(use.getState().error).toMatch(/500/)
    expect(use.getState().sessions[0]!.messages.length).toBe(2)

    const retryDone = use.getState().retry()
    const payload2 = (fake.invoke.mock.calls[1] as unknown as [string, Record<string, unknown>])[1]
    // history = the original user message only (no duplicate, no failed assistant)
    expect(payload2.messages).toEqual([{ role: 'user', content: 'need retry' }])
    const id2 = payload2.id as string
    expect(id2).not.toBe(id1)
    fake.emit.delta({ id: id2, delta: 'ok' })
    fake.emit.done({ id: id2 })
    await retryDone

    const msgs = use.getState().sessions[0]!.messages
    expect(msgs.length).toBe(2)
    expect(msgs[1]!.content).toBe('ok')
    expect(msgs[1]!.error).toBeUndefined()
    expect(msgs[1]!.pending).toBe(false)
  })

  it('ignores empty send and first-send title seeding', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('c')
    await use.getState().send('   ')
    expect(fake.invoke).not.toHaveBeenCalled()
    expect(use.getState().sessions[0]!.messages.length).toBe(0)

    const p = use.getState().send('hello there world, this is a fairly long opener')
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.done({ id })
    await p
    expect(use.getState().sessions[0]!.title).toBe('hello there world, this is a fairly long opener'.slice(0, 32))
  })

  it('send auto-creates a session when none exists', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    const p = use.getState().send('first')
    expect(use.getState().sessions.length).toBe(1)
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.done({ id })
    await p
    expect(use.getState().sessions[0]!.messages[1]!.pending).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// todo21: VLM 贴图（images 为 ADDITIVE 字段；无图消息保持旧线格式）
// ---------------------------------------------------------------------------

describe('chat store — todo21 image attachments', () => {
  const uri1 = 'data:image/png;base64,iVBORw0KGgo='
  const uri2 = 'data:image/jpeg;base64,/9j/4AAQSkZ='

  function lastSendMessages(fake: ReturnType<typeof makeFakeApi>) {
    const calls = fake.invoke.mock.calls.filter((c) => c[0] === 'chat:send')
    return (calls[calls.length - 1]![1] as { messages: unknown }).messages
  }

  it('toWireContent: 无图消息逐字节等价旧 {role,content:string} 线格式（基线 pin）', () => {
    const m = { id: 'u1', role: 'user' as const, content: 'hi', createdAt: 1 }
    expect(toWireContent(m)).toBe('hi')
  })

  it('send(text, _, images) → invoke payload content = [text, image_url...]，消息保留 images', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('t')
    const p = use.getState().send('看图', undefined, [uri1, uri2])
    expect(lastSendMessages(fake)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: uri1 } },
          { type: 'image_url', image_url: { url: uri2 } },
        ],
      },
    ])
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.done({ id })
    await p
    expect(use.getState().sessions[0]!.messages[0]!.images).toEqual([uri1, uri2])
  })

  it('image-only send（无文字）合法；空文本且无图仍被忽略', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('t')
    const p = use.getState().send('', undefined, [uri1])
    expect(lastSendMessages(fake)).toEqual([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: uri1 } }] },
    ])
    const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.done({ id })
    await p
    await use.getState().send('   ')
    expect(fake.invoke).toHaveBeenCalledTimes(1)
  })

  it('>2 张截断至 2（plan cap）', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('t')
    await (async () => {
      const p = use.getState().send('three', undefined, [uri1, uri2, uri1])
      const id = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
      fake.emit.done({ id })
      await p
    })()
    const content = (lastSendMessages(fake) as Array<{ content: unknown }>)[0]!.content as Array<{ type: string }>
    expect(content.filter((c) => c.type === 'image_url')).toHaveLength(2)
  })

  it('多轮历史：先前用户消息的贴图以 parts 形式随行，assistant 保持 string', async () => {
    const fake = makeFakeApi()
    const use = createChatStore({ resolveApi: () => fake.api })
    use.getState().createSession('t')
    const p1 = use.getState().send('第一轮带图', undefined, [uri1])
    const id1 = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.delta({ id: id1, delta: '收到' })
    fake.emit.done({ id: id1 })
    await p1

    const p2 = use.getState().send('第二轮纯文本')
    const msgs = (lastSendMessages(fake) as Array<{ role: string; content: unknown }>)
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '第一轮带图' },
        { type: 'image_url', image_url: { url: uri1 } },
      ],
    })
    expect(msgs[1]).toEqual({ role: 'assistant', content: '收到' })
    expect(msgs[2]).toEqual({ role: 'user', content: '第二轮纯文本' })
    const id2 = (fake.invoke.mock.calls[1] as unknown as [string, { id: string }])[1].id
    fake.emit.done({ id: id2 })
    await p2
  })
})
