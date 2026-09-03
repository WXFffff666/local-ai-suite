/**
 * types.ts — MCP stdio client domain types (todo40). Pure module: no SDK
 * import (the ESM-only @modelcontextprotocol/sdk crosses into pool.ts ONLY
 * through the injected McpSdkSurface seam — R3b: CJS main loads it lazily via
 * `await import()`, so nothing here may reference SDK value types; the
 * structural mirrors below are the contract both fakes and the real client
 * satisfy).
 *
 * Config lives in config.json under `mcpServers: { name: McpServerEntry }`
 * (schemaVersion-tolerant reader in storage/config.ts; every wire payload is
 * zod-gated at the IPC boundary in src/main/ipc/schemas.ts, NOT here).
 */

import type { JsonObject, JsonValue } from '../agent/runner/types'
import type { PermissionPort } from '../agent/tools/fs/gating'

// --- config (config.json `mcpServers`) ----------------------------------------

export type McpServerEntry = {
  /** executable the stdio server runs as (spawn target, e.g. 'npx', 'node') */
  command: string
  args?: string[]
  /** extra env for the child; plaintext on disk (same posture as every MCP desktop client) */
  env?: Record<string, string>
  /** disabled servers never spawn and expose no tools; default true */
  enabled?: boolean
}

export type McpServersMap = Readonly<Record<string, McpServerEntry>>

// --- lifecycle state machine ----------------------------------------------------
// Mirror of SidecarManager's terminal-'failed' semantics: crash → exponential
// backoff restart up to MAX_MCP_RESTARTS, budget exhausted (or a restart-start
// rejected) → 'failed' forever until an explicit user restart.

export const MCP_SERVER_STATES = ['stopped', 'starting', 'running', 'backoff', 'failed'] as const
export type McpServerState = (typeof MCP_SERVER_STATES)[number]

/** Crash-restart budget (plan todo40: 「连续 3 次后置 failed」). */
export const MAX_MCP_RESTARTS = 3
/** Backoff base — same 500ms·2^(n-1) curve as SidecarManager (core/SidecarManager.ts). */
export const MCP_RESTART_BASE_MS = 500

/** 'mcp:status' event payload (main -> renderer; every state transition). */
export type McpStatusEvent = {
  readonly name: string
  readonly state: McpServerState
  /** last spawn/protocol error for the failed-state tooltip; absent on clean states */
  readonly error?: string
}

/** Pool-side view of one configured server (mcp:listServers row). */
export type McpServerView = {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  /** env KEYS only — values never cross the IPC boundary (Settings renders names, the child gets values from the pool). */
  readonly envKeys: readonly string[]
  readonly enabled: boolean
  readonly state: McpServerState
  /** tools/list count once the server has connected at least time this process; null before */
  readonly toolCount: number | null
  /** last error text (spawn failure / protocol close) for the failed-state tooltip */
  readonly lastError: string | null
}

// --- remote tool surface ---------------------------------------------------------

/** One tools/list entry as the pool consumes it (SDK shape mirrored). */
export type McpToolInfo = {
  readonly name: string
  readonly description?: string
  /** remote JSON Schema — untrusted, MUST pass through sanitizeToolSchema() before reaching the registry */
  readonly inputSchema?: JsonValue
}

export type McpCallToolResult = {
  readonly content?: readonly JsonValue[]
  readonly isError?: boolean
}

// --- SDK structural seam --------------------------------------------------------
// Mirrors ONLY the calls we make on @modelcontextprotocol/sdk (value types are
// off-limits here: ESM-only package, lazy-loaded in pool/sdk layer, fakeable in
// tests by plain objects). The real class satisfies this shape by construction;
// loadMcpSdk() casts once at the module boundary.

export type McpSdkListToolsResult = {
  readonly tools: readonly {
    readonly name: string
    readonly description?: string
    readonly inputSchema?: unknown
  }[]
  readonly nextCursor?: string
}

