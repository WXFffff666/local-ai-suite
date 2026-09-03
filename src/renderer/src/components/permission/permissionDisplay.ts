/**
 * todo25 — pure display mapping for the permission dialog (kind labels,
 * grant-rule preview text). Split out of PermissionDialogHost so the
 * component stays under the size ceiling; behavior is locked by the dialog
 * jsdom tests (summary/rule-line assertions). The RULE_KEYWORDS mirror the
 * policy wrapper table in src/agent/policy/rules.ts, which lives outside
 * tsconfig.web's include set — keep both in sync (todo29 adds a node-side
 * alignment assert if the syntax ever moves).
 */
import type { PermissionActionWire, PermissionTargetFieldsWire } from '../../../../main/ipc/whitelist'

export const KIND_LABELS: Record<PermissionActionWire['type'], string> = {
  'fs.read': '读取文件',
  'fs.write': '写入文件',
  'fs.shell': '执行命令',
  net: '网络访问',
  mcp: 'MCP 工具'
}

const RULE_KEYWORDS: Record<PermissionActionWire['type'], string> = {
  'fs.read': 'Read',
  'fs.write': 'Edit',
  'fs.shell': 'Bash',
  net: 'Net',
  mcp: 'MCP'
}

function fieldValue(type: PermissionActionWire['type'], target: PermissionTargetFieldsWire): string {
  switch (type) {
    case 'fs.shell':
      return target.cmd ?? ''
    case 'net':
      return target.path ? `${target.host ?? ''}/${target.path}` : target.host ?? ''
    case 'mcp':
      return `${target.server ?? ''}:${target.tool ?? ''}`
    default:
      // fs.read / fs.write
      return target.path ?? ''
  }
}

export function targetValue(action: PermissionActionWire): string {
  return typeof action.target === 'string' ? action.target : fieldValue(action.type, action.target)
}

/** The rule text a 'session'/'always' grant will persist (todo24 rule syntax). */
export function grantRuleText(action: PermissionActionWire): string {
  return `${RULE_KEYWORDS[action.type]}(${targetValue(action)})`
}
