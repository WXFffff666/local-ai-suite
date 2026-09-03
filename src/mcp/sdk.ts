/**
 * sdk.ts — the ONLY place @modelcontextprotocol/sdk is touched (todo40, R3b).
 * The SDK targets ESM (v1.30 dual-publishes, but R3b's plan posture stands:
 * load lazily through `await import()` — works from the CJS main, costs
 * nothing at boot, and survives an ESM-only future release); a missing/broken
 * install degrades to an honest McpError('sdk-unavailable') at first use,
 * never at startup. Everything the pool consumes is behind the structural
 * McpSdkSurface seam (PermissionPort duck-typing precedent) — unit tests
 * inject a fake surface directly, no module mocking.
 */

import type { JsonValue } from '../agent/runner/types'
import { McpError } from './errors'
import type {
  McpSdkClient,
  McpSdkSurface,
  McpServerEntry,
  McpToolInfo,
} from './types'

/** Lazy once-cached dynamic import of the real SDK (R3b: ESM under CJS main). */
let sdkPromise: Promise<McpSdkSurface> | null = null

export async function loadMcpSdk(): Promise<McpSdkSurface> {
  sdkPromise ??= (async (): Promise<McpSdkSurface> => {
    try {
      const [clientMod, stdioMod] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/stdio.js'),
      ])
      const surface = {
        Client: clientMod.Client,
        StdioClientTransport: stdioMod.StdioClientTransport,
      } as unknown as McpSdkSurface
      return surface
    } catch (error) {
      // A failed load must not poison the cache — next call retries honestly.
      sdkPromise = null
      throw new McpError('sdk-unavailable', error instanceof Error ? error.message : String(error))
    }
  })()
  return sdkPromise
}

/** Test seam: drop the memoised SDK promise (vitest afterEach). */
export function resetMcpSdkCache(): void {
  sdkPromise = null
}

/** One initialized client for a stdio server: transport spawn + handshake. */
export async function openStdioClient(sdk: McpSdkSurface, entry: McpServerEntry): Promise<McpSdkClient> {
  const transport = new sdk.StdioClientTransport({
    command: entry.command,
    ...(entry.args === undefined ? {} : { args: [...entry.args] }),
    ...(entry.env === undefined ? {} : { env: { ...entry.env } }),
    stderr: 'pipe',
  })
  const client = new sdk.Client({ name: 'local-ai-suite', version: '0.1.0' })
  await client.connect(transport)
  return client
}

/** tools/list with cursor pagination (bounded: a runaway server cannot spin us). */
export async function fetchAllTools(client: McpSdkClient): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page += 1) {
    const result = await client.listTools(cursor === undefined ? {} : { cursor })
    for (const tool of result.tools) {
      tools.push({
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema as JsonValue }),
      })
    }
    cursor = result.nextCursor
    if (cursor === undefined || result.tools.length === 0) return tools
  }
  return tools
}

/** Text projection of a tools/call content array (isError diagnostics + replies). */
export function toolResultText(content: readonly JsonValue[] | undefined): string {
  return (content ?? [])
    .map((block) => {
      const b = block as { type?: string; text?: string }
      return typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .filter((s) => s !== '')
    .join('\n')
}
