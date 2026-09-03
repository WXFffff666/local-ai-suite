import { describe, expect, it } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from '../../main/storage/db'
import { PermissionEngine } from './engine'
import { PermissionPolicyError, type PermissionAction, type RuleDraft } from './types'
import { actionValue, normalizeCmd, normalizePath } from './rules'

function makeDb() {
  const db = new BetterSqlite3(':memory:')
  migrate(db)
  return db
}

type AlwaysRule = Omit<RuleDraft, 'scope'> & { scope?: 'always' | 'session' }

describe('PermissionEngine.evaluate — precedence matrix (deny > ask > allow, longest-prefix within class, default-ask)', () => {
  const matrix: Array<{
    name: string
    rules: AlwaysRule[]
    action: PermissionAction
    want: 'allow' | 'ask' | 'deny'
    wantRule?: string
  }> = [
    { name: 'unlisted action defaults to ask (never silent allow)', rules: [], action: { type: 'fs.shell', target: { cmd: 'rm -rf /' } }, want: 'ask' },
    {
      name: 'Bash prefix matches on word boundary',
      rules: [{ kind: 'fs.shell', rule: 'Bash(npm run test:*)', decision: 'allow' }],
      action: { type: 'fs.shell', target: 'npm run test --watch' },
      want: 'allow',
      wantRule: 'Bash(npm run test:*)',
    },
    {
      name: 'Bash prefix matches the bare prefix command itself',
      rules: [{ kind: 'fs.shell', rule: 'Bash(npm run test:*)', decision: 'allow' }],
      action: { type: 'fs.shell', target: 'npm run test' },
      want: 'allow',
    },
    {
      name: 'Bash prefix does NOT bleed across word boundary (npm run tester)',
      rules: [{ kind: 'fs.shell', rule: 'Bash(npm run test:*)', decision: 'allow' }],
      action: { type: 'fs.shell', target: 'npm run tester' },
      want: 'ask',
    },
    {
      name: 'deny class beats a more specific allow (Roo precedence)',
      rules: [
        { kind: 'fs.shell', rule: 'Bash(npm:*)', decision: 'deny' },
        { kind: 'fs.shell', rule: 'Bash(npm run test:*)', decision: 'allow' },
      ],
      action: { type: 'fs.shell', target: 'npm run test' },
      want: 'deny',
      wantRule: 'Bash(npm:*)',
    },
    {
      name: 'ask class beats a broader allow',
      rules: [
        { kind: 'fs.read', rule: 'Read(**)', decision: 'allow' },
        { kind: 'fs.read', rule: 'Read(secrets/**)', decision: 'ask' },
      ],
      action: { type: 'fs.read', target: 'secrets/key.pem' },
      want: 'ask',
      wantRule: 'Read(secrets/**)',
    },
    {
      name: 'allow outside the ask subtree still hits the broad allow',
      rules: [
        { kind: 'fs.read', rule: 'Read(**)', decision: 'allow' },
        { kind: 'fs.read', rule: 'Read(secrets/**)', decision: 'ask' },
      ],
      action: { type: 'fs.read', target: 'src/a.ts' },
      want: 'allow',
      wantRule: 'Read(**)',
    },
    {
      name: 'within the allow class the longest prefix wins',
      rules: [
        { kind: 'fs.shell', rule: 'Bash(git:*)', decision: 'allow' },
        { kind: 'fs.shell', rule: 'Bash(git push:*)', decision: 'allow' },
      ],
      action: { type: 'fs.shell', target: 'git push origin main' },
      want: 'allow',
      wantRule: 'Bash(git push:*)',
    },
    {
      name: 'Bash exact form matches only verbatim command',
      rules: [{ kind: 'fs.shell', rule: 'Bash(git status)', decision: 'allow' }],
      action: { type: 'fs.shell', target: 'git status -s' },
      want: 'ask',
    },
    {
      name: 'Bash exact form matches verbatim',
      rules: [{ kind: 'fs.shell', rule: 'Bash(git status)', decision: 'allow' }],
      action: { type: 'fs.shell', target: '  git   status ' },
      want: 'allow',
    },
    {
      name: 'wildcard-free Read pattern is a literal path prefix',
      rules: [{ kind: 'fs.read', rule: 'Read(src)', decision: 'allow' }],
      action: { type: 'fs.read', target: { path: 'src/deep/x.ts' } },
      want: 'allow',
    },
    {
      name: 'literal path prefix respects segment boundaries',
      rules: [{ kind: 'fs.read', rule: 'Read(src)', decision: 'allow' }],
      action: { type: 'fs.read', target: { path: 'srcx/a.ts' } },
      want: 'ask',
    },
    {
      name: 'Windows separators normalize before matching',
      rules: [{ kind: 'fs.write', rule: 'Edit(src/secrets/**)', decision: 'deny' }],
      action: { type: 'fs.write', target: { path: 'src\\secrets\\a.ts' } },
      want: 'deny',
    },
    {
      name: 'single-segment star does not cross directories',
      rules: [{ kind: 'fs.read', rule: 'Read(*.env)', decision: 'deny' }],
      action: { type: 'fs.read', target: 'config/app.env' },
      want: 'ask',
    },
    {
      name: 'net host glob is case-insensitive on both sides',
      rules: [{ kind: 'net', rule: 'Net(*.example.com)', decision: 'allow' }],
      action: { type: 'net', target: { host: 'API.example.com', path: 'v1/pull' } },
      want: 'allow',
    },
    {
      name: 'net literal host is a path prefix for host/path targets',
      rules: [{ kind: 'net', rule: 'Net(github.com)', decision: 'allow' }],
      action: { type: 'net', target: 'GitHub.com/api/repos' },
      want: 'allow',
    },
    {
      name: 'net rejects lookalike suffix hosts',
      rules: [{ kind: 'net', rule: 'Net(*.example.com)', decision: 'allow' }],
      action: { type: 'net', target: 'evil-example.com' },
      want: 'ask',
    },
    {
      name: 'mcp server rule covers all tools; deny one tool wins by class',
      rules: [
        { kind: 'mcp', rule: 'MCP(filesystem:*)', decision: 'allow' },
        { kind: 'mcp', rule: 'MCP(filesystem:delete_file)', decision: 'deny' },
      ],
      action: { type: 'mcp', target: { server: 'filesystem', tool: 'delete_file' } },
      want: 'deny',
      wantRule: 'MCP(filesystem:delete_file)',
    },
    {
      name: 'mcp string shorthand server:tool',
      rules: [{ kind: 'mcp', rule: 'MCP(github)', decision: 'allow' }],
      action: { type: 'mcp', target: 'github:create_issue' },
      want: 'allow',
    },
    {
      name: 'rules never leak across kinds',
      rules: [{ kind: 'fs.shell', rule: 'Bash(ls:*)', decision: 'allow' }],
      action: { type: 'fs.read', target: 'ls' },
      want: 'ask',
    },
    {
      name: 'full stack: deny beats ask beats allow regardless of specificity',
      rules: [
        { kind: 'fs.read', rule: 'Read(**)', decision: 'deny' },
        { kind: 'fs.read', rule: 'Read(src/**)', decision: 'ask' },
        { kind: 'fs.read', rule: 'Read(src/a.ts)', decision: 'allow' },
      ],
      action: { type: 'fs.read', target: 'src/a.ts' },
      want: 'deny',
      wantRule: 'Read(**)',
    },
  ]

  for (const c of matrix) {
    it(c.name, () => {
      const db = makeDb()
      const engine = new PermissionEngine(db, { now: () => 1000 })
      for (const r of c.rules) engine.addRule({ ...r, scope: r.scope ?? 'always' })
      expect(engine.evaluate(c.action)).toBe(c.want)
      if (c.wantRule !== undefined) {
        const a = engine.assess(c.action)
        expect(a.rule).toBe(c.wantRule)
        expect(a.ruleId).not.toBeNull()
        expect(a.scope).toBe('always')
      }
    })
  }
})

