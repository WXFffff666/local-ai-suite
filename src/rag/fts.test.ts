/**
 * fts.test.ts — todo39 QA scenarios for the FTS5 migration path:
 *  1. migrate() creates rag_chunks + rag_chunks_fts + keep-in-sync triggers;
 *  2. plain writes through the base table flow into bm25 results via triggers;
 *  3. old-library auto rebuild — a pre-003 rag_chunks full of rows gets its
 *     index rebuilt on the next migrate() (reconcileRagFts), no data loss;
 *  4. re-ingest (delete-first + insert, see RagStore.ingestText) never leaves
 *     stale bm25 hits behind.
 * Lives in src/rag (not src/main/storage) so the CI vitest profile — which
 * excludes native-sensitive storage suites — still runs this lane.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import BetterSqlite3 from 'better-sqlite3'
import { migrate, reconcileRagFts, type Database } from '../main/storage/db'
import { RagStore } from './ingest'

let tmpDir = ''
let db: Database

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-fts-'))
})
afterEach(() => {
  try {
    db?.close()
  } catch {
    /* noop */
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function freshDb(): Database {
  const opened = new BetterSqlite3(join(tmpDir, 'fts.db')) as unknown as Database
  migrate(opened)
  return opened
}

function ftsRowCount(d: Database): number {
  const row = (d as unknown as { prepare: (s: string) => { get: () => { c: number } } })
    .prepare('SELECT count(*) AS c FROM rag_chunks_fts_docsize')
    .get()
  return row.c
}

function prepareAll(d: Database, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  return (d as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => Array<Record<string, unknown>> } })
    .prepare(sql)
    .all(...params)
}

function prepareRun(d: Database, sql: string, params: unknown[]): unknown {
  return (d as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(sql).run(...params)
}

describe('003-fts migration — schema + triggers', () => {
  it('migrate creates rag_chunks / rag_chunks_fts / three sync triggers', () => {
    db = freshDb()
    const names = prepareAll(db, `SELECT name FROM sqlite_master WHERE name LIKE 'rag_chunks%'`).map((r) => String(r['name']))
    expect(names).toContain('rag_chunks')
    expect(names).toContain('rag_chunks_fts')
    expect(names).toContain('rag_chunks_fts_ai')
    expect(names).toContain('rag_chunks_fts_ad')
    expect(names).toContain('rag_chunks_fts_au')
  })

  it('a base-table INSERT is mirrored into fts by the trigger (bm25 queryable)', () => {
    db = freshDb()
    prepareRun(db, 'INSERT INTO rag_chunks (id, content, source, chunk_index, created_at) VALUES (?, ?, ?, ?, ?)', [
      'd#0',
      'sqlite vector extension powers semantic search',
      'd',
      0,
      1,
    ])
    prepareRun(db, 'INSERT INTO rag_chunks (id, content, source, chunk_index, created_at) VALUES (?, ?, ?, ?, ?)', [
      'd#1',
      'bm25 ranks lexical matches',
      'd',
      1,
      1,
    ])
    expect(ftsRowCount(db)).toBe(2)
    const hits = prepareAll(
      db,
      `SELECT c.id FROM rag_chunks_fts JOIN rag_chunks c ON c.rowid = rag_chunks_fts.rowid WHERE rag_chunks_fts MATCH '"vector" OR "bm25"'`,
    ).map((r) => String(r['id']))
    expect(hits.sort()).toEqual(['d#0', 'd#1'])
  })
})

describe('old-library auto index rebuild (QA-fail scenario)', () => {
  it('pre-003 rag_chunks rows become bm25-searchable after migrate', async () => {
    // simulate the OLD database shape: rag_chunks exists, NO fts, rows stored
    const old = new BetterSqlite3(join(tmpDir, 'old.db')) as unknown as Database
    ;(old as unknown as { exec: (s: string) => unknown }).exec(`
      CREATE TABLE rag_chunks (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL, embedding BLOB, created_at INTEGER NOT NULL
      );
      INSERT INTO rag_chunks (id, content, source, chunk_index, created_at)
      VALUES ('legacy#0','hybrid retrieval fuses bm25 with vectors','legacy.pdf',0,1),
             ('legacy#1','the quick brown fox','notes.md',0,1);
    `)
    migrate(old as Database)
    db = old
    // reconcile (runs inside migrate) rebuilt the external-content index
    expect(ftsRowCount(db)).toBe(2)
    const store = new RagStore({ db: old as never })
    const hits = store.bm25Search('bm25 vectors', 5)
    expect(hits.map((h) => h.id)).toEqual(['legacy#0'])
    // future writes still trigger-sync (no double-count after rebuild)
    await store.ingestText('newly added passage about fusion', 'fresh.txt')
    expect(ftsRowCount(db)).toBe(3)
  })

  it('reconcileRagFts is idempotent: no rebuild when already consistent', () => {
    db = freshDb()
    const before = ftsRowCount(db)
    reconcileRagFts(db)
    reconcileRagFts(db)
    expect(ftsRowCount(db)).toBe(before)
  })
})

describe('RagStore x FTS sync (re-ingest consistency)', () => {
  it('delete-first + insert: re-ingesting one chunk id yields one bm25 hit', async () => {
    db = freshDb()
    const store = new RagStore({ db: db as never })
    await store.ingestText('alpha beta gamma', 'doc.txt')
    await store.ingestText('alpha beta gamma UPDATED delta', 'doc.txt')
    expect(store.count()).toBe(1)
    expect(ftsRowCount(db)).toBe(1)
    const hits = store.bm25Search('UPDATED delta', 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.content).toContain('UPDATED')
  })

  it('clear() drains fts through the DELETE trigger', async () => {
    db = freshDb()
    const store = new RagStore({ db: db as never })
    await store.ingestText('one two three', 'a.txt')
    store.clear()
    expect(ftsRowCount(db)).toBe(0)
    expect(store.bm25Search('two', 5)).toEqual([])
  })
})
