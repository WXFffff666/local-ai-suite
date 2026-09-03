/**
 * errors.ts — structured MCP errors (todo40). Rejections never cross the IPC
 * boundary raw: mcp/ipc.ts maps these codes into the reply union, and the
 * agent tool path converts them to a failed tool_result with the same text.
 */

export const MCP_ERROR_CODES = [
  'server-not-found',
  'server-disabled',
  'server-failed',
  'server-start-failed',
  'sdk-unavailable',
  'tool-not-found',
  'call-failed',
] as const

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number]

export class McpError extends Error {
  override readonly name = 'McpError'
  constructor(readonly code: McpErrorCode, message: string) {
    super(message)
  }
}
