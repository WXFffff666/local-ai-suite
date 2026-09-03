/**
 * PermissionEngine (todo24): policy store + evaluator + audit log.
 * Pure module - no Electron, no IPC. Constructor takes an OPEN better-sqlite3
 * handle whose schema came from migrations/002-permissions.sql (db.ts migrate()).
 *
 * Semantics (plan R3 anchors: Claude Code rule syntax, Roo Code precedence):
 *   - evaluate returns 'allow' | 'ask' | 'deny'; default for any unlisted action is 'ask'
 *   - precedence deny > ask > allow; within one class the longest literal prefix wins
 *   - scope 'always' rules persist in `permissions`; scope 'session' rules live ONLY in
 *     this instance's memory (never written to disk) and are dropped by destroy()
 *   - audit_log is append-only, enforced by SQL triggers; there is no update/delete path
 */
import type { Database } from '../../main/storage/db'
import {
  DECISION_RANK,
  PermissionPolicyError,
  PERMISSION_DECISIONS,
  PERMISSION_KINDS,
  PERMISSION_SCOPES,
  type Assessment,
  type AuditEntry,
  type AuditQuery,
  type PermissionAction,
  type PermissionDecision,
  type PermissionKind,
  type PermissionScope,
  type RuleDraft,
  type StoredRule,
} from './types'
import { actionValue, compileRule, ruleMatches, ruleSpecificity, type CompiledRule } from './rules'

type PermissionRow = {
  id: number
  kind: string
  rule: string
  scope: string
  decision: string
  created_at: number
}

type AuditRow = { ts: number; action: string | null; detail_json: string | null; decision: string | null }

function rowToRule(row: PermissionRow): StoredRule {
  return {
    id: row.id,
    kind: row.kind as PermissionKind,
    rule: row.rule,
    scope: row.scope as PermissionScope,
    decision: row.decision as PermissionDecision,
    createdAt: row.created_at,
  }
}

function requireMember<T extends string>(list: readonly T[], value: string, what: string): T {
  if (!list.includes(value as T)) {
    throw new PermissionPolicyError(`invalid ${what} '${value}' (expected one of: ${list.join(', ')})`)
  }
  return value as T
}

export type PermissionEngineOptions = {
  /** injectable clock, defaults to Date.now (tests / todo25) */
  now?: () => number
}

export class PermissionEngine {
  private readonly db: Database
  private readonly now: () => number
  /** session-scope grants: memory only, negative ids, cleared by destroy() */
  private readonly sessionRules: StoredRule[] = []
  private sessionSeq = 0

  constructor(db: Database, opts?: PermissionEngineOptions) {
    this.db = db
    this.now = opts?.now ?? Date.now
  }

