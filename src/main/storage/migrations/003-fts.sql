-- 003-fts.sql — RAG v1 FTS5 全文索引 (todo39, 本地重排 + FTS5 混合检索)
-- Applied by migrate() after 001/002; idempotent via IF NOT EXISTS (002 precedent).
-- rag_chunks is the single source of truth for chunk text (src/rag/ingest.ts owns
-- writes); rag_chunks_fts is an EXTERNAL-CONTENT fts5 index over it
-- (tokenize='porter unicode61' per plan). BEFORE/AFTER triggers keep the index
-- in sync with every rag_chunks INSERT/UPDATE/DELETE — the ingest transaction
-- never writes the fts table directly.
-- NOTE: 'INSERT OR REPLACE' does NOT fire the DELETE trigger (SQLite quirk),
-- so ingest deletes by chunk id explicitly before re-inserting (ingest.ts).
-- The base rag_chunks DDL is repeated here (IF NOT EXISTS) so a freshly
-- migrated storage DB carries the exact column shape the triggers reference;
-- sqlite-vec keeps its vectors in the parallel vec_rag / vectors tables
-- (Appendix C LLM03/08: FTS and vector namespaces stay separate).

CREATE TABLE IF NOT EXISTS rag_chunks (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding BLOB,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_source ON rag_chunks(source);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_id ON rag_chunks(id);

CREATE VIRTUAL TABLE IF NOT EXISTS rag_chunks_fts USING fts5(
  content,
  source UNINDEXED,
  chunk_index UNINDEXED,
  content='rag_chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_ai AFTER INSERT ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts(rowid, content, source, chunk_index)
  VALUES (new.rowid, new.content, new.source, new.chunk_index);
END;

CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_ad AFTER DELETE ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content, source, chunk_index)
  VALUES ('delete', old.rowid, old.content, old.source, old.chunk_index);
END;

CREATE TRIGGER IF NOT EXISTS rag_chunks_fts_au AFTER UPDATE ON rag_chunks BEGIN
  INSERT INTO rag_chunks_fts(rag_chunks_fts, rowid, content, source, chunk_index)
  VALUES ('delete', old.rowid, old.content, old.source, old.chunk_index);
  INSERT INTO rag_chunks_fts(rowid, content, source, chunk_index)
  VALUES (new.rowid, new.content, new.source, new.chunk_index);
END;
