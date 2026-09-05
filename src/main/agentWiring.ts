/**
 * agentWiring.ts — todo29 main-process wiring: the single place that fuses
 * the permission engine (todo24), the approval bridge (todo25), the fs/shell
 * tool sets (todo27/28) and the session registry (todo23) into the two
 * HandlerDeps seams (agent / permission). Lives in the index.ts layer:
 * services.ts is NOT touched (lane-30 owns it); every Electron-facing
 * capability arrives through the injected deps, so this whole module is
 * unit-testable with plain fakes (same discipline as permissionBridge.ts).
 *
 * Upstream rule: the renderer never dials sidecar ports — agent:start's
 * baseUrl placeholder is REWRITTEN here via resolveUpstream (the same
 * two-legal-source rule as ChatRelay: external-takeover :11434 or the
 * internal llama sidecar on its resolved port).
 *
 * Grant persistence (todo25 DoneClaim contract): session/always choices
 * become PermissionEngine rules — fs.shell via shellGrantSuggestion
 * (`Bash(<prog>:*)` word-boundary prefix), every other kind via the policy
 * draft builder `${RULE_KEYWORDS[kind]}(${actionValue(action)})`, which is
 * exactly the rule text the dialog previews (alignment asserted in tests).
 */
import type { AgentSessions as AgentSessionsClass, AgentStartAck, AgentStartRequest } from '../agent/runner/sessions'
import { AgentSessions } from '../agent/runner/sessions'
import type { AgentEvent, AgentSessionStatus } from '../agent/runner/types'
import { PermissionEngine } from '../agent/policy/engine'
import { RULE_KEYWORDS, actionValue } from '../agent/policy/rules'
import type { PermissionAction } from '../agent/policy/types'
import { ToolRegistry, registerFileTools, registerShellTools, registerWebTools, shellGrantSuggestion, type PermissionPort } from '../agent/tools'
import type { WebSearchExecutor } from '../agent/tools/web'
import { McpPool } from '../mcp/pool'
import { registerMcpTools } from '../mcp/tools'
import type { McpSdkSurface, McpServersMap, McpStatusEvent } from '../mcp/types'
import { createPermissionBridge, type PermissionBridge } from './ipc/permissionBridge'
import type { PermissionPreview, PermissionRequestEvent, AgentTermEvent } from './ipc/whitelist'

/** Both AgentSessions seams are structural subsets of the class surface. */
export type AgentSurface = Pick<AgentSessionsClass, 'start' | 'cancel' | 'status'>
export type PermissionSurface = Pick<PermissionBridge, 'respond'>

export type AgentWiringLogger = {
  warn(msg: string, meta?: Readonly<Record<string, unknown>>): void
}

export type AgentWiringDeps = {
  engine: PermissionEngine
  /** Workspace root handed to the todo27/28 path fences. */
  workspaceRoot: string
  /** todo26 jail tier: 'native' when the Job Object probe succeeds, else 'off' (bare run + honest warning). */
  jailMode: 'native' | 'off'
  /** Deliver 'permission:request' to the UI (focused window's webContents in index.ts). */
  sendPermission: (event: PermissionRequestEvent) => void
  /** Deliver streamed shell output on 'agent:term'. */
  sendTerm: (event: AgentTermEvent) => void
  /** Resolve the OpenAI-compatible upstream origin (127.0.0.1 only). Rejects when no engine is available. */
  resolveUpstream: () => Promise<string>
  /**
   * 阶段5：web_search 工具执行器（搜索编排器）。ABSENT ⇒ 不注册 web 工具
   *（与 mcpServers 同一诚实降级模式）。
   */
  search?: WebSearchExecutor
  log?: AgentWiringLogger
  /**
   * todo40: config.json mcpServers reader. ABSENT ⇒ no pool is built (unit
   * tests and degraded boots keep the pre-todo40 surface); present ⇒ the pool
   * is constructed here because gating needs THIS lane's PermissionPort.
   */
  mcpServers?: () => McpServersMap
  /** SDK seam (tests inject a fake @modelcontextprotocol/sdk surface). */
  loadMcpSdk?: () => Promise<McpSdkSurface>
  /** 'mcp:status' fanout (index.ts broadcasts to every renderer frame). */
  sendMcpStatus?: (event: McpStatusEvent) => void
}

