/**
 * pool.ts — McpPool: the stdio server lifecycle manager (todo40). One runtime
 * slot per configured server; NOTHING spawns until a server is first needed
 * (startEnabled kick for user-enabled servers at wiring time, ensureStarted on
 * first listTools/callTool). Crash semantics deliberately mirror
 * core/SidecarManager.ts: exponential backoff 500ms·2^(n-1), budget
 * MAX_MCP_RESTARTS=3, exhaustion → terminal 'failed' (auto-restart stops,
 * further calls are honest McpError('server-failed')) until an explicit
 * restartServer() from the Settings UI clears the budget. Listener API
 * (subscribe → unsubscribe fn) feeds the 'mcp:status' broadcast.
 *
 * Every tools/call crosses gate() with {type:'mcp', target:'<server>:<tool>'}
 * BEFORE anything is spawned or executed (audit row via the gate funnel itself;
 * denial surfaces as PermissionDeniedError → structured error upstream).
 */

import { gate } from '../agent/tools/fs/gating'
import type { ToolExecutionContext } from '../agent/runner/types'
import { McpError } from './errors'
import { fetchAllTools, loadMcpSdk, openStdioClient, toolResultText } from './sdk'
import {
  emptyRuntime,
  MAX_MCP_RESTARTS,
  MCP_RESTART_BASE_MS,
  type McpPoolDeps,
  type McpPoolListener,
  type McpSdkClient,
  type McpServerEntry,
  type McpServerState,
  type McpServerView,
  type McpStatusEvent,
  type McpToolInfo,
  type ServerRuntime,
  unrefMcpTimer,
} from './types'

export type { McpPoolDeps, McpPoolLogger, McpPoolListener } from './types'

export class McpPool {
  private readonly deps: McpPoolDeps
  private readonly runtimes = new Map<string, ServerRuntime>()
  private readonly listeners = new Set<McpPoolListener>()
  private readonly toolsListeners = new Set<(name: string, tools: readonly McpToolInfo[]) => void>()
  private closed = false

  constructor(deps: McpPoolDeps) {
    this.deps = deps
  }

