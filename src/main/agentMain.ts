/**
 * agentMain.ts — todo29 index.ts-layer glue: builds the AgentWiring
 * (src/main/agentWiring.ts) against the LIVE Electron surfaces and owns the
 * lazy singleton + shutdown hook. services.ts is untouched (lane-30 owner);
 * everything here rides exported factories only.
 *
 * Lazy posture mirrors createConversationService: the permission engine
 * opens chat.db on first use, the workspace dir is created on first use,
 * and the upstream is resolved per agent:start (external-takeover :11434 or
 * the internal llama-server on its resolved dynamic port — the two legal
 * sources from todo10/11; the embedded facade is never self-called).
 * A build failure (db/native module) pins the channels to the honest
 * not-ready shape forever, logged once — never retried per invoke.
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { SidecarStatus } from '../core/types'
import { SIDECAR_HOST } from '../core/types'
import { isAvailable as jailIsAvailable } from '../agent/jail'
import { PermissionEngine } from '../agent/policy/engine'
import { getConfig } from './storage/config'
import { getDb } from './storage/db'
import { getMainLogger } from './logger'
import { registerShutdownHook } from './shutdown'
import { buildAgentWiring, type AgentWiring } from './agentWiring'
import type { WebSearchExecutor } from '../agent/tools/web'
import type { ApiServerStatus } from './apiServer'
import { assertAllowedEventChannel } from './ipc/whitelist'

export type AgentMainDeps = {
  /** Main window getter (fallback target when nothing holds focus). */
  getMainWindow: () => BrowserWindow | null
  /** Live 11434 arbitration result (null while bootstrapApiServer is pending). */
  getApiStatus: () => ApiServerStatus | null
  /** Services-surface splice: only the llama sidecar is ever ensured. */
  ensureSidecar: (name: 'llama') => Promise<SidecarStatus>
  /** 阶段5：web_search 工具执行器（absent ⇒ 工具不注册） */
  search?: WebSearchExecutor
}

export function createAgentMain(deps: AgentMainDeps): () => AgentWiring | null {
  const log = getMainLogger()
  let wiring: AgentWiring | null = null
  let failed = false

  const sendToUi = (channel: 'permission:request' | 'agent:term', payload: unknown): void => {
    // Defense in depth: the whitelist gate is the single event truth (todo8).
    assertAllowedEventChannel(channel)
    // focused window first: the approval prompt must follow the user (plan
    // 29 no-unattended posture); fall back to the main window.
    const win = BrowserWindow.getFocusedWindow() ?? deps.getMainWindow()
    if (win !== null && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // todo40: 'mcp:status' is app-wide chrome (Settings badges, like update:state)
  // — every live frame gets every transition, not just the focused one.
  const sendMcpStatus = (event: import('../mcp/types').McpStatusEvent): void => {
    assertAllowedEventChannel('mcp:status')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send('mcp:status', event)
    }
  }

  const resolveUpstream = async (): Promise<string> => {
    const s = deps.getApiStatus()
    if (s !== null && s.mode === 'external-takeover') return `http://${SIDECAR_HOST}:${s.port}`
    const status = await deps.ensureSidecar('llama')
    if (!status.running) throw new Error(`llama-server unavailable (state: ${status.state})`)
    return `http://${SIDECAR_HOST}:${status.port}`
  }

  return () => {
    if (wiring !== null || failed) return wiring
    try {
      const workspaceRoot = join(app.getPath('userData'), 'agent-workspace')
      mkdirSync(workspaceRoot, { recursive: true })
      wiring = buildAgentWiring({
        engine: new PermissionEngine(getDb()),
        workspaceRoot,
        // Deviation (recorded): config.json has no engine jailEnabled field
        // (todo24 left it out) — probe the native Job Object tier and degrade
        // to 'off' when unavailable; onJailWarning lands in the main log,
        // never silently.
        jailMode: jailIsAvailable() ? 'native' : 'off',
        sendPermission: (event) => sendToUi('permission:request', event),
        sendTerm: (event) => sendToUi('agent:term', event),
        resolveUpstream,
        search: deps.search,
        log: { warn: (msg, meta) => log.warn(meta ?? {}, `[agent] ${msg}`) },
        // todo40: MCP stdio pool (config.json is the truth; reads are fresh per
        // access so Settings upserts apply without a rebuild).
        mcpServers: () => getConfig().mcpServers ?? {},
        sendMcpStatus,
      })
      registerShutdownHook(() => {
        wiring?.dispose()
        wiring = null
      })
      return wiring
    } catch (error) {
      failed = true
      log.error({ err: error }, 'agent wiring unavailable')
      return null
    }
  }
}