describe('session vs always scope', () => {
  it('session grant evaluates, is never persisted, and is cleared by destroy()', () => {
    const db = makeDb()
    const engine = new PermissionEngine(db)
    const r = engine.addRule({ kind: 'fs.shell', rule: 'Bash(echo:*)', scope: 'session', decision: 'allow' })
    expect(r.id).toBeLessThan(0)
    expect(engine.evaluate({ type: 'fs.shell', target: 'echo hi' })).toBe('allow')
    expect((db.prepare('SELECT count(*) AS c FROM permissions').get() as { c: number }).c).toBe(0)

    engine.destroy()
    expect(engine.evaluate({ type: 'fs.shell', target: 'echo hi' })).toBe('ask')
    expect(engine.listRules()).toHaveLength(0)
  })

  it('always grant survives a new engine over the same db', () => {
    const db = makeDb()
    const e1 = new PermissionEngine(db)
    e1.addRule({ kind: 'fs.read', rule: 'Read(docs/**)', scope: 'always', decision: 'allow' })
    const e2 = new PermissionEngine(db)
    expect(e2.evaluate({ type: 'fs.read', target: 'docs/a.md' })).toBe('allow')
    e2.destroy()
    expect(e2.evaluate({ type: 'fs.read', target: 'docs/a.md' })).toBe('allow') // destroy only drops session rules
  })

  it('removeRule works for always (db) and session (memory) ids; duplicate add is deduped', () => {
    const db = makeDb()
    const engine = new PermissionEngine(db)
    const a = engine.addRule({ kind: 'fs.shell', rule: 'Bash(dir:*)', scope: 'always', decision: 'allow' })
    const dup = engine.addRule({ kind: 'fs.shell', rule: 'Bash(dir:*)', scope: 'always', decision: 'allow' })
    expect(dup.id).toBe(a.id)
    expect(engine.removeRule(a.id)).toBe(true)
    expect(engine.removeRule(a.id)).toBe(false)
    expect(engine.evaluate({ type: 'fs.shell', target: 'dir C:\\' })).toBe('ask')

    const s = engine.addRule({ kind: 'net', rule: 'Net(docs.rs)', scope: 'session', decision: 'allow' })
    expect(engine.removeRule(s.id)).toBe(true)
    expect(engine.removeRule(s.id)).toBe(false)
  })

  it('listRules filters by kind/scope and stamps created_at from the injected clock', () => {
    const db = makeDb()
    const engine = new PermissionEngine(db, { now: () => 777 })
    engine.addRule({ kind: 'fs.read', rule: 'Read(a)', scope: 'always', decision: 'allow' })
    engine.addRule({ kind: 'fs.read', rule: 'Read(b)', scope: 'session', decision: 'deny' })
    engine.addRule({ kind: 'net', rule: 'Net(c)', scope: 'always', decision: 'ask' })
    expect(engine.listRules({ kind: 'fs.read' })).toHaveLength(2)
    expect(engine.listRules({ scope: 'always' })).toHaveLength(2)
    expect(engine.listRules({ kind: 'fs.read', scope: 'session' })).toEqual([
      { id: -1, kind: 'fs.read', rule: 'Read(b)', scope: 'session', decision: 'deny', createdAt: 777 },
    ])
    expect(engine.listRules()).toHaveLength(3)
  })
})