export type AgentWiring = {
  agent: AgentSurface
  permission: PermissionSurface
  /** todo40: live MCP pool (null when deps.mcpServers was absent). */
  mcp: McpPool | null
  /** Drop session-scope grants (app quit; persisted rules and audit stay). */
  dispose(): void
}

function targetValue(action: PermissionAction): string {
  return actionValue(action)
}

/** The rule text an 'always'/'session' grant persists for this action. */
export function grantRuleText(action: PermissionAction): string {
  if (action.type === 'fs.shell') {
    const cmd = typeof action.target === 'string' ? action.target : (action.target.cmd ?? '')
    return shellGrantSuggestion(cmd)
  }
  return `${RULE_KEYWORDS[action.type]}(${targetValue(action)})`
}

/**
 * Dialog preview from the action alone. Deviation (documented for lane 27):
 * PermissionPort.ask only receives the action, so write previews carry the
 * path with empty old/new text — the full diff preview needs the args plumbed
 * into ask(), a gating.ts contract change outside this lane.
 */
export function previewFor(action: PermissionAction, workspaceRoot: string): PermissionPreview {
  switch (action.type) {
    case 'fs.shell': {
      const cmd = typeof action.target === 'string' ? action.target : (action.target.cmd ?? '')
      return { kind: 'command', cmd, workspacePath: workspaceRoot }
    }
    case 'net': {
      const t = typeof action.target === 'string' ? { host: action.target } : action.target
      const path = t?.path
      return path === undefined || path === '' ? { kind: 'net', host: t?.host ?? '' } : { kind: 'net', host: t?.host ?? '', path }
    }
    case 'mcp':
      return { kind: 'command', cmd: `MCP ${targetValue(action)}`, workspacePath: workspaceRoot }
    default: {
      const path = typeof action.target === 'string' ? action.target : (action.target.path ?? '')
      return { kind: 'diff', path, oldText: '', newText: '', workspacePath: workspaceRoot }
    }
  }
}

/** Engine + bridge → the PermissionPort the todo27/28 gate() funnel consumes. */
export function createPermissionPort(deps: AgentWiringDeps, bridge: PermissionBridge): PermissionPort {
  const { engine } = deps
  return {
    evaluate: (action) => engine.evaluate(action),
    assess: (action) => engine.assess(action),
    record: (action, assessment, detail) => engine.record(action, assessment, detail),
    ask: async (action, signal) => {
      const choice = await bridge.requestDecision({
        action,
        assessment: engine.assess(action),
        preview: previewFor(action, deps.workspaceRoot),
        signal,
      })
      return choice === 'deny' ? 'deny' : 'allow'
    },
  }
}

/**
 * AgentSessions wrapped with the todo29 responsibilities:
 *  - baseUrl rewrite (renderer placeholder → main-resolved upstream)
 *  - async upstream resolution with a synchronous, deduping ack
 *  - stop-during-startup (cancel before the loop ever begins)
 */
