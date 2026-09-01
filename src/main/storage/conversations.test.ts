// Conversation service unit tests (todo17) — real sqlite in a mkdtemp cwd
// (same isolation pattern as storage.test.ts: mock electron, chdir guard).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => { throw new Error('mock: no electron in test') }) },
}))

import { closeDb, getDb } from './db'
import { createConversationService, type ConversationService } from './conversations'
import type { ConversationsProvider } from '../ipc/handlers'

let tmpDir = ''
let origCwd = ''
let service: ConversationService

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-conversations-'))
  origCwd = process.cwd()
  process.chdir(tmpDir)
  service = createConversationService()
})

afterEach(() => {
  try {
    closeDb()
  } catch {}
  try {
    process.chdir(origCwd)
  } catch {}
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe('conversations service — CRUD 往返', () => {
  it('create 默认标题 New Chat，list 返回该会话', async () => {
    const created = await service.create()
    expect(created.title).toBe('New Chat')
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.createdAt).toBe(created.updatedAt)

    const listed = await service.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(created.id)
  })

  it('create 带标题 / rename 更新 title 并推进 updatedAt', async () => {
    const a = await service.create('Alpha')
    expect(a.title).toBe('Alpha')

    const renamed = await service.rename(a.id, 'Alpha renamed')
    expect(renamed).toMatchObject({ id: a.id, title: 'Alpha renamed', createdAt: a.createdAt })
    const listed = await service.list()
    expect(listed[0]?.title).toBe('Alpha renamed')
    expect(listed[0]?.updatedAt).toBeGreaterThanOrEqual(a.updatedAt)
  })

  it('rename/delete/listMessages 对未知 id 诚实报错', async () => {
    await expect(service.rename('missing', 'x')).rejects.toThrow(/not found/)
    await expect(service.listMessages('missing')).rejects.toThrow(/not found/)
    await expect(service.appendMessage('missing', 'user', 'hi')).rejects.toThrow(/not found/)
    await expect(service.delete('missing')).resolves.toBe(false)
  })

  it('rename 空标题被拒绝', async () => {
    const a = await service.create('ok')
    await expect(service.rename(a.id, '   ')).rejects.toThrow(/non-empty/)
  })
})

describe('conversations service — messages 与级联', () => {
  it('appendMessage 往返保序，list 按 updatedAt 倒序', async () => {
    const first = await service.create('first')
    const second = await service.create('second')

    const m1 = await service.appendMessage(first.id, 'user', 'hello')
    const m2 = await service.appendMessage(first.id, 'assistant', 'hi there')
    expect(m1).toMatchObject({ chatId: first.id, role: 'user', content: 'hello' })
    expect(m2.role).toBe('assistant')

    const messages = await service.listMessages(first.id)
    expect(messages.map((m) => m.content)).toEqual(['hello', 'hi there'])

    // list 序不依赖毫秒时序：只验证按 updatedAt 倒序这一不变量 + 集合完整
    const listed = await service.list()
    expect(listed.map((c) => c.id).sort()).toEqual([first.id, second.id].sort())
    const stamps = listed.map((c) => c.updatedAt)
    expect(stamps).toEqual([...stamps].sort((x, y) => y - x))
    // append 触碰过 first → 其 updatedAt 不低于创建时刻
    expect(listed.find((c) => c.id === first.id)?.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
  })

  it('appendMessage 非法 role 被拒绝', async () => {
    const a = await service.create('r')
    await expect(service.appendMessage(a.id, 'tool' as never, 'x')).rejects.toThrow(/invalid role/)
  })

  it('delete 级联删除 messages（含 foreign_keys 未生效场景）', async () => {
    const a = await service.create('cascade')
    await service.appendMessage(a.id, 'user', 'q1')
    await service.appendMessage(a.id, 'assistant', 'a1')

    const deleted = await service.delete(a.id)
    expect(deleted).toBe(true)

    const db = getDb()
    const left = db.prepare('SELECT count(*) AS c FROM messages WHERE chat_id = ?').get(a.id) as { c: number }
    expect(left.c).toBe(0)
    expect(await service.list()).toEqual([])
  })

  it('closeDb 重开后数据仍在（sqlite 持久化，非内存态）', async () => {
    const a = await service.create('persist me')
    await service.appendMessage(a.id, 'user', 'hello db')
    closeDb()

    const reopened = createConversationService()
    const listed = await reopened.list()
    expect(listed.map((c) => c.title)).toEqual(['persist me'])
    const messages = await reopened.listMessages(a.id)
    expect(messages[0]?.content).toBe('hello db')
  })
})

describe('conversations service — IPC seam', () => {
  it('real service structurally satisfies the handlers.ts ConversationsProvider seam', () => {
    const provider: ConversationsProvider = service
    expect(typeof provider.list).toBe('function')
    expect(typeof provider.appendMessage).toBe('function')
  })
})
