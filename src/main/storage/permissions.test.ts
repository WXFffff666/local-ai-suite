/**
 * todo24 characterization + regression tests for src/main/storage.
 * Pins the PRE-EXISTING tolerant config semantics (DEFAULT merge with unknown
 * old fields, never-throw on corrupt file) and db migrate() idempotency, then
 * covers the new schemaVersion field and the 002-permissions migration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => { throw new Error('mock: no electron in test') }) },
}))

import { CURRENT_SCHEMA_VERSION, DEFAULT_CONFIG, getConfig, getConfigPath, resetConfig, setConfig } from './config'
import { closeDb, getDb, migrate } from './db'

let tmpDir = ''
let origCwd = ''

function writeConfigFixture(text: string): void {
  const p = getConfigPath()
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text, 'utf-8')
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-perm-'))
  origCwd = process.cwd()
  process.chdir(tmpDir)
})

afterEach(() => {
  try {
    closeDb()
  } catch { /* ignore */ }
  try {
    process.chdir(origCwd)
  } catch { /* ignore */ }
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch { /* ignore */ }
})

describe('config characterization (pre-24 behavior, must not regress)', () => {
  it('DEFAULT merge keeps unknown old fields and tolerates corrupt files', () => {
    // no file -> pure defaults
    expect(getConfig()).toEqual(DEFAULT_CONFIG)

    // v1-era file: unknown fields, no schemaVersion -> merged over defaults, unknowns preserved
    writeConfigFixture(
      JSON.stringify({ theme: 'dark', legacyTunnelEnabled: true, oldNested: { a: 1 }, openaiPort: 9000 }),
    )
    const cfg = getConfig()
    expect(cfg.theme).toBe('dark')
    expect(cfg.openaiPort).toBe(9000)
    // untouched fields fall back to defaults
    expect(cfg.locale).toBe(DEFAULT_CONFIG.locale)
    // unknown keys survive at runtime (round-trip requirement)
    expect(cfg).toHaveProperty('legacyTunnelEnabled', true)
    expect(cfg).toHaveProperty('oldNested')

    // corrupt json -> defaults, never throws
    writeConfigFixture('{not json')
    expect(getConfig()).toEqual(DEFAULT_CONFIG)
  })
})

describe('config schemaVersion (todo24)', () => {
  it('CURRENT_SCHEMA_VERSION is 2 and DEFAULT_CONFIG carries it', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2)
    expect(DEFAULT_CONFIG.schemaVersion).toBe(2)
  })

  it('v1 file (missing schemaVersion) reads tolerant, first save upgrades on disk', () => {
    writeConfigFixture(JSON.stringify({ theme: 'light', legacyKey: 'keep-me' }))
    const cfg = getConfig()
    // missing -> treated as v1, upcast to current in the merged view
    expect(cfg.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(cfg.theme).toBe('light')
    // read stays non-destructive: file on disk untouched until a save
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf-8')).schemaVersion).toBeUndefined()

    // rewrite-on-save upgrade, unknown fields preserved
    setConfig({ locale: 'en-US' })
    const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf-8'))
    expect(onDisk.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(onDisk.theme).toBe('light')
    expect(onDisk.locale).toBe('en-US')
    expect(onDisk.legacyKey).toBe('keep-me')
  })

  it('explicit lower schemaVersion upgrades on save; garbage value falls back to default', () => {
    writeConfigFixture(JSON.stringify({ schemaVersion: 1 }))
    expect(getConfig().schemaVersion).toBe(1)
    setConfig({})
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf-8')).schemaVersion).toBe(CURRENT_SCHEMA_VERSION)

    writeConfigFixture(JSON.stringify({ schemaVersion: 'nope' }))
    expect(getConfig().schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('resetConfig writes the current schema version', () => {
    resetConfig()
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf-8')).schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
  })
})

describe('db migrations 001+002 (todo24)', () => {
  it('migrate is idempotent and creates permissions/audit_log + append-only triggers', () => {
    const db = getDb()
    expect(() => migrate(db)).not.toThrow()
    expect(() => migrate(db)).not.toThrow()

    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['chats', 'messages', 'vectors', 'permissions', 'audit_log']))

    const permCols = (db.prepare('PRAGMA table_info(permissions)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(permCols).toEqual(expect.arrayContaining(['id', 'kind', 'rule', 'scope', 'decision', 'created_at']))
    const auditCols = (db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(auditCols).toEqual(expect.arrayContaining(['ts', 'action', 'detail_json', 'decision']))

    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(triggers).toEqual(expect.arrayContaining(['audit_log_no_update', 'audit_log_no_delete']))

    // CHECK constraints bite on insert
    expect(() =>
      db.prepare("INSERT INTO permissions (kind, rule, scope, decision, created_at) VALUES ('bogus','x','always','allow',1)").run(),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare("INSERT INTO permissions (kind, rule, scope, decision, created_at) VALUES ('net','x','forever','allow',1)").run(),
    ).toThrow(/CHECK/)
    expect(() =>
      db.prepare("INSERT INTO permissions (kind, rule, scope, decision, created_at) VALUES ('net','x','always','maybe',1)").run(),
    ).toThrow(/CHECK/)
  })
})
