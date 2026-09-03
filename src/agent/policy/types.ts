/**
 * Permission policy domain types (todo24). Pure module: no Electron, no IPC.
 * The engine consumes an open better-sqlite3 handle (permissions + audit_log
 * tables created by migrations/002-permissions.sql via db.ts migrate()).
 */

export const PERMISSION_KINDS = ['fs.read', 'fs.write', 'fs.shell', 'net', 'mcp'] as const
export type PermissionKind = (typeof PERMISSION_KINDS)[number]

export const PERMISSION_SCOPES = ['session', 'always'] as const
export type PermissionScope = (typeof PERMISSION_SCOPES)[number]

export const PERMISSION_DECISIONS = ['allow', 'deny', 'ask'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** Roo-style precedence: deny beats ask beats allow, regardless of specificity. */
export const DECISION_RANK: Record<PermissionDecision, 0 | 1 | 2> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

/** Typed target shapes accepted per kind (string shorthand is also valid). */
export type PermissionTargetFields = {
  cmd?: string
  path?: string
  host?: string
  server?: string
  tool?: string
}

export type PermissionAction = {
  type: PermissionKind
  /** string or kind-appropriate fields; fs.shell={cmd}, read/write={path}, net={host,path?} or string, mcp={server,tool} or "server:tool" */
  target: string | PermissionTargetFields
}

export type RuleDraft = {
  kind: PermissionKind
  /** Claude-Code-style rule text, see rules.ts for the implemented syntax subset */
  rule: string
  scope: PermissionScope
  decision: PermissionDecision
}

export type StoredRule = RuleDraft & {
  id: number
  createdAt: number
}

export type Assessment = {
  decision: PermissionDecision
  /** winning rule text, or null when no rule matched (default-ask) */
  rule: string | null
  ruleId: number | null
  scope: PermissionScope | null
}

export type AuditEntry = {
  ts: number
  action: string
  detail: unknown
  decision: string
}

export type AuditQuery = {
  limit?: number
  offset?: number
}

/** Raised for malformed rules/targets at the engine boundary. */
export class PermissionPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionPolicyError'
  }
}