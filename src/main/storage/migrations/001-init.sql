-- 001-init.sql — initial schema for chats / messages / vectors
-- chat.db holds chats + messages; vec.db holds vectors (sqlite-vec). Both share this file.
-- runMigrations applies to each DB; tables are created idempotently with IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);

CREATE TABLE IF NOT EXISTS vectors (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  content TEXT NOT NULL,
  embedding BLOB,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vectors_chat_id ON vectors(chat_id);
