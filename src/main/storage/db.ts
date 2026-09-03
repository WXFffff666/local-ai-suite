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

/** Ordered list of migration files applied by migrate(). Keep append-only. */
const MIGRATION_FILES = ['001-init.sql', '002-permissions.sql', '003-fts.sql'] as const

/** Inline fallbacks so the db stays usable if the .sql files are missing from the package. */
const MIGRATION_FALLBACKS: Record<string, string> = {
  '001-init.sql': `
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('user','assistant','system')), content TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, chat_id TEXT, content TEXT NOT NULL, embedding BLOB, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_vectors_chat_id ON vectors(chat_id);
  `,
  '002-permissions.sql': `
    CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('fs.read','fs.write','fs.shell','net','mcp')), rule TEXT NOT NULL, scope TEXT NOT NULL CHECK (scope IN ('session','always')), decision TEXT NOT NULL CHECK (decision IN ('allow','deny','ask')), created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_permissions_kind ON permissions(kind);
    CREATE TABLE IF NOT EXISTS audit_log (ts INTEGER NOT NULL, action TEXT, detail_json TEXT, decision TEXT);
    CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
  '003-fts.sql': `
    CREATE TABLE IF NOT EXISTS rag_chunks (rowid INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, chunk_index INTEGER NOT NULL, embedding BLOB, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_source ON rag_chunks(source);
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_id ON rag_chunks(id);
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(content, source UNINDEXED, chunk_index UNINDEXED, content='rag_chunks', content_rowid='rowid', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_ai AFTER INSERT ON rag_chunks BEGIN INSERT INTO rag_chunks_fts(rowid, content, source, chunk_index) VALUES (new.rowid, new.content, new.source, new.chunk_index); END;
    CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_ad AFTER DELETE ON rag_chunks BEGIN INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content, source, chunk_index) VALUES ('delete', old.rowid, old.content, old.source, old.chunk_index); END;
    CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_au AFTER UPDATE ON rag_chunks BEGIN INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content, source, chunk_index) VALUES ('delete', old.rowid, old.content, old.source, old.chunk_index); INSERT INTO rag_chunks_fts(rowid, content, source, chunk_index) VALUES (new.rowid, new.content, new.source, new.chunk_index); END;
  `,
}

function resolveMigrationSql(fileName: string): string {
  const candidates = [
    // when running from src (ts-node/vitest): src/main/storage/migrations/<file>
    resolve(process.cwd(), `src/main/storage/migrations/${fileName}`),
    // when running from compiled out/main/storage/db.js
    join(__dirname, `migrations/${fileName}`),
    join(__dirname, `../storage/migrations/${fileName}`),
    join(dirname(__dirname), `src/main/storage/migrations/${fileName}`),
    resolve(__dirname, `../../src/main/storage/migrations/${fileName}`),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf-8')
    }
  }
  // fallback: inline schema so db still usable if sql file missing
  return MIGRATION_FALLBACKS[fileName] ?? ''
}

/** Execute all migration SQL files on the given db, in order. Idempotent via IF NOT EXISTS. */
export function migrate(db: Database): void {
  for (const file of MIGRATION_FILES) {
    const sql = resolveMigrationSql(file)
    db.exec(sql)
  }
  reconcileRagFts(db)
}

/**
 * todo39 QA-fail scenario「旧库 FTS5 不可用/落后 → 自动迁移重建索引」: an
 * external-content fts5 index does NOT pick up rows that existed before the
 * table + triggers were created (CREATE VIRTUAL TABLE is empty; triggers only
 * fire on future writes). rag_chunks_fts_docsize counts what is actually
 * indexed; any drift against the base table triggers a one-time 'rebuild'.
 * Best-effort: a db without the fts5 module (theoretical) just skips — the
 * BM25 lane reports itself unavailable and hybrid degrades to the vector lane.
 */
export function reconcileRagFts(db: Database): void {
  try {
    const row = db
      .prepare(
        `SELECT (SELECT count(*) FROM rag_chunks) AS base,
                (SELECT count(*) FROM rag_chunks_fts_docsize) AS indexed`,
      )
      .get() as { base: number; indexed: number }
    if (row.base !== row.indexed) {
      db.prepare(`INSERT INTO rag_chunks_fts(rag_chunks_fts) VALUES('rebuild')`).run()
    }
  } catch {
    // fts5 shadow tables absent / module unavailable — degrade, never brick boot
  }
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