export type McpSdkClient = {
  connect(transport: unknown): Promise<void>
  close(): Promise<void>
  listTools(params?: { readonly cursor?: string }): Promise<McpSdkListToolsResult>
  callTool(
    params: { readonly name: string; readonly arguments?: Record<string, unknown> },
    /** the SDK's 2nd positional arg is the RESULT SCHEMA (defaults when undefined) — options are 3rd */
    resultSchema: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<McpCallToolResult>
  /** protocol close (child exited / transport died) — the pool's crash signal */
  onclose: (() => void) | undefined
}

export type McpSdkStdioParams = {
  readonly command: string
  readonly args?: string[]
  readonly env?: Record<string, string>
  readonly stderr?: 'pipe' | 'inherit' | 'overlap'
}

export type McpSdkSurface = {
  readonly Client: new (info: { name: string; version: string }) => McpSdkClient
  readonly StdioClientTransport: new (params: McpSdkStdioParams) => unknown
}

// --- pool runtime bookkeeping (pure; consumed by pool.ts) ----------------------

export type ServerRuntime = {
  state: McpServerState
  client: McpSdkClient | null
  tools: McpToolInfo[] | null
  restarts: number
  backoffTimer: NodeJS.Timeout | null
  lastError: string | null
  /** shared in-flight start (dedupes concurrent ensureStarted callers) */
  starting: Promise<void> | null
  /** true while WE close the client (no crash reaction on intentional stops) */
  closing: boolean
  /** invalidates async results of superseded starts/stops (SidecarManager opId pattern) */
  epoch: number
}

export function emptyRuntime(): ServerRuntime {
  return {
    state: 'stopped', client: null, tools: null, restarts: 0, backoffTimer: null,
    lastError: null, starting: null, closing: false, epoch: 0,
  }
}

/** timer.unref so a pending backoff never holds the event loop open (SidecarManager precedent). */
export function unrefMcpTimer(timer: NodeJS.Timeout): void {
  timer.unref()
}

// --- pool deps / listeners -------------------------------------------------------

export type McpPoolLogger = {
  warn(msg: string, meta?: Readonly<Record<string, unknown>>): void
}

export type McpPoolDeps = {
  /** fresh read per access (config.json is the truth; upserts land immediately) */
  readServers: () => McpServersMap
  permission: PermissionPort
  /** SDK seam: tests hand a fake surface; prod default is the lazy dynamic import. */
  loadSdk?: () => Promise<McpSdkSurface>
  /** tool-set change per server ([] on stop/disable/failure) — feeds the registry sync. */
  onToolsChanged?: (name: string, tools: readonly McpToolInfo[]) => void
  log?: McpPoolLogger
  maxRestarts?: number
  restartBaseMs?: number
}

export type McpPoolListener = (event: McpStatusEvent) => void

// --- schema sanitization -----------------------------------------------------------
// OpenAI strict-mode contract (registry.assertStrictToolSchema): parameters must
// be {type:'object', additionalProperties:false, required:[every property]}.
// MCP only requires inputSchema to be a valid JSON Schema — servers may declare
// optional properties or omit the object scaffolding entirely. The sanitizer is
// the DERIVATION: keep the declared properties (types/descriptions survive),
// force object+additionalProperties:false, mark every property required, and
// recurse into nested object subschemas. Anything unrecognisable degrades to
// the zero-property schema (the model can still call the tool with {} and the
// server validates the real input — strict mode is an API-shape contract, not a
// trust gate). $ref/definitions are NOT resolved (rare in practice; documented
// limitation — such tools surface with the empty-params fallback).

export const EMPTY_STRICT_SCHEMA: JsonObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

function isJsonObjectValue(value: JsonObject | readonly JsonValue[]): value is JsonObject {
  return !Array.isArray(value)
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate: JsonObject | readonly JsonValue[] = value
  return isJsonObjectValue(candidate) ? candidate : undefined
}

export function sanitizeToolSchema(raw: JsonValue | undefined): JsonObject {
  const schema = asObject(raw)
  if (schema === undefined) return { ...EMPTY_STRICT_SCHEMA }
  const declaredType = schema['type']
  if (declaredType !== 'object') return { ...EMPTY_STRICT_SCHEMA }
  const properties = asObject(schema['properties'])
  if (properties === undefined || Object.keys(properties).length === 0) {
    return { ...EMPTY_STRICT_SCHEMA, ...(typeof schema['description'] === 'string' ? { description: schema['description'] } : {}) }
  }
  const sanitizedProps: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(properties)) {
    const prop = asObject(value)
    // Nested objects recurse through the same strict derivation; every other
    // subschema (scalar/array/enum) is already strict-mode legal as declared.
    sanitizedProps[key] = prop !== undefined && prop['type'] === 'object' ? sanitizeToolSchema(value) : value
  }
  return {
    ...schema,
    type: 'object',
    properties: sanitizedProps,
    additionalProperties: false,
    required: Object.keys(sanitizedProps),
  }
}

// --- wire tool naming ----------------------------------------------------------
// Registry names must be unique across servers and OpenAI-safe
// ([a-zA-Z0-9_-], ≤64 chars). `<server>__<tool>` carries both identities;
// the permission rule stays `MCP(<server>:<tool>)` regardless (target fields,
// not the wire name, are the policy truth).

function sanitizeNamePart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function mcpWireToolName(server: string, tool: string): string {
  const prefix = `mcp_${sanitizeNamePart(server)}__`
  const name = prefix + sanitizeNamePart(tool)
  return name.length <= 64 ? name : name.slice(0, 64)
}

/** Server name grammar (rule text + wire names embed it; zod mirrors this). */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/

export function isMcpServerName(value: string): boolean {
  return MCP_SERVER_NAME_RE.test(value)
}