  /** Subscribe to status transitions. Returns an unsubscribe fn (SidecarManager.onSidecarEvent shape). */
  subscribe(listener: McpPoolListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Tool-set listeners (registry bridge, tools.ts). Deps.onToolsChanged stays for single-owner tests. */
  addToolsListener(listener: (name: string, tools: readonly McpToolInfo[]) => void): () => void {
    this.toolsListeners.add(listener)
    return () => {
      this.toolsListeners.delete(listener)
    }
  }

  warn(msg: string, meta?: Readonly<Record<string, unknown>>): void {
    this.deps.log?.warn(msg, meta)
  }

  private emitTools(name: string, tools: readonly McpToolInfo[]): void {
    this.deps.onToolsChanged?.(name, tools)
    for (const listener of [...this.toolsListeners]) {
      try {
        listener(name, tools)
      } catch {
        // listener faults never break the lifecycle
      }
    }
  }

  status(): McpServerView[] {
    return Object.entries(this.deps.readServers()).map(([name, entry]) => this.view(name, entry))
  }

  view(name: string, entry: McpServerEntry): McpServerView {
    const rt = this.runtimes.get(name) ?? emptyRuntime()
    return {
      name,
      command: entry.command,
      args: entry.args ?? [],
      envKeys: Object.keys(entry.env ?? {}),
      enabled: entry.enabled !== false,
      state: rt.state,
      toolCount: rt.tools === null ? null : rt.tools.length,
      lastError: rt.lastError,
    }
  }

  /** Boot kick for every enabled server (fire-and-forget; failures converge to backoff→failed). */
  startEnabled(): void {
    for (const [name, entry] of Object.entries(this.deps.readServers())) {
      if (entry.enabled !== false) void this.ensureStarted(name).catch(() => undefined)
    }
  }

  async ensureStarted(name: string): Promise<void> {
    const entry = this.requireEnabled(name)
    const rt = this.runtime(name)
    if (rt.state === 'failed') {
      throw new McpError('server-failed', `mcp server '${name}' is failed — restart it in Settings`)
    }
    if (rt.state === 'running' && rt.client !== null) return
    if (rt.starting !== null) return rt.starting
    if (rt.state === 'backoff') this.cancelBackoff(rt) // a user call restarts NOW, mid-backoff
    const run = this.doStart(name, entry, rt)
    rt.starting = run
    try {
      await run
    } finally {
      if (rt.starting === run) rt.starting = null
    }
  }

  /** tools/list (lazy start included). Cached on the runtime; registry sync fires on change. */
  async listTools(name: string): Promise<readonly McpToolInfo[]> {
    await this.ensureStarted(name)
    const tools = this.runtimes.get(name)?.tools ?? []
    return tools
  }

  /** The single gated execution funnel: permission BEFORE spawn, audit via gate(). */
  async callTool(name: string, tool: string, args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown> {
    this.requireEnabled(name)
    // gate records the audit row itself; a denial throws PermissionDeniedError
    // (runner → failed tool_result; mcp/ipc.ts → structured 'permission-denied').
    await gate(this.deps.permission, { type: 'mcp', target: `${name}:${tool}` }, ctx)
    await this.ensureStarted(name)
    const rt = this.runtime(name)
    if (rt.client === null) throw new McpError('server-start-failed', `mcp server '${name}' has no live client`)
    if (rt.tools !== null && !rt.tools.some((t) => t.name === tool)) {
      throw new McpError('tool-not-found', `mcp server '${name}' has no tool '${tool}'`)
    }
    ctx.reportPhase('running')
    let result: Awaited<ReturnType<McpSdkClient['callTool']>>
    try {
      // undefined resultSchema keeps the SDK's default CallToolResultSchema —
      // options live in the THIRD positional (seam mirrors the real signature).
      result = await rt.client.callTool({ name: tool, arguments: args }, undefined, { signal: ctx.signal })
    } catch (error) {
      throw new McpError('call-failed', `mcp ${name}:${tool} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (result.isError === true) {
      throw new McpError('call-failed', `mcp ${name}:${tool} returned an error: ${toolResultText(result.content) || 'unknown tool error'}`)
    }
    return result
  }

  /** Settings restart gesture (failed-state button): budget reset + start now. */
  async restartServer(name: string): Promise<void> {
    this.requireEnabled(name)
    const rt = this.runtime(name)
    this.cancelBackoff(rt)
    if (rt.state === 'failed') {
      await this.stopRuntime(name, rt)
      rt.restarts = 0
      rt.lastError = null
      this.setState(name, rt, 'stopped')
    }
    await this.ensureStarted(name)
  }

  stopServer(name: string): void {
    const rt = this.runtimes.get(name)
    if (rt === undefined) return
    void this.stopRuntime(name, rt)
  }

  stopAll(): void {
    this.closed = true
    for (const [name, rt] of this.runtimes) {
      this.cancelBackoff(rt)
      void this.stopRuntime(name, rt)
    }
  }

  // --- internals ---------------------------------------------------------------

  private requireEnabled(name: string): McpServerEntry {
    const entry = this.deps.readServers()[name]
    if (entry === undefined) throw new McpError('server-not-found', `mcp server '${name}' is not configured`)
    if (entry.enabled === false) throw new McpError('server-disabled', `mcp server '${name}' is disabled`)
    return entry
  }

  private runtime(name: string): ServerRuntime {
    let rt = this.runtimes.get(name)
    if (rt === undefined) {
      rt = emptyRuntime()
      this.runtimes.set(name, rt)
    }
    return rt
  }

  private async doStart(name: string, entry: McpServerEntry, rt: ServerRuntime): Promise<void> {
    const epoch = rt.epoch
    this.setState(name, rt, 'starting')
    try {
      const sdk = await (this.deps.loadSdk ?? loadMcpSdk)()
      const client = await openStdioClient(sdk, entry)
      const tools = await fetchAllTools(client)
      if (this.superseded(rt, epoch)) {
        await client.close().catch(() => undefined)
        return
      }
      rt.client = client
      rt.tools = [...tools]
      rt.lastError = null
      // restarts is deliberately NOT reset here (SidecarManager cumulative-
      // budget posture: a connect-then-crash loop must still converge to
      // terminal 'failed'; only restartServer() clears the budget).
      client.onclose = () => {
        if (!rt.closing && rt.epoch === epoch) this.handleCrash(name, rt, 'server process exited')
      }
      this.emitTools(name, rt.tools)
      this.setState(name, rt, 'running')
    } catch (error) {
      if (this.superseded(rt, epoch)) return
      const message = error instanceof Error ? error.message : String(error)
      rt.lastError = message
      // A never-started server still burns the crash budget (bad command must
      // converge to terminal 'failed', not retry on every call forever);
      // handleCrash owns the state exit (backoff | failed).
      this.handleCrash(name, rt, message)
      throw new McpError('server-start-failed', `mcp server '${name}' failed to start: ${message}`)
    }
  }

  private superseded(rt: ServerRuntime, epoch: number): boolean {
    return rt.epoch !== epoch || this.closed
  }

  /** The ONLY auto-restart path: budget check → backoff schedule → terminal failed. */
  private handleCrash(name: string, rt: ServerRuntime, errorText: string): void {
    if (rt.state === 'failed' || this.closed) return
    // A second crash signal while already backing off is the SAME failure —
    // the pending timer owns the retry; do not double-burn the budget.
    if (rt.state === 'backoff') return
    rt.tools = null
    this.emitTools(name, [])
    if (rt.restarts >= (this.deps.maxRestarts ?? MAX_MCP_RESTARTS)) {
      rt.lastError = errorText
      this.setState(name, rt, 'failed')
      this.deps.log?.warn(`mcp server '${name}' restart budget exhausted — terminal failed`, { error: errorText })
      return
    }
    rt.restarts += 1
    rt.lastError = errorText
    const delayMs = (this.deps.restartBaseMs ?? MCP_RESTART_BASE_MS) * 2 ** (rt.restarts - 1)
    this.setState(name, rt, 'backoff')
    rt.backoffTimer = setTimeout(() => {
      rt.backoffTimer = null
      const entry = this.deps.readServers()[name]
      if (entry === undefined || entry.enabled === false || this.closed) return
      const start = this.doStart(name, entry, rt)
      rt.starting = start
      // Background retry: the rejection is already reflected in the state
      // machine (backoff/failed) — swallowing it here keeps startEnabled and
      // timer-driven starts out of the unhandled-rejection lane.
      void start.catch(() => undefined).finally(() => {
        if (rt.starting === start) rt.starting = null
      })
    }, delayMs)
    unrefMcpTimer(rt.backoffTimer)
  }

  private async stopRuntime(name: string, rt: ServerRuntime): Promise<void> {
    rt.epoch += 1
    this.cancelBackoff(rt)
    rt.starting = null
    rt.closing = true
    const client = rt.client
    rt.client = null
    rt.tools = null
    this.emitTools(name, [])
    // State flips synchronously (the caller sees 'stopped' the moment the
    // close was initiated — the wire close is fire-and-forget teardown). On
    // pool shutdown (closed) the view must still read 'stopped', just silently.
    if (rt.state !== 'failed') this.setState(name, rt, 'stopped', !this.closed)
    if (client !== null) await client.close().catch(() => undefined)
    rt.closing = false
  }

  private cancelBackoff(rt: ServerRuntime): void {
    if (rt.backoffTimer !== null) {
      clearTimeout(rt.backoffTimer)
      rt.backoffTimer = null
    }
  }

  private setState(name: string, rt: ServerRuntime, state: McpServerState, emit = true): void {
    rt.state = state
    if (!emit) return
    const event: McpStatusEvent = { name, state, ...(rt.lastError === null ? {} : { error: rt.lastError }) }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // a broken listener never breaks the lifecycle (SidecarManager.emitEvent posture)
      }
    }
  }
}
