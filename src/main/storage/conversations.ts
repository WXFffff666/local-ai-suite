/**
 * conversations.ts — todo17 conversation persistence over chat.db (storage/db.ts).
 *
 * ConversationService is the single owner of the chats/messages tables:
 *   list / create / rename / delete (cascading messages) / appendMessage / listMessages.
 * Every statement is prepared once per connection; the WAL + foreign_keys pragmas
 * are set by openDatabase() in db.ts. Delete removes messages explicitly inside a
 * transaction so the cascade holds even if a connection skipped the FK pragma.
 *
 * Structurally satisfies the ConversationsProvider seam in src/main/ipc/handlers.ts
 * (compile-time assertion lives in conversations.test.ts). The vectors table stays
 * untouched this milestone (RAG = W6-39).
 */
import { randomUUID } from 'crypto'
import { getDb, type Database } from './db'

export type ConversationRole = 'user' | 'assistant' | 'system'

export type Conversation = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export type ConversationMessage = {
  id: string
  chatId: string
  role: ConversationRole
  content: string
  createdAt: number
}

export type ConversationService = {
  list: () => Promise<Conversation[]>
  create: (title?: string) => Promise<Conversation>
  rename: (id: string, title: string) => Promise<Conversation>
  /** true when a row was removed; cascades to the conversation's messages. */
  delete: (id: string) => Promise<boolean>
  /** role stays a plain string at the seam (matches ConversationsProvider);
   *  assertRole narrows it before any SQL runs. */
  appendMessage: (chatId: string, role: string, content: string) => Promise<ConversationMessage>
  listMessages: (chatId: string) => Promise<ConversationMessage[]>
}

const DEFAULT_TITLE = 'New Chat'
const ROLES: readonly ConversationRole[] = ['user', 'assistant', 'system']

type ChatRow = { id: string; title: string; created_at: number; updated_at: number }
type MessageRow = { id: string; chat_id: string; role: string; content: string; created_at: number }

function toConversation(row: ChatRow): Conversation {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at }
}

function toMessage(row: MessageRow): ConversationMessage {
  if (!ROLES.includes(row.role as ConversationRole)) {
    throw new Error(`messages row ${row.id} carries unknown role '${row.role}'`)
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as ConversationRole,
    content: row.content,
    createdAt: row.created_at,
  }
}

function assertId(id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('conversation id required')
}

function assertTitle(title: string): void {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('title must be a non-empty string')
  if (title.length > 512) throw new Error('title too long (max 512)')
}

function assertRole(role: string): asserts role is ConversationRole {
  if (!ROLES.includes(role as ConversationRole)) throw new Error(`invalid role '${role}'`)
}

/** Statements are prepared per connection; a reopened db gets a fresh cache. */
type StatementCache = {
  db: Database
  chatById: (id: string) => ChatRow | undefined
  chatsList: () => ChatRow[]
  chatInsert: (id: string, title: string, now: number) => void
  chatTitle: (id: string, title: string, now: number) => number
  chatTouch: (id: string, now: number) => number
  chatDelete: (id: string) => number
  messageInsert: (id: string, chatId: string, role: string, content: string, now: number) => void
  messagesDelete: (chatId: string) => number
  messagesByChat: (chatId: string) => MessageRow[]
  messageById: (id: string) => MessageRow | undefined
}

function statements(db: Database): StatementCache {
  const chatById = db.prepare('SELECT id, title, created_at, updated_at FROM chats WHERE id = ?')
  const chatsList = db.prepare('SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC, rowid DESC')
  const chatInsert = db.prepare('INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
  const chatTitle = db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?')
  const chatTouch = db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
  const chatDelete = db.prepare('DELETE FROM chats WHERE id = ?')
  const messageInsert = db.prepare(
    'INSERT INTO messages (id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const messagesDelete = db.prepare('DELETE FROM messages WHERE chat_id = ?')
  const messagesByChat = db.prepare(
    'SELECT id, chat_id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC',
  )
  const messageById = db.prepare('SELECT id, chat_id, role, content, created_at FROM messages WHERE id = ?')
  return {
    db,
    chatById: (id) => chatById.get(id) as ChatRow | undefined,
    chatsList: () => chatsList.all() as ChatRow[],
    chatInsert: (id, title, now) => void chatInsert.run(id, title, now, now),
    chatTitle: (id, title, now) => (chatTitle.run(title, now, id).changes ?? 0),
    chatTouch: (id, now) => (chatTouch.run(now, id).changes ?? 0),
    chatDelete: (id) => chatDelete.run(id).changes ?? 0,
    messageInsert: (id, chatId, role, content, now) => void messageInsert.run(id, chatId, role, content, now),
    messagesDelete: (chatId) => messagesDelete.run(chatId).changes ?? 0,
    messagesByChat: (chatId) => messagesByChat.all(chatId) as MessageRow[],
    messageById: (id) => messageById.get(id) as MessageRow | undefined,
  }
}

export function createConversationService(openDb: () => Database = getDb): ConversationService {
  let cache: StatementCache | null = null
  const stmts = (): StatementCache => {
    const db = openDb()
    if (!cache || cache.db !== db) cache = statements(db)
    return cache
  }

  const requireChat = (s: StatementCache, id: string): ChatRow => {
    const row = s.chatById(id)
    if (!row) throw new Error(`conversation not found: ${id}`)
    return row
  }

  return {
    async list() {
      return stmts().chatsList().map(toConversation)
    },

    async create(title) {
      const s = stmts()
      const name = title === undefined || title.trim().length === 0 ? DEFAULT_TITLE : title
      assertTitle(name)
      const id = randomUUID()
      const now = Date.now()
      s.chatInsert(id, name, now)
      return { id, title: name, createdAt: now, updatedAt: now }
    },

    async rename(id, title) {
      assertId(id)
      assertTitle(title)
      const s = stmts()
      const existing = requireChat(s, id)
      const now = Date.now()
      s.chatTitle(id, title, now)
      return { ...toConversation(existing), title, updatedAt: now }
    },

    async delete(id) {
      assertId(id)
      const s = stmts()
      // Explicit cascade in one transaction: safe regardless of the foreign_keys
      // pragma state, and mirrors the ON DELETE CASCADE contract of 001-init.sql.
      const run = s.db.transaction((chatId: string): boolean => {
        s.messagesDelete(chatId)
        return s.chatDelete(chatId) > 0
      })
      return run(id) as boolean
    },

    async appendMessage(chatId, role, content) {
      assertId(chatId)
      assertRole(role)
      if (typeof content !== 'string') throw new Error('content must be a string')
      const s = stmts()
      requireChat(s, chatId)
      const id = randomUUID()
      const now = Date.now()
      const run = s.db.transaction((): void => {
        s.messageInsert(id, chatId, role, content, now)
        s.chatTouch(chatId, now)
      })
      run()
      const row = s.messageById(id)
      if (!row) throw new Error(`message insert lost its row: ${id}`)
      return toMessage(row)
    },

    async listMessages(chatId) {
      assertId(chatId)
      const s = stmts()
      requireChat(s, chatId)
      return s.messagesByChat(chatId).map(toMessage)
    },
  }
}
