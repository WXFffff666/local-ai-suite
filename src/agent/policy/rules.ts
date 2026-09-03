/**
 * Rule syntax subset for permission rules (todo24), Claude-Code-flavoured.
 * Every stored rule must match the wrapper for its kind:
 *
 *   fs.shell  -> `Bash(<cmd>)` exact command, or `Bash(<prefix>:*)` command prefix.
 *                Prefix match requires a word boundary: `Bash(npm run test:*)` matches
 *                `npm run test --watch` but NOT `npm run tester` (stricter than Claude
 *                Code's raw string prefix - documented deviation, safer default).
 *   fs.read   -> `Read(<glob>)`   path mini-glob (see glob.ts); wildcard-free pattern
 *                is a literal path prefix: `Read(src)` covers `src/**`.
 *   fs.write  -> `Edit(<glob>)`   same semantics as Read.
 *   net       -> `Net(<glob>)`    matched against lowercased `host` or `host/path`.
 *   mcp       -> `MCP(<server>)` / `MCP(<server>:*)` all tools of a server,
 *                `MCP(<server>:<tool>)` one tool (exact).
 *
 * Anything not listed above (unknown wrappers, empty inner text, keywords that do not
 * fit the kind) is rejected at addRule time with PermissionPolicyError.
 */
import { PermissionPolicyError, type PermissionAction, type PermissionKind } from './types'
import { globToRegExp, literalPrefixLength, matchPathLike } from './glob'

export const RULE_KEYWORDS: Record<PermissionKind, string> = {
  'fs.shell': 'Bash',
  'fs.read': 'Read',
  'fs.write': 'Edit',
  net: 'Net',
  mcp: 'MCP',
}

export type CompiledRule =
  | { readonly form: 'bash-prefix'; readonly prefix: string }
  | { readonly form: 'bash-exact'; readonly cmd: string }
  | { readonly form: 'glob'; readonly pattern: string; readonly subpathMatch: boolean }
  | { readonly form: 'mcp'; readonly server: string; readonly tool: string | null }

/** `npm run   test ` -> `npm run test` (trim + collapse runs of whitespace). */
export function normalizeCmd(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/** Windows-friendly path normalization: backslashes -> `/`, strip leading `./` and `/`. */
export function normalizePath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  while (p.startsWith('/')) p = p.slice(1)
  return p
}

function required(value: string | undefined, field: string, action: PermissionAction): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PermissionPolicyError(
      `action '${action.type}' needs target field '${field}' (got ${JSON.stringify(action.target)})`,
    )
  }
  return value
}

/**
 * Normalize the action target to the comparable string form:
 * fs.shell -> collapsed command; fs.read/fs.write -> slash path;
 * net -> lowercased `host` or `host/path`; mcp -> `server:tool`.
 */
export function actionValue(action: PermissionAction): string {
  const t = action.target
  if (typeof t === 'string') {
    switch (action.type) {
      case 'fs.shell':
        return normalizeCmd(required(t, 'target string', action))
      case 'net':
        return t.trim().toLowerCase()
      case 'mcp':
        return required(t, 'target string', action)
      default:
        return normalizePath(required(t, 'target string', action))
    }
  }
  switch (action.type) {
    case 'fs.shell':
      return normalizeCmd(required(t.cmd, 'cmd', action))
    case 'fs.read':
    case 'fs.write':
      return normalizePath(required(t.path, 'path', action))
    case 'net': {
      const host = required(t.host, 'host', action).toLowerCase()
      return t.path ? `${host}/${normalizePath(t.path).toLowerCase()}` : host
    }
    case 'mcp':
      return `${required(t.server, 'server', action)}:${required(t.tool, 'tool', action)}`
  }
}

function parseInner(kind: PermissionKind, ruleText: string): string {
  const m = /^([A-Za-z]+)\(([\s\S]*)\)$/.exec(ruleText.trim())
  if (!m || m[1] !== RULE_KEYWORDS[kind]) {
    throw new PermissionPolicyError(
      `rule for kind '${kind}' must use '${RULE_KEYWORDS[kind]}(...)' syntax, got '${ruleText}'`,
    )
  }
  if (m[2].trim() === '') {
    throw new PermissionPolicyError(`rule '${ruleText}' has empty pattern`)
  }
  return m[2]
}

export function compileRule(kind: PermissionKind, ruleText: string): CompiledRule {
  const inner = parseInner(kind, ruleText)
  switch (kind) {
    case 'fs.shell':
      if (inner.endsWith(':*')) {
        const prefix = normalizeCmd(inner.slice(0, -2))
        if (prefix === '') throw new PermissionPolicyError(`rule '${ruleText}' has empty command prefix`)
        return { form: 'bash-prefix', prefix }
      }
      return { form: 'bash-exact', cmd: normalizeCmd(inner) }
    case 'fs.read':
      return { form: 'glob', pattern: normalizePath(inner), subpathMatch: false }
    case 'fs.write':
      return { form: 'glob', pattern: normalizePath(inner), subpathMatch: false }
    case 'net':
      // net values are `host` or `host/path`; a wildcard host rule also covers its paths
      // (Net(*.example.com) allows api.example.com/v1/pull). Both sides are lowercased.
      return { form: 'glob', pattern: inner.trim().toLowerCase(), subpathMatch: true }
    case 'mcp': {
      const idx = inner.indexOf(':')
      const server = idx === -1 ? inner.trim() : inner.slice(0, idx).trim()
      if (server === '') throw new PermissionPolicyError(`rule '${ruleText}' has empty server name`)
      const toolPart = idx === -1 ? '' : inner.slice(idx + 1).trim()
      const tool = toolPart === '' || toolPart === '*' ? null : toolPart
      return { form: 'mcp', server, tool }
    }
  }
}

/** Does a compiled rule match the action? `value` must come from actionValue(action). */
export function ruleMatches(rule: CompiledRule, value: string): boolean {
  switch (rule.form) {
    case 'bash-prefix':
      return value === rule.prefix || value.startsWith(rule.prefix + ' ')
    case 'bash-exact':
      return value === rule.cmd
    case 'glob': {
      if (matchPathLike(rule.pattern, value)) return true
      if (rule.subpathMatch && !rule.pattern.endsWith('**')) {
        return globToRegExp(rule.pattern + '/**').test(value)
      }
      return false
    }
    case 'mcp': {
      const idx = value.indexOf(':')
      const server = idx === -1 ? value : value.slice(0, idx)
      const tool = idx === -1 ? '' : value.slice(idx + 1)
      return server === rule.server && (rule.tool === null || rule.tool === tool)
    }
  }
}

/** Longer literal prefix = more specific (Roo longest-prefix tie-break). */
export function ruleSpecificity(rule: CompiledRule): number {
  switch (rule.form) {
    case 'bash-prefix':
      return rule.prefix.length
    case 'bash-exact':
      return rule.cmd.length
    case 'glob':
      return literalPrefixLength(rule.pattern)
    case 'mcp':
      return rule.server.length + (rule.tool === null ? 0 : 1 + rule.tool.length)
  }
}
