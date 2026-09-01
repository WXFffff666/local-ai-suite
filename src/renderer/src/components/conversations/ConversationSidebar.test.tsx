// @vitest-environment jsdom
/**
 * ConversationSidebar.test.tsx — todo17 侧栏 jsdom 测试（fake window.api）。
 * 覆盖：mount list+空则 create+自动选中；点选加载消息进 store；新建按钮；
 *       删除走 dialog:confirmDestructive（Cancel 零副作用 / Confirm 级联删）；
 *       行内重命名提交；主进程拒绝 → 诚实错误横幅；无 window.api → 降级提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ConversationSidebar from './ConversationSidebar'
import { deleteConversationGuarded } from './deleteConversation'
import { useChatStore } from '../../../../chat/store'
import type { ConversationMeta } from './api'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type FakeDb = {
  chats: ConversationMeta[]
  messages: Map<string, Array<{ id: string; chatId: string; role: string; content: string; createdAt: number }>>
}

function makeFakeApi(db: FakeDb, opts: { confirm?: boolean } = {}) {
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    const body = (payload ?? {}) as Record<string, unknown>
    if (channel === 'conversations:list') return { ok: true, conversations: db.chats.map((c) => ({ ...c })) }
    if (channel === 'conversations:create') {
      const now = Date.now()
      const conv: ConversationMeta = {
        id: `chat-${db.chats.length + 1}`,
        title: typeof body.title === 'string' ? body.title : 'New Chat',
        createdAt: now,
        updatedAt: now
      }
      db.chats.unshift(conv)
      return { ok: true, conversation: { ...conv } }
    }
    if (channel === 'conversations:rename') {
      const c = db.chats.find((x) => x.id === body.id)
      if (!c) return { ok: false, error: 'conversation not found' }
      c.title = String(body.title)
      c.updatedAt = Date.now()
      return { ok: true, conversation: { ...c } }
    }
    if (channel === 'conversations:delete') {
      const i = db.chats.findIndex((x) => x.id === body.id)
      if (i < 0) return { ok: true, deleted: false }
      db.chats.splice(i, 1)
      db.messages.delete(String(body.id))
      return { ok: true, deleted: true }
    }
    if (channel === 'conversations:listMessages') {
      return { ok: true, messages: (db.messages.get(String(body.chatId)) ?? []).map((m) => ({ ...m })) }
    }
    if (channel === 'dialog:confirmDestructive') return (opts.confirm ?? false) === true
    return { ok: false, error: `unexpected channel ${channel}` }
  })
  return { api: { invoke }, invoke }
}

function chat(id: string, title: string): ConversationMeta {
  const now = Date.now()
  return { id, title, createdAt: now, updatedAt: now }
}

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = <ConversationSidebar />
  await act(async () => {
    root.render(tree)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function setApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

function itemButtons(title: string, ariaSuffix: 'rename' | 'delete'): HTMLButtonElement | undefined {
  const aside = container.querySelector('aside[aria-label="conversations"]') as HTMLElement
  const item = Array.from(aside.querySelectorAll('div')).find((d) => d.textContent?.includes(title))
  return Array.from(item?.querySelectorAll('button') ?? []).find((b) =>
    b.getAttribute('aria-label')?.startsWith(ariaSuffix)
  ) as HTMLButtonElement | undefined
}

beforeEach(() => {
  setApi(undefined)
  useChatStore.setState({
    sessions: [],
    currentId: null,
    streaming: false,
    error: null,
    activeConversationId: null
  })
})

afterEach(() => {
  unmount()
  setApi(undefined)
  vi.restoreAllMocks()
})

describe('ConversationSidebar mount 流程', () => {
  it('空库 → create-if-empty 并自动选中（store 桥接 activeConversationId）', async () => {
    const db: FakeDb = { chats: [], messages: new Map() }
    const { api, invoke } = makeFakeApi(db)
    setApi(api)
    await mount()

    expect(invoke).toHaveBeenCalledWith('conversations:create', expect.anything())
    const st = useChatStore.getState()
    expect(st.activeConversationId).toBe('chat-1')
    expect(st.currentId).toBe('chat-1')
    expect(container.textContent).toContain('New Chat')
  })

  it('已有会话 → 渲染列表、选中首个并加载其消息', async () => {
    const db: FakeDb = {
      chats: [chat('a', '会话甲'), chat('b', '会话乙')],
      messages: new Map([
        ['a', [{ id: 'm1', chatId: 'a', role: 'user', content: '你好甲', createdAt: 1 }]],
        ['b', [{ id: 'm2', chatId: 'b', role: 'assistant', content: '乙的回答', createdAt: 2 }]]
      ])
    }
    const { api, invoke } = makeFakeApi(db)
    setApi(api)
    await mount()

    expect(container.textContent).toContain('会话甲')
    expect(container.textContent).toContain('会话乙')
    expect(useChatStore.getState().activeConversationId).toBe('a')
    const sess = useChatStore.getState().sessions.find((s) => s.id === 'a')
    expect(sess?.messages.map((m) => m.content)).toEqual(['你好甲'])

    // 点选第二个 → listMessages 加载进 store
    const aside = container.querySelector('aside[aria-label="conversations"]') as HTMLElement
    const itemB = Array.from(aside.querySelectorAll('div')).find((d) => d.textContent?.includes('会话乙'))!
    await act(async () => {
      itemB.click()
    })
    expect(invoke).toHaveBeenCalledWith('conversations:listMessages', { chatId: 'b' })
    expect(useChatStore.getState().currentId).toBe('b')
    expect(useChatStore.getState().sessions.find((s) => s.id === 'b')?.messages[0]?.content).toBe('乙的回答')
  })

  it('主进程拒绝（ok:false）→ 诚实错误横幅', async () => {
    setApi({
      invoke: vi.fn(async () => ({ ok: false, error: 'not-ready' }))
    })
    await mount()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('not-ready')
  })

  it('无 window.api → 降级提示，不抛错', async () => {
    setApi(undefined)
    await mount()
    expect(container.textContent).toContain('window.api 不可用')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})

describe('ConversationSidebar 动作', () => {
  it('新建按钮 → conversations:create 并切换 active', async () => {
    const db: FakeDb = { chats: [chat('a', '旧会话')], messages: new Map() }
    const { api, invoke } = makeFakeApi(db)
    setApi(api)
    await mount()
    invoke.mockClear()

    const newBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('新会话'))!
    await act(async () => {
      newBtn.click()
    })
    expect(invoke).toHaveBeenCalledWith('conversations:create', {})
    expect(useChatStore.getState().activeConversationId).toBe('chat-2')
  })

  it('删除 Cancel → conversations:delete 不被调用（零副作用）', async () => {
    const db: FakeDb = { chats: [chat('a', '甲'), chat('b', '乙')], messages: new Map() }
    const { api, invoke } = makeFakeApi(db, { confirm: false })
    setApi(api)
    await mount()
    invoke.mockClear()

    const del = itemButtons('甲', 'delete')!
    await act(async () => {
      del.click()
    })
    expect(invoke).toHaveBeenCalledWith('dialog:confirmDestructive', expect.objectContaining({ message: expect.stringContaining('甲') }))
    expect(invoke).not.toHaveBeenCalledWith('conversations:delete', expect.anything())
    expect(container.textContent).toContain('甲')
  })

  it('删除 Confirm → conversations:delete 级联 + 选中回落到下一个', async () => {
    const db: FakeDb = { chats: [chat('a', '甲'), chat('b', '乙')], messages: new Map() }
    const { api, invoke } = makeFakeApi(db, { confirm: true })
    setApi(api)
    await mount()
    invoke.mockClear()

    const del = itemButtons('甲', 'delete')!
    await act(async () => {
      del.click()
    })
    expect(invoke).toHaveBeenCalledWith('conversations:delete', { id: 'a' })
    expect(container.textContent).not.toContain('甲')
    expect(useChatStore.getState().activeConversationId).toBe('b')
  })

  it('行内重命名 → Enter 提交 conversations:rename 并同步 store 标题', async () => {
    const db: FakeDb = { chats: [chat('a', '旧名'), chat('b', '乙')], messages: new Map() }
    const { api, invoke } = makeFakeApi(db)
    setApi(api)
    await mount()
    invoke.mockClear()

    const ren = itemButtons('旧名', 'rename')!
    act(() => {
      ren.click()
    })
    const input = container.querySelector('input[aria-label="rename-input"]') as HTMLInputElement
    expect(input).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '新名')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(invoke).toHaveBeenCalledWith('conversations:rename', { id: 'a', title: '新名' })
    expect(container.textContent).toContain('新名')
    expect(useChatStore.getState().sessions.find((s) => s.id === 'a')?.title).toBe('新名')
  })
})

describe('deleteConversationGuarded — deleteWorkspace 同款双重校验', () => {
  it('Cancel 不删；Confirm 删除并返回 true', async () => {
    const db: FakeDb = { chats: [chat('x', '目标')], messages: new Map() }
    const cancel = makeFakeApi(db, { confirm: false })
    const r1 = await deleteConversationGuarded({ conversationId: 'x', conversationTitle: '目标' }, { invoke: cancel.api.invoke })
    expect(r1).toBe(false)
    expect(cancel.invoke).not.toHaveBeenCalledWith('conversations:delete', expect.anything())
    expect(db.chats).toHaveLength(1)

    const ok = makeFakeApi(db, { confirm: true })
    const r2 = await deleteConversationGuarded({ conversationId: 'x' }, { invoke: ok.api.invoke })
    expect(r2).toBe(true)
    expect(ok.invoke).toHaveBeenCalledWith('conversations:delete', { id: 'x' })
    expect(db.chats).toHaveLength(0)
  })

  it('空 id 直接拒绝', async () => {
    const db: FakeDb = { chats: [], messages: new Map() }
    const { api } = makeFakeApi(db, { confirm: true })
    await expect(deleteConversationGuarded({ conversationId: '  ' }, { invoke: api.invoke })).rejects.toThrow(/conversationId required/)
  })
})