  /** Validate + persist a rule. Duplicate (kind, rule, scope, decision) returns the existing row. */
  addRule(draft: RuleDraft): StoredRule {
    const kind = requireMember(PERMISSION_KINDS, draft.kind, 'kind')
    const scope = requireMember(PERMISSION_SCOPES, draft.scope, 'scope')
    const decision = requireMember(PERMISSION_DECISIONS, draft.decision, 'decision')
    const ruleText = draft.rule.trim()
    compileRule(kind, ruleText) // boundary parse: throws PermissionPolicyError on bad syntax

    if (scope === 'session') {
      const dup = this.sessionRules.find(
        (r) => r.kind === kind && r.rule === ruleText && r.decision === decision,
      )
      if (dup) return dup
      const stored: StoredRule = { id: --this.sessionSeq, kind, rule: ruleText, scope, decision, createdAt: this.now() }
      this.sessionRules.push(stored)
      return stored
    }

    const existing = this.db
      .prepare('SELECT * FROM permissions WHERE kind = ? AND rule = ? AND scope = ? AND decision = ?')
      .get(kind, ruleText, scope, decision) as PermissionRow | undefined
    if (existing) return rowToRule(existing)
    const info = this.db
      .prepare('INSERT INTO permissions (kind, rule, scope, decision, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(kind, ruleText, scope, decision, this.now())
    return { id: Number(info.lastInsertRowid), kind, rule: ruleText, scope, decision, createdAt: this.now() }
  }

  /** Delete by id (negative ids address in-memory session rules). True when something was removed. */
  removeRule(id: number): boolean {
    if (id < 0) {
      const idx = this.sessionRules.findIndex((r) => r.id === id)
      if (idx === -1) return false
      this.sessionRules.splice(idx, 1)
      return true
    }
    return this.db.prepare('DELETE FROM permissions WHERE id = ?').run(id).changes > 0
  }

  /** All effective rules: persisted (scope 'always') plus in-memory session grants. */
  listRules(filter?: { kind?: PermissionKind; scope?: PermissionScope }): StoredRule[] {
    const rows = this.db.prepare('SELECT * FROM permissions ORDER BY id').all() as PermissionRow[]
    const all = [...rows.map(rowToRule), ...this.sessionRules.map((r) => ({ ...r }))]
    return all.filter((r) => (filter?.kind ? r.kind === filter.kind : true) && (filter?.scope ? r.scope === filter.scope : true))
  }

  /** Full assessment: winning decision + the rule that produced it (null rule = default-ask). */
  assess(action: PermissionAction): Assessment {
    const value = actionValue(action)
    const candidates: Array<{ stored: StoredRule; compiled: CompiledRule }> = this.listRules({ kind: action.type }).map(
      (stored) => ({ stored, compiled: compileRule(stored.kind, stored.rule) }),
    )
    let best: { stored: StoredRule; rank: number; spec: number } | null = null
    for (const { stored, compiled } of candidates) {
      if (!ruleMatches(compiled, value)) continue
      const rank = DECISION_RANK[stored.decision]
      const spec = ruleSpecificity(compiled)
      if (best === null || rank < best.rank || (rank === best.rank && spec > best.spec)) {
        best = { stored, rank, spec }
      }
    }
    if (best === null) return { decision: 'ask', rule: null, ruleId: null, scope: null }
    return { decision: best.stored.decision, rule: best.stored.rule, ruleId: best.stored.id, scope: best.stored.scope }
  }

  /** Convenience: decision only. Unlisted actions default to 'ask' - never silent allow. */
  evaluate(action: PermissionAction): PermissionDecision {
    return this.assess(action).decision
  }

  /** Append one audit row. `detail` (e.g. { who, conversationId }) merges into detail_json. */
  record(action: PermissionAction, assessment: Assessment, detail?: Record<string, unknown>): void {
    const payload = JSON.stringify({
      target: actionValue(action),
      rule: assessment.rule,
      ruleId: assessment.ruleId,
      scope: assessment.scope,
      ...detail,
    })
    this.db
      .prepare('INSERT INTO audit_log (ts, action, detail_json, decision) VALUES (?, ?, ?, ?)')
      .run(this.now(), action.type, payload, assessment.decision)
  }

  /** Newest-first audit page for the todo25 UI. No update/delete path exists by design. */
  listAudit(opts?: AuditQuery): AuditEntry[] {
    const limit = opts?.limit ?? 50
    const offset = opts?.offset ?? 0
    const rows = this.db
      .prepare('SELECT ts, action, detail_json, decision FROM audit_log ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as AuditRow[]
    return rows.map((r) => {
      let detail: unknown = r.detail_json ?? null
      try {
        if (r.detail_json !== null) detail = JSON.parse(r.detail_json) as unknown
      } catch {
        /* keep raw string if not valid JSON */
      }
      return { ts: r.ts, action: r.action ?? '', detail, decision: r.decision ?? '' }
    })
  }

  /** Drop every session-scope grant (never persisted). Persisted rules and audit stay. */
  destroy(): void {
    this.sessionRules.length = 0
  }
}
