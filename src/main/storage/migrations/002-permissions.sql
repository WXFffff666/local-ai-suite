-- 002-permissions.sql — permission policy store + append-only audit log (todo24)
-- Applied by migrate() alongside 001-init.sql; idempotent via IF NOT EXISTS.
-- permissions: policy rules consumed by src/agent/policy/engine.ts.
--   kind     = action class (fs.read | fs.write | fs.shell | net | mcp)
--   rule     = Claude-Code-style rule text, e.g. Bash(npm run test:*) / Read(src/**)
--   scope    = always rules persist here; session grants live in engine memory only
--   decision = deny > ask > allow precedence is enforced by the engine
-- audit_log: append-only evidence trail. UPDATE/DELETE are rejected by trigger.

CREATE TABLE IF NOT EXISTS permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('fs.read', 'fs.write', 'fs.shell', 'net', 'mcp')),
  rule TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'always')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'ask')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_permissions_kind ON permissions(kind);

CREATE TABLE IF NOT EXISTS audit_log (
  ts INTEGER NOT NULL,
  action TEXT,
  detail_json TEXT,
  decision TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
