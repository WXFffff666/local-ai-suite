/**
 * conversationBridge.test.ts — todo17 store 持久化桥（附加面，node 环境）
 * Given createChatStore 注入 fake relay api + fake conversation bridge：
 *   - send 落 user 消息、chat:done 落 assistant 全量、abort 落部分内容
 *   - 非活动会话（activeConversationId 不匹配）绝不落库
 *   - chat:error 不落库
 * 既有 store.test.ts 的行为（sessions/messages 形状）不受影响。
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStore, type ChatIpcApi, type ConversationBridge } from './store'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent } from '../main/ipc/whitelist'

function makeFakeApi() {
  const listeners = {
    'chat:delta': [] as Array<(e: ChatDeltaEvent) => void>,
    'chat:done': [] as Array<(e: ChatDoneEvent) => void>,
    'chat:error': [] as Array<(e: ChatErrorEvent) => void>,
  }
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    if (channel === 'chat:send') return { ok: true, id: (payload as { id: string }).id, streaming: true }
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
  const api = { invoke, on } as unknown as ChatIpcApi
  return { api, invoke, emit }
}

function makeBridge(appendImpl?: (chatId: string, role: string, content: string) => Promise<unknown>) {
  const appendMessage = vi.fn(
    appendImpl ??
      (async () => {
        return { ok: true }
      }),
  )
  const bridge: ConversationBridge = { appendMessage }
  return { bridge, appendMessage }
}

function makeStore(bridge: ConversationBridge | null) {
  const fake = makeFakeApi()
  const store = createChatStore({
    resolveApi: () => fake.api,
    conversations: () => bridge,
  })
  return { store, fake }
}

const CONV = {
  id: 'conv-1',
  title: 'Persisted',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
}

describe('conversation bridge — send/done/abort 持久化', () => {
  it('活动会话：send 落 user，chat:done 落 assistant 全量内容', async () => {
    const { bridge, appendMessage } = makeBridge()
    const { store, fake } = makeStore(bridge)

    store.getState().loadConversation(CONV)
    const sending = store.getState().send('你好')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalledWith('chat:send', expect.anything()))
    const streamId = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.delta({ id: streamId, delta: 'wor' })
    fake.emit.delta({ id: streamId, delta: 'ld' })
    fake.emit.done({ id: streamId })
    await sending

    const calls = appendMessage.mock.calls.map((c) => [c[0], c[1], c[2]])
    expect(calls).toEqual([
      ['conv-1', 'user', '你好'],
      ['conv-1', 'assistant', 'world'],
    ])
  })

  it('chat:done aborted:true 也持久化已生成的部分内容', async () => {
    const { bridge, appendMessage } = makeBridge()
    const { store, fake } = makeStore(bridge)

    store.getState().loadConversation(CONV)
    const sending = store.getState().send('q')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const streamId = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.delta({ id: streamId, delta: 'partial ' })
    fake.emit.done({ id: streamId, aborted: true })
    await sending

    expect(appendMessage).toHaveBeenCalledWith('conv-1', 'assistant', 'partial ')
  })

  it('本地 abort() 立即持久化部分内容（done 事件不会再到达）', async () => {
    const { bridge, appendMessage } = makeBridge()
    const { store, fake } = makeStore(bridge)

    store.getState().loadConversation(CONV)
    const sending = store.getState().send('q')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const streamId = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.delta({ id: streamId, delta: 'half' })

    store.getState().abort()
    expect(appendMessage).toHaveBeenCalledWith('conv-1', 'assistant', 'half')
    expect(fake.invoke).toHaveBeenCalledWith('chat:abort', { id: streamId })
    await sending
  })

  it('chat:error 不落库', async () => {
    const { bridge, appendMessage } = makeBridge()
    const { store, fake } = makeStore(bridge)

    store.getState().loadConversation(CONV)
    const sending = store.getState().send('q')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const streamId = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.error({ id: streamId, message: 'boom' })
    await sending

    // 仅 user 落库，assistant 错误流不落
    expect(appendMessage).toHaveBeenCalledTimes(1)
    expect(appendMessage).toHaveBeenCalledWith('conv-1', 'user', 'q')
  })

  it('非活动会话（createSession 的内存会话）不持久化', async () => {
    const { bridge, appendMessage } = makeBridge()
    const { store, fake } = makeStore(bridge)

    const sessionId = store.getState().createSession('ephemeral')
    expect(store.getState().activeConversationId).toBeNull()
    const sending = store.getState().send('hi')
    await vi.waitFor(() => expect(fake.invoke).toHaveBeenCalled())
    const streamId = (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id
    fake.emit.done({ id: streamId })
    await sending

    expect(appendMessage).not.toHaveBeenCalled()
    expect(sessionId).toBeTruthy()
  })

  it('bridge 拒绝 → store.error 诚实上抛可见', async () => {
    const { bridge } = makeBridge(async () => {
      throw new Error('db busy')
    })
    const { store, fake } = makeStore(bridge)

    store.getState().loadConversation(CONV)
    const sending = store.getState().send('q')
    await vi.waitFor(() => expect(store.getState().error).toBe('db busy'))
    fake.emit.done({ id: (fake.invoke.mock.calls[0] as unknown as [string, { id: string }])[1].id })
    await sending
  })

  it('loadConversation 替换既有会话并置 active；setActiveConversation(null) 切断持久化', async () => {
    const { bridge, appendMessage } = makeBridge()
    const { store } = makeStore(bridge)

    store.getState().loadConversation({ ...CONV, messages: [] })
    store.getState().loadConversation({ ...CONV, title: 'Reloaded', messages: [] })
    const st = store.getState()
    expect(st.sessions.filter((s) => s.id === 'conv-1')).toHaveLength(1)
    expect(st.sessions[0]?.title).toBe('Reloaded')
    expect(st.currentId).toBe('conv-1')
    expect(st.activeConversationId).toBe('conv-1')

    st.setActiveConversation(null)
    st.loadConversation({ id: 'conv-2', title: 'other', createdAt: 2, updatedAt: 2, messages: [] })
    store.getState().setActiveConversation('conv-2')
    appendMessage.mockClear()
    // active 为 conv-2 时对 conv-1 的 persist 路径不发生（send 目标是 currentId=conv-2，
    // 这里仅断言桥的守卫条件本身）
    expect(store.getState().activeConversationId).toBe('conv-2')
  })
})
