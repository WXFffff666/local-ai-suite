/**
 * agentStore.ts — todo29 zustand slice: the per-chat-session 聊天|代理 mode
 * plus the agent run state (timeline cards + start/stop actions) for ONE
 * active agent session per chat session. Talks to the shell exclusively
 * through the whitelisted surface: invoke('agent:start'|'agent:cancel') and
 * the 'agent:event' stream (payloads pinned in src/main/ipc/whitelist.ts).
 *
 * Factory + injectable api resolver follow createChatStore's pattern, so the
 * whole slice is jsdom-testable with a fake window.api; outside Electron the
 * actions degrade honestly (an error card, never a silent hang).
 */
import { create } from 'zustand'

import type { AgentEvent } from '../../../../agent/runner/types'
import type { AgentStartReply } from '../../../../main/ipc/whitelist'
import { idleTimeline, reduceTimeline, type AgentRunPhase, type TimelineState } from './timeline'

export type AgentMode = 'chat' | 'agent'
export const DRAFT_KEY = '__draft__'
/** The main-side facade rewrites this placeholder with the resolved upstream. */
export const AGENT_BASE_URL_PLACEHOLDER = 'http://127.0.0.1:11434'
export const AGENT_MODEL_PLACEHOLDER = 'local'

export type AgentApi = {
  invoke(channel: 'agent:start', payload: unknown): Promise<unknown>
  invoke(channel: 'agent:cancel', payload: { sessionId: string }): Promise<unknown>
  on(channel: 'agent:event', listener: (event: AgentEvent) => void): () => void
}

export function getAgentApi(): AgentApi | null {
  if (typeof window === 'undefined') return null
  const raw = (window as unknown as { api?: Partial<AgentApi> }).api
  if (typeof raw?.on !== 'function' || typeof raw.invoke !== 'function') return null
  return raw as AgentApi
}

export type AgentStoreState = {
  readonly modes: Readonly<Record<string, AgentMode>>
  readonly runs: Readonly<Record<string, TimelineState>>
  /** chat-session key → active agent session id (event routing). */
  readonly sessionIds: Readonly<Record<string, string>>
  modeFor(sessionKey: string): AgentMode
  setMode(sessionKey: string, mode: AgentMode): void
  startRun(sessionKey: string, goal: string): Promise<void>
  stopRun(sessionKey: string): Promise<void>
  /** Route one 'agent:event' (ignored unless it belongs to an active run). */
  ingest(event: AgentEvent): void
  runPhase(sessionKey: string): AgentRunPhase
}

function agentSessionId(): string {
  return `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function failRun(state: TimelineState, message: string): TimelineState {
  return {
    ...state,
    phase: 'error',
    cards: [...state.cards, { kind: 'error', code: 'upstream-transport' as const, message }],
  }
}

export function createAgentStore(deps: { resolveApi?: () => AgentApi | null } = {}) {
  const resolveApi = deps.resolveApi ?? getAgentApi
  /** one shared subscription; the store outlives component mounts */
  let unsubscribe: (() => void) | null = null
  return create<AgentStoreState>()((set, get) => {
    const ensureSubscription = (): void => {
      if (unsubscribe !== null) return
      const api = resolveApi()
      if (!api) return
      unsubscribe = api.on('agent:event', (event) => get().ingest(event))
    }
    const patchRun = (sessionKey: string, updater: (s: TimelineState) => TimelineState): void => {
      set((st) => ({ runs: { ...st.runs, [sessionKey]: updater(st.runs[sessionKey] ?? idleTimeline) } }))
    }
    return {
      modes: {},
      runs: {},
      sessionIds: {},
      modeFor: (sessionKey) => get().modes[sessionKey] ?? 'chat',
      setMode: (sessionKey, mode) => set((st) => ({ modes: { ...st.modes, [sessionKey]: mode } })),
      runPhase: (sessionKey) => get().runs[sessionKey]?.phase ?? 'idle',
      startRun: async (sessionKey, goal) => {
        const trimmed = goal.trim()
        if (trimmed === '') return
        ensureSubscription()
        const sessionId = agentSessionId()
        set((st) => ({
          sessionIds: { ...st.sessionIds, [sessionKey]: sessionId },
          runs: { ...st.runs, [sessionKey]: { ...idleTimeline, phase: 'starting' } },
        }))
        const api = resolveApi()
        if (!api) {
          patchRun(sessionKey, (s) => failRun(s, 'IPC 不可用：代理需要 Electron 主进程运行'))
          return
        }
        try {
          const reply = (await api.invoke('agent:start', {
            sessionId,
            baseUrl: AGENT_BASE_URL_PLACEHOLDER,
            model: AGENT_MODEL_PLACEHOLDER,
            goal: trimmed,
          })) as AgentStartReply
          if (!reply.ok) {
            patchRun(sessionKey, (s) => failRun(s, `代理未能启动（${reply.error}）`))
          }
        } catch (error) {
          patchRun(sessionKey, (s) => failRun(s, error instanceof Error ? error.message : String(error)))
        }
      },
      stopRun: async (sessionKey) => {
        const sessionId = get().sessionIds[sessionKey]
        if (sessionId === undefined) return
        patchRun(sessionKey, (s) => (s.phase === 'starting' || s.phase === 'running' ? { ...s, phase: 'stopping' } : s))
        const api = resolveApi()
        if (!api) return
        await api.invoke('agent:cancel', { sessionId }).catch(() => undefined)
      },
      ingest: (event) => {
        const state = get()
        const key = Object.keys(state.sessionIds).find((k) => state.sessionIds[k] === event.sessionId)
        if (key === undefined) return
        set({ runs: { ...state.runs, [key]: reduceTimeline(state.runs[key] ?? idleTimeline, event) } })
      },
    }
  })
}

export const useAgentStore = createAgentStore()
