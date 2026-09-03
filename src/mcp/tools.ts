/**
 * tools.ts — the agent-registry bridge (todo40): every remote MCP tool is
 * wrapped as a strict ToolDef (registerFileTools precedent) and registered
 * under the unique wire name `mcp_<server>__<tool>`. Registration is DYNAMIC:
 * the pool fires onToolsChanged on connect/stop, and syncMcpTools reconciles
 * the registry (unregister stale, register fresh) so a crashed or disabled
 * server's tools disappear from the next agent:start. Gating lives in
 * McpPool.callTool (single funnel for agent + IPC-debug paths), NOT here.
 */

import type { JsonObject, JsonValue } from '../agent/runner/types'
import type { ToolRegistry } from '../agent/tools/registry'
import type { McpPool } from './pool'
import { mcpWireToolName, sanitizeToolSchema, type McpToolInfo } from './types'

type RegisteredMcpTool = {
  readonly wireName: string
  readonly server: string
  readonly tool: string
}

const JSON_VALUE_KEYS: readonly string[] = ['type', 'properties', 'required', 'additionalProperties', 'description']

/** Drop non-OpenAI-parseable top-level keywords the sanitizer cannot guarantee. */
function projectStrictKeys(schema: JsonObject): JsonObject {
  const out: Record<string, JsonValue> = {}
  for (const key of JSON_VALUE_KEYS) {
    const value = schema[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

export function toToolDef(server: string, info: McpToolInfo): RegisteredMcpTool & { parameters: JsonObject; description: string } {
  const description =
    typeof info.description === 'string' && info.description.trim() !== ''
      ? info.description
      : `MCP tool '${info.name}' from server '${server}'`
  return {
    wireName: mcpWireToolName(server, info.name),
    server,
    tool: info.name,
    description,
    parameters: projectStrictKeys(sanitizeToolSchema(info.inputSchema)),
  }
}

/**
 * Reconcile one server's tools in the registry: unregister its previous wire
 * names, register the new set. `tools: []` (stop/disable/failure) removes all
 * of the server's tools. Returns the wire names now live for the server.
 */
export function syncMcpTools(
  registry: ToolRegistry,
  live: Map<string, RegisteredMcpTool[]>,
  server: string,
  tools: readonly McpToolInfo[],
  pool: McpPool,
): readonly string[] {
  for (const prev of live.get(server) ?? []) {
    registry.unregister(prev.wireName)
  }
  if (tools.length === 0) {
    live.delete(server)
    return []
  }
  const registered: RegisteredMcpTool[] = []
  for (const info of tools) {
    const def = toToolDef(server, info)
    try {
      registry.register({
        def: { name: def.wireName, description: def.description, parameters: def.parameters },
        run: (args: JsonObject, ctx) => pool.callTool(def.server, def.tool, { ...args }, ctx),
      })
      registered.push({ wireName: def.wireName, server: def.server, tool: def.tool })
    } catch (error) {
      // One malformed remote tool must not drop its siblings: log-skip and continue.
      pool.warn(`mcp tool registration skipped (server '${server}' tool '${info.name}')`, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  live.set(server, registered)
  return registered.map((r) => r.wireName)
}

/** Convenience for a cold wiring: install a pool→registry bridge for every server. */
export function registerMcpTools(registry: ToolRegistry, pool: McpPool): Map<string, RegisteredMcpTool[]> {
  const live = new Map<string, RegisteredMcpTool[]>()
  pool.addToolsListener((name, tools) => {
    syncMcpTools(registry, live, name, tools, pool)
  })
  return live
}

export type { RegisteredMcpTool }
