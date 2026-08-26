import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

export type Database = BetterSqlite3Database

let chatDb: Database | null = null
let vecDb: Database | null = null
let vecAvailable = false

function getElectronUserData(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath: (n: string) => string } }
    const maybeApp = electron?.app
    if (maybeApp && typeof maybeApp.getPath === 'function') {
      try {
        const p = maybeApp.getPath('userData')
        if (p) return p
      } catch {
        // app not ready
      }
    }
  } catch {
    // electron not available (vitest / build)
  }
  return null
}

export function getDbDir(): string {
  const userData = getElectronUserData()
  if (userData) return userData
  return join(process.cwd(), 'userData')
}

export function getChatDbPath(): string {
  return join(getDbDir(), 'chat.db')
}

export function getVecDbPath(): string {
  return join(getDbDir(), 'vec.db')
}

function ensureDbDir(): void {
  const dir = getDbDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function resolveMigrationSql(): string {
  const candidates = [
    // when running from src (ts-node/vitest): src/main/storage/migrations/001-init.sql
    resolve(process.cwd(), 'src/main/storage/migrations/001-init.sql'),
    // when running from compiled out/main/storage/db.js
    join(__dirname, 'migrations/001-init.sql'),
    join(__dirname, '../storage/migrations/001-init.sql'),
    join(dirname(__dirname), 'src/main/storage/migrations/001-init.sql'),
    resolve(__dirname, '../../src/main/storage/migrations/001-init.sql'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8')
    }
  }
  // fallback: inline minimal schema so db still usable if sql file missing
  return `
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user','assistant','system')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, chat_id TEXT, content TEXT NOT NULL, embedding BLOB, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_vectors_chat_id ON vectors(chat_id);
  `
}

/** Execute migration SQL on the given db. Idempotent via IF NOT EXISTS. */
export function migrate(db: Database): void {
  const sql = resolveMigrationSql()
  db.exec(sql)
}

function tryLoadVecExtension(db: Database): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vec = require('sqlite-vec') as { load: (db: { loadExtension: (p: string, entry?: string) => void }) => void }
    if (vec && typeof vec.load === 'function') {
      vec.load(db as unknown as { loadExtension: (p: string, entry?: string) => void })
      return true
    }
  } catch {
    // sqlite-vec not installed / platform unsupported / extension load failed -> fallback
  }
  return false
}

function openDatabase(filePath: string, withVec: boolean): Database {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as unknown as new (
    path: string,
    opts?: Record<string, unknown>,
  ) => Database

  ensureDbDir()
  const db = new BetterSqlite3(filePath)
  // Pragmas for durability / concurrency
  try {
    db.pragma('journal_mode = WAL')
  } catch {
    // ignore
  }
  try {
    db.pragma('busy_timeout = 5000')
  } catch {
    // ignore
  }
  try {
    db.pragma('foreign_keys = ON')
  } catch {
    // ignore
  }

  if (withVec) {
    const ok = tryLoadVecExtension(db)
    vecAvailable = ok
  }

  migrate(db)
  return db
}

/** Singleton: main chat DB (chat.db). Re-creates if file was deleted or connection closed. */
export function getDb(): Database {
  const needsReopen =
    !chatDb ||
    // better-sqlite3 exposes .open boolean
    !(chatDb as unknown as { open: boolean }).open
  if (needsReopen) {
    // close stale handle if any
    try {
      if (chatDb) (chatDb as unknown as { close: () => void }).close()
    } catch {
      // ignore
    }
    chatDb = openDatabase(getChatDbPath(), false)
  }
  return chatDb as Database
}

/** Singleton: vector DB (vec.db). Returns null if sqlite-vec unavailable and fallback-disabled? Here returns a plain DB without vector extension so callers can still run. */
export function getVecDb(): Database | null {
  const needsReopen =
    !vecDb || !(vecDb as unknown as { open: boolean }).open
  if (needsReopen) {
    try {
      if (vecDb) (vecDb as unknown as { close: () => void }).close()
    } catch {
      // ignore
    }
    try {
      vecDb = openDatabase(getVecDbPath(), true)
    } catch {
      // if vec.db open fails, fallback to null but chat.db still works
      vecDb = null
      return null
    }
  }
  return vecDb
}

/** Convenience: both DBs. */
export function getDbs(): { chat: Database; vec: Database | null } {
  return { chat: getDb(), vec: getVecDb() }
}

export function isVecAvailable(): boolean {
  return vecAvailable
}

/** Close all DB handles — useful for tests and app quit. After close, next getDb() will rebuild. */
export function closeDb(): void {
  for (const db of [chatDb, vecDb] as unknown as Array<{ close: () => void; open: boolean } | null>) {
    if (db && db.open) {
      try {
        db.close()
      } catch {
        // ignore
      }
    }
  }
  chatDb = null
  vecDb = null
}