describe('addRule/evaluate input validation (boundary parse, no silent acceptance)', () => {
  const engine = new PermissionEngine(makeDb())

  it('rejects wrappers that do not fit the kind, empty patterns, bad enums', () => {
    expect(() => engine.addRule({ kind: 'fs.shell', rule: 'Read(x)', scope: 'always', decision: 'allow' })).toThrow(PermissionPolicyError)
    expect(() => engine.addRule({ kind: 'fs.read', rule: 'Edit(x)', scope: 'always', decision: 'allow' })).toThrow(/Read/)
    expect(() => engine.addRule({ kind: 'fs.shell', rule: 'Bash(  )', scope: 'always', decision: 'allow' })).toThrow(/empty/)
    expect(() => engine.addRule({ kind: 'fs.shell', rule: 'notarule', scope: 'always', decision: 'allow' })).toThrow(/Bash/)
    expect(() => engine.addRule({ kind: 'nope' as never, rule: 'Bash(x)', scope: 'always', decision: 'allow' })).toThrow(/kind/)
    expect(() => engine.addRule({ kind: 'net', rule: 'Net(a)', scope: 'forever' as never, decision: 'allow' })).toThrow(/scope/)
    expect(() => engine.addRule({ kind: 'net', rule: 'Net(a)', scope: 'always', decision: 'maybe' as never })).toThrow(/decision/)
  })

  it('evaluate rejects targets missing their kind-specific field', () => {
    expect(() => engine.evaluate({ type: 'fs.shell', target: { path: 'x' } })).toThrow(/cmd/)
    expect(() => engine.evaluate({ type: 'fs.read', target: { host: 'x' } })).toThrow(/path/)
    expect(() => engine.evaluate({ type: 'mcp', target: { server: 'only' } })).toThrow(/tool/)
  })

  it('target normalizers collapse whitespace and strip ./ segments', () => {
    expect(normalizeCmd('  a   b  ')).toBe('a b')
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts')
    expect(actionValue({ type: 'net', target: { host: 'Ex.COM', path: '/A' } })).toBe('ex.com/a')
  })
})

