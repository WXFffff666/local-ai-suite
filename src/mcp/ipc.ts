/**
 * ipc.ts — mcp:* handler factories (todo40). Registration stays in
 * src/main/ipc/handlers.ts (single IPC surface, ocr/ipc precedent); this
 * module owns validation + config persistence + pool side effects.
 *
 * Channel contract:
 *   mcp:listServers  {}                       -> McpListServersReply  (never spawns)
 *   mcp:upsertServer {name,command,args?,env?,enabled?} -> McpUpsertServerReply (config write + re-apply)
 *   mcp:removeServer {name}                   -> McpRemoveServerReply (stop + config drop)
 *   mcp:setEnabled   {name,enabled}           -> McpSetEnabledReply   (start / stop)
 *   mcp:listTools    {name}                   -> McpListToolsReply    (LAZY start on demand)
 *   mcp:callTool     {name,tool,args?}        -> McpCallToolReply     (Settings test button —
 *                                               SAME permission gate as the agent path, pool.callTool)
 *
 * The pool is the agent wiring's (absent until todo29's wiring builds it) —
 * honest not-ready while null.
 */

import { getConfig, setConfig } from '../main/storage/config'
import {
  mcpCallToolSchema,
  mcpListServersSchema,
  mcpListToolsSchema,
  mcpRemoveServerSchema,
  mcpSetEnabledSchema,
  mcpUpsertServerSchema,
  validatePayload,
  type McpCallToolInput,
  type McpUpsertServerInput,
} from '../main/ipc/schemas'
import type { HandlerContext } from '../main/ipc/handlers'
import type {
  McpCallToolReply,
  McpListServersReply,
  McpListToolsReply,
  McpRemoveServerReply,
  McpRequestError,
  McpServerView,
  McpSetEnabledReply,
  McpUpsertServerReply,
} from '../main/ipc/whitelist'
import { McpError } from './errors'
import type { McpServerEntry } from './types'
import { PermissionDeniedError } from '../agent/tools/fs/gating'
import type { McpPool } from './pool'

export type McpHandler = (args: unknown[], ctx: HandlerContext) => Promise<unknown>

/** The pool slice this lane consumes (structural for unit fakes). */
export type McpPoolSurface = Pick<
  McpPool,
  'status' | 'listTools' | 'callTool' | 'ensureStarted' | 'restartServer' | 'stopServer'
>

export type McpIpcDeps = {
  pool: () => McpPoolSurface | null
}

export type McpIpcChannel =
  | 'mcp:listServers'
  | 'mcp:upsertServer'
  | 'mcp:removeServer'
  | 'mcp:setEnabled'
  | 'mcp:listTools'
  | 'mcp:callTool'

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

const NOT_READY: McpListServersReply = { ok: false, error: 'not-ready' }

/** Debug-call audit identity: the gate records this callId like any agent call. */
const MCP_DEBUG_CALL_ID = 'mcp-debug'

function errorOf(error: unknown): { code: McpRequestError; detail?: string } {
  if (error instanceof PermissionDeniedError) return { code: 'permission-denied', detail: error.message }
  if (error instanceof McpError) return { code: error.code, detail: error.message }
  return { code: 'call-failed', detail: error instanceof Error ? error.message : String(error) }
}

function readServers(): Record<string, McpServerEntry> {
  return getConfig().mcpServers ?? {}
}

export function createMcpHandlers(deps: McpIpcDeps): Record<McpIpcChannel, McpHandler> {
  const serverView = (name: string): McpServerView | undefined =>
    deps.pool()?.status().find((s) => s.name === name)

  return {
    'mcp:listServers': async (args) => {
      const parsed = validatePayload(mcpListServersSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      const pool = deps.pool()
      if (pool === null) return NOT_READY
      const reply: McpListServersReply = { ok: true, servers: pool.status() }
      return reply
    },

    'mcp:upsertServer': async (args) => {
      const parsed = validatePayload(mcpUpsertServerSchema, first(args))
      if (!parsed.ok) return parsed
      const pool = deps.pool()
      if (pool === null) return NOT_READY
      const input = parsed.data as McpUpsertServerInput
      const nextEntry: McpServerEntry = {
        command: input.command,
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.env === undefined ? {} : { env: input.env }),
        enabled: input.enabled ?? true,
      }
      const servers = { ...readServers(), [input.name]: nextEntry }
      setConfig({ mcpServers: servers })
      // Re-apply the (possibly changed) config to the live runtime: stop first,
      // start only when enabled — disabled servers never spawn.
      pool.stopServer(input.name)
      if (nextEntry.enabled !== false) {
        try {
          await pool.ensureStarted(input.name)
        } catch {
          // start failure is a state, not a rejection: the view carries it (backoff/failed)
        }
      }
      const view = serverView(input.name)
      const reply: McpUpsertServerReply =
        view === undefined ? { ok: false, error: 'server-not-found' } : { ok: true, server: view }
      return reply
    },

    'mcp:removeServer': async (args) => {
      const parsed = validatePayload(mcpRemoveServerSchema, first(args))
      if (!parsed.ok) return parsed
      const pool = deps.pool()
      if (pool === null) return NOT_READY
      const { [parsed.data.name]: _dropped, ...rest } = readServers()
      setConfig({ mcpServers: rest })
      pool.stopServer(parsed.data.name)
      const reply: McpRemoveServerReply = { ok: true }
      return reply
    },

    'mcp:setEnabled': async (args) => {
      const parsed = validatePayload(mcpSetEnabledSchema, first(args))
      if (!parsed.ok) return parsed
      const pool = deps.pool()
      if (pool === null) return NOT_READY
      const { name, enabled } = parsed.data
      const current = readServers()[name]
      if (current === undefined) return { ok: false, error: 'server-not-found' } satisfies McpSetEnabledReply
      setConfig({ mcpServers: { ...readServers(), [name]: { ...current, enabled } } })
      if (!enabled) pool.stopServer(name)
      else {
        try {
          await pool.restartServer(name)
        } catch {
          // state (backoff/failed) rides the reply view
        }
      }
      const view = serverView(name)
      const reply: McpSetEnabledReply =
        view === undefined ? { ok: false, error: 'server-not-found' } : { ok: true, server: view }
      return reply
    },

    'mcp:listTools': async (args) => {
      const parsed = validatePayload(mcpListToolsSchema, first(args))
      if (!parsed.ok) return parsed
      const pool = deps.pool()
      if (pool === null) return NOT_READY
      try {
        const tools = await pool.listTools(parsed.data.name)
        const reply: McpListToolsReply = {
          ok: true,
          tools: tools.map((t) => ({ name: t.name, ...(t.description === undefined ? {} : { description: t.description }) })),
        }
        return reply
      } catch (error) {
        const { code } = errorOf(error)
        const reply: McpListToolsReply = { ok: false, error: code }
        return reply
      }
    },

    'mcp:callTool': async (args) => {
      const parsed = validatePayload(mcpCallToolSchema, first(args))
      if (!parsed.ok) return parsed
      const pool = deps.pool()
      if (pool === null) return NOT_READY
      const input = parsed.data as McpCallToolInput
      try {
        const result = await pool.callTool(input.name, input.tool, input.args ?? {}, {
          callId: MCP_DEBUG_CALL_ID,
          signal: AbortSignal.timeout(120_000),
          reportPhase: () => undefined,
        })
        const reply: McpCallToolReply = { ok: true, result }
        return reply
      } catch (error) {
        const { code, detail } = errorOf(error)
        const reply: McpCallToolReply = { ok: false, error: code, ...(detail === undefined ? {} : { detail }) }
        return reply
      }
    },
  }
}