export function createAgentSurface(
  sessions: AgentSessions,
  resolveUpstream: () => Promise<string>,
  log?: AgentWiringLogger,
): AgentSurface {
  type Pending = { readonly snapshot: AgentSessionStatus; started: boolean }
  const pending = new Map<string, Pending>()
  const cancelledWhilePending = new Set<string>()

  const finish = (sessionId: string): void => {
    pending.delete(sessionId)
  }

  return {
    start(req: AgentStartRequest, emit: (event: AgentEvent) => void): AgentStartAck {
      if (pending.has(req.sessionId) || sessions.status(req.sessionId).status?.state === 'running') {
        return { ok: false, error: 'session-already-running' }
      }
      if (req.model === undefined) return { ok: false, error: 'model-not-selected' }
      const record: Pending = {
        snapshot: { sessionId: req.sessionId, state: 'running', iterations: 0, updatedAt: Date.now() },
        started: false,
      }
      pending.set(req.sessionId, record)
      void (async (): Promise<void> => {
        let baseUrl: string
        try {
          baseUrl = await resolveUpstream()
        } catch (error) {
          finish(req.sessionId)
          const message = error instanceof Error ? error.message : String(error)
          emit({ type: 'error', sessionId: req.sessionId, code: 'upstream-transport', message, iteration: 0 })
          return
        }
        if (cancelledWhilePending.delete(req.sessionId)) {
          finish(req.sessionId)
          return
        }
        const ack = sessions.start(
          { ...req, baseUrl },
          (event: AgentEvent): void => {
            if (event.type === 'finished' || event.type === 'error') finish(req.sessionId)
            emit(event)
          },
        )
        if (!ack.ok) {
          finish(req.sessionId)
          log?.warn('agent start rejected after upstream resolve', { error: ack.error })
          emit({ type: 'error', sessionId: req.sessionId, code: 'upstream-transport', message: ack.error, iteration: 0 })
          return
        }
        record.started = true
      })().catch((error: unknown) => {
        finish(req.sessionId)
        const message = error instanceof Error ? error.message : String(error)
        emit({ type: 'error', sessionId: req.sessionId, code: 'upstream-transport', message, iteration: 0 })
      })
      return { ok: true, sessionId: req.sessionId, started: true }
    },
    cancel(sessionId: string) {
      const record = pending.get(sessionId)
      if (record !== undefined && !record.started) {
        cancelledWhilePending.add(sessionId)
        pending.delete(sessionId)
        return { ok: true, sessionId, cancelled: true }
      }
      return sessions.cancel(sessionId)
    },
    status(sessionId: string) {
      const real = sessions.status(sessionId)
      if (real.status !== null) return real
      const record = pending.get(sessionId)
      return { ok: true, status: record === undefined ? null : { ...record.snapshot } }
    },
  }
}

export function buildAgentWiring(deps: AgentWiringDeps): AgentWiring {
  const bridge = createPermissionBridge({
    send: deps.sendPermission,
    onGrant: (grant) => {
      deps.engine.addRule({
        kind: grant.action.type,
        rule: grantRuleText(grant.action),
        scope: grant.choice,
        decision: 'allow',
      })
    },
  })
  const port = createPermissionPort(deps, bridge)

  const registry = new ToolRegistry()
  registerFileTools(registry, { workspaceRoot: deps.workspaceRoot, permission: port, log: deps.log })
  registerShellTools(registry, {
    workspaceRoot: deps.workspaceRoot,
    permission: port,
    jailMode: deps.jailMode,
    log: deps.log,
    onChunk: (callId, chunk) => deps.sendTerm({ id: callId, chunk: chunk.data }),
    onJailWarning: (warning) => deps.log?.warn('agent jail degraded', { area: warning.area, message: warning.message }),
  })
  if (deps.search !== undefined) {
    registerWebTools(registry, { search: deps.search, permission: port })
  }

  const sessions = new AgentSessions(registry)
  const agent = createAgentSurface(sessions, deps.resolveUpstream, deps.log)

  // todo40: the MCP pool rides THIS lane because every remote call gates
  // through the port above. Construction spawns nothing; startEnabled kicks
  // only the servers the user enabled (lazy posture = ocr/speech precedent).
  let mcp: McpPool | null = null
  if (deps.mcpServers !== undefined) {
    mcp = new McpPool({
      readServers: deps.mcpServers,
      permission: port,
      log: deps.log,
      ...(deps.loadMcpSdk === undefined ? {} : { loadSdk: deps.loadMcpSdk }),
    })
    registerMcpTools(registry, mcp)
    if (deps.sendMcpStatus !== undefined) mcp.subscribe(deps.sendMcpStatus)
    mcp.startEnabled()
  }
  return {
    agent,
    permission: bridge,
    mcp,
    dispose: () => {
      mcp?.stopAll()
      deps.engine.destroy()
    },
  }
}