describe('audit log — append-only by SQL trigger, newest-first paging', () => {
  it('record writes rows; UPDATE/DELETE abort with the append-only message', () => {
    const db = makeDb()
    const engine = new PermissionEngine(db, { now: () => 5 })
    const action: PermissionAction = { type: 'fs.shell', target: 'npm run test' }
    engine.record(action, engine.assess(action), { who: 'user', conversationId: 'c1' })
    engine.record({ type: 'net', target: 'evil.io' }, { decision: 'deny', rule: 'Net(evil.io)', ruleId: 1, scope: 'always' })

    const rows = engine.listAudit()
    expect(rows).toHaveLength(2)
    // newest-first: rowid DESC breaks ts ties
    expect(rows[0]?.action).toBe('net')
    expect(rows[1]?.action).toBe('fs.shell')
    const detail = rows[1]?.detail as { target: string; rule: string | null; who: string }
    expect(detail.target).toBe('npm run test')
    expect(detail.who).toBe('user')
    expect(detail.rule).toBeNull()

    expect(() => db.prepare("UPDATE audit_log SET decision = 'allow'").run()).toThrow(/audit_log is append-only/)
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/audit_log is append-only/)
  })

  it('listAudit pages with limit/offset', () => {
    const db = makeDb()
    const engine = new PermissionEngine(db)
    const action: PermissionAction = { type: 'fs.read', target: 'a.ts' }
    for (let i = 0; i < 5; i++) engine.record(action, engine.assess(action))
    expect(engine.listAudit({ limit: 2 })).toHaveLength(2)
    expect(engine.listAudit({ limit: 2, offset: 4 })).toHaveLength(1)
    expect(engine.listAudit({ limit: 2, offset: 5 })).toHaveLength(0)
  })
})

describe('migration 002 via db.ts runner', () => {
  it('applying migrate() twice is safe and tables/triggers exist exactly once', () => {
    const db = makeDb()
    migrate(db)
    const triggerNames = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'audit_log%'").all() as Array<{ name: string }>).map((t) => t.name)
    expect(triggerNames.sort()).toEqual(['audit_log_no_delete', 'audit_log_no_update'])
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_permissions_kind'").all() as unknown[]).length
    expect(idx).toBe(1)
  })
})
