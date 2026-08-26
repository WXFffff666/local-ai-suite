import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => { throw new Error('mock: no electron in test') }) },
}))

import { DEFAULT_CONFIG, getConfig, setConfig, resetConfig, getConfigPath } from './config'
import { getDb, getChatDbPath, getVecDbPath, closeDb, migrate } from './db'

let tmpDir = ''
let origCwd = ''

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-storage-'))
  origCwd = process.cwd()
  process.chdir(tmpDir)
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

describe('storage — tmp dir 隔离', () => {
  it('config 读写 — getConfig 默认、setConfig 持久化、getConfig 回读', () => {
    // 初始无文件时返回 defaults
    expect(getConfig()).toEqual(DEFAULT_CONFIG)
    expect(existsSync(getConfigPath())).toBe(false)

    // 写入 partial
    const next = setConfig({ theme: 'dark', locale: 'en-US', openaiPort: 9999 })
    expect(next.theme).toBe('dark')
    expect(next.locale).toBe('en-US')
    expect(next.openaiPort).toBe(9999)
    // 未改字段保持默认
    expect(next.modelsDir).toBe(DEFAULT_CONFIG.modelsDir)

    // 磁盘持久化
    expect(existsSync(getConfigPath())).toBe(true)
    const raw = JSON.parse(readFileSync(getConfigPath(), 'utf-8'))
    expect(raw.theme).toBe('dark')
    expect(raw.locale).toBe('en-US')

    // 回读合并
    expect(getConfig().theme).toBe('dark')
    expect(getConfig().locale).toBe('en-US')

    // 再次 set 部分字段，合并语义
    const next2 = setConfig({ theme: 'light' })
    expect(next2.theme).toBe('light')
    expect(next2.locale).toBe('en-US') // 保留上次
    expect(getConfig().theme).toBe('light')

    // reset 回默认
    const reset = resetConfig()
    expect(reset).toEqual(DEFAULT_CONFIG)
    expect(getConfig()).toEqual(DEFAULT_CONFIG)
  })

  it('db 迁移 — migrate 创建 chats/messages/vectors 三表且幂等', () => {
    const db = getDb()
    expect(existsSync(getChatDbPath())).toBe(true)

    // sqlite_master 校验三表存在
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('chats')
    expect(names).toContain('messages')
    expect(names).toContain('vectors')

    // 关键列校验
    const chatCols = db.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>
    expect(chatCols.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'title', 'created_at', 'updated_at']))
    const msgCols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
    expect(msgCols.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'chat_id', 'role', 'content', 'created_at']))
    const vecCols = db.prepare('PRAGMA table_info(vectors)').all() as Array<{ name: string }>
    expect(vecCols.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'content', 'embedding', 'created_at']))

    // 索引存在
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>
    expect(indexes.map((i) => i.name)).toEqual(expect.arrayContaining(['idx_messages_chat_id', 'idx_vectors_chat_id']))

    // 幂等：再次 migrate 不抛错且表仍在
    expect(() => migrate(db)).not.toThrow()
    const tables2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables2.map((t) => t.name)).toEqual(expect.arrayContaining(['chats', 'messages', 'vectors']))

    // 可写入一条数据验证约束
    const now = Date.now()
    db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Test', now, now)
    db.prepare("INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)").run('m1', 'c1', 'hello', now)
    const row = db.prepare('SELECT content FROM messages WHERE id=?').get('m1') as { content: string }
    expect(row.content).toBe('hello')
  })

  it('删除重建 — close 后删除 db 文件，下次 getDb 重建空表', () => {
    const db1 = getDb()
    const chatPath = getChatDbPath()
    const vecPath = getVecDbPath()
    expect(existsSync(chatPath)).toBe(true)

    // 写入数据
    const now = Date.now()
    db1.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c-del', 'ToDelete', now, now)
    expect((db1.prepare('SELECT count(*) as c FROM chats').get() as { c: number }).c).toBe(1)

    // close 后删除文件
    closeDb()
    // better-sqlite3 关闭后需删除主文件及 WAL/SHM（若存在）
    for (const p of [chatPath, chatPath + '-wal', chatPath + '-shm', vecPath, vecPath + '-wal', vecPath + '-shm']) {
      if (existsSync(p)) unlinkSync(p)
    }
    expect(existsSync(chatPath)).toBe(false)

    // 下次 getDb 自动重建，表结构恢复且数据为空
    const db2 = getDb()
    expect(existsSync(chatPath)).toBe(true)
    const tables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['chats', 'messages', 'vectors']))
    expect((db2.prepare('SELECT count(*) as c FROM chats').get() as { c: number }).c).toBe(0)

    // 新库可正常写入
    db2.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c-new', 'New', now, now)
    expect((db2.prepare('SELECT count(*) as c FROM chats').get() as { c: number }).c).toBe(1)
  })
})
