/**
 * Chat store — todo11 (IPC-relayed streaming)
 * Zustand sessions/messages; 流式一律经主进程 ChatRelay:
 *   window.api.invoke('chat:send'|'chat:abort') + on('chat:delta'|'chat:done'|'chat:error')
 * 事件以 assistant 消息 id 为键路由，多会话并发互不串扰。
 *
 * 直连侧车路径（CHAT_COMPLETION_URL / streamSse fetch）已在本 todo 移除 —
 * 渲染层绝不 dial 侧车端口；上游仲裁（external-takeover 11434 vs 内部分配端口）
 * 归 src/main/ipc/chatRelay.ts（todo8/10 已落地）。
 *
 * - MIT only, no AGPL
 * - store 数据形状不变（见 types.ts；SSE 解析兼容实现见 sse.ts，此处 re-export）
 */
import { create } from 'zustand'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent } from '../main/ipc/whitelist'
import type { ChatMessage, ChatSession, ChatSendOptions, Role } from './types'
import { genId, newAssistantPlaceholder, newSession } from './types'
import type { ChatIpcApi, ChatSendAck, ChatSendPayload } from './ipc'
import { DEFAULT_CHAT_MODEL, getChatIpcApi, IPC_UNAVAILABLE_MESSAGE } from './ipc'

export type { Role, ChatMessage, ChatSession, ChatSendOptions } from './types'
export { genId, newSession, newAssistantPlaceholder } from './types'
export type { SseDelta } from './sse'
export { parseSseLine, parseSseBuffer } from './sse'
export type { ChatSendPayload, ChatSendAck, ChatIpcApi } from './ipc'
export { getChatIpcApi, IPC_UNAVAILABLE_MESSAGE, DEFAULT_CHAT_MODEL } from './ipc'

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------
export type ChatStoreState = {
  sessions: ChatSession[]
  currentId: string | null
  streaming: boolean
  error: string | null
  // actions
  createSession: (title?: string) => string
  deleteSession: (id: string) => void
  switchSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  clearCurrentMessages: () => void
  abort: () => void
  retry: (opts?: ChatSendOptions) => Promise<void>
  send: (content: string, opts?: ChatSendOptions) => Promise<void>
}

function updateSession(
  sessions: ChatSession[],
  id: string,
  updater: (s: ChatSession) => ChatSession,
): ChatSession[] {
  return sessions.map((s) => (s.id === id ? updater(s) : s))
}

type StreamHandle = {
  sessionId: string
  /** unsubscribe all three event listeners + drop from the registry */
  dispose: () => void
  /** resolve the send() promise (used by local abort, which races the terminal event) */
  settle: () => void
}

function ackErrorMessage(ack: unknown): string {
  if (ack && typeof ack === 'object') {
    const a = ack as { error?: unknown; issues?: unknown }
    if (typeof a.error === 'string') {
      return Array.isArray(a.issues) && a.issues.length > 0
        ? `${a.error}: ${JSON.stringify(a.issues)}`
        : a.error
    }
  }
  return 'chat:send was rejected by the main process'
}

export function createChatStore(deps: { resolveApi?: () => ChatIpcApi | null } = {}) {
  const resolveApi = deps.resolveApi ?? getChatIpcApi
  // Active relay streams, keyed by assistant message id. Deliberately outside
  // zustand state: transient subscriptions, never rendered or persisted.
  const streams = new Map<string, StreamHandle>()

  return create<ChatStoreState>()((set, get) => {
    /** Patch one assistant message inside a session. */
    const patchAssistant = (sessionId: string, assistantId: string, patch: Partial<ChatMessage>) => {
      set((st) => ({
        sessions: updateSession(st.sessions, sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)),
        })),
      }))
    }

    const refreshStreaming = () => set({ streaming: streams.size > 0 })

    /**
     * Launch a relay stream for an already-inserted assistant placeholder.
     * Returns a promise that settles when the stream terminates
     * (done / error / rejected ack) — events are routed by message id, so
     * concurrent sessions never cross-talk.
     */
    const launch = async (
      sessionId: string,
      assistantId: string,
      history: Array<{ role: Role; content: string }>,
      opts: ChatSendOptions,
    ): Promise<void> => {
      const api = resolveApi()
      if (!api) {
        patchAssistant(sessionId, assistantId, { pending: false, error: IPC_UNAVAILABLE_MESSAGE })
        set({ error: IPC_UNAVAILABLE_MESSAGE })
        return
      }
      let settle: () => void = () => {}
      const finished = new Promise<void>((resolve) => {
        settle = resolve
      })
      /** Final message state + store error + teardown, exactly once. */
      const terminate = (finalPatch: Partial<ChatMessage>, storeError: string | null, bumpSessionTime: boolean) => {
        if (bumpSessionTime) {
          set((st) => ({
            sessions: updateSession(st.sessions, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, ...finalPatch } : m)),
              updatedAt: Date.now(),
            })),
          }))
        } else {
          patchAssistant(sessionId, assistantId, finalPatch)
        }
        if (storeError !== null) set({ error: storeError })
        streams.get(assistantId)?.dispose()
        settle()
      }
      const offDelta = api.on('chat:delta', (e: ChatDeltaEvent) => {
        if (e.id !== assistantId) return
        if (typeof e.delta !== 'string' || e.delta.length === 0) return
        set((st) => ({
          sessions: updateSession(st.sessions, sessionId, (s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + e.delta } : m,
            ),
            updatedAt: Date.now(),
          })),
        }))
      })
      const offDone = api.on('chat:done', (e: ChatDoneEvent) => {
        if (e.id !== assistantId) return
        if (e.aborted) {
          terminate({ pending: false, error: 'aborted' }, 'aborted', false)
        } else {
          terminate({ pending: false }, null, true)
        }
      })
      const offError = api.on('chat:error', (e: ChatErrorEvent) => {
        if (e.id !== assistantId) return
        terminate({ pending: false, error: e.message }, e.message, false)
      })
      streams.set(assistantId, {
        sessionId,
        dispose: () => {
          offDelta()
          offDone()
          offError()
          streams.delete(assistantId)
          refreshStreaming()
        },
        settle,
      })
      refreshStreaming()
      const payload: ChatSendPayload = {
        id: assistantId,
        model: opts.model ?? DEFAULT_CHAT_MODEL,
        messages: history,
      }
      if (opts.temperature !== undefined) payload.temperature = opts.temperature
      if (opts.top_p !== undefined) payload.top_p = opts.top_p
      if (opts.max_tokens !== undefined) payload.max_tokens = opts.max_tokens
      if (opts.stop !== undefined) payload.stop = opts.stop
      try {
        const ack = await api.invoke('chat:send', payload)
        if (!ack || (ack as ChatSendAck).ok !== true) {
          const msg = ackErrorMessage(ack)
          terminate({ pending: false, error: msg }, msg, false)
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        terminate({ pending: false, error: msg }, msg, false)
      }
      await finished
    }

    /** History of the session excluding the given pending placeholder. */
    const historyWithout = (sessionId: string, excludeAssistantId: string) => {
      const sess = get().sessions.find((s) => s.id === sessionId)
      return (sess?.messages ?? [])
        .filter((m) => m.id !== excludeAssistantId && !m.pending)
        .map((m) => ({ role: m.role, content: m.content }))
    }

    return {
      sessions: [],
      currentId: null,
      streaming: false,
      error: null,

      createSession: (title) => {
        const s = newSession(title)
        set((st) => ({ sessions: [...st.sessions, s], currentId: s.id, error: null }))
        return s.id
      },

      deleteSession: (id) => {
        set((st) => {
          const next = st.sessions.filter((s) => s.id !== id)
          let cur = st.currentId
          if (cur === id) cur = next[0]?.id ?? null
          return { sessions: next, currentId: cur }
        })
      },

      switchSession: (id) => {
        const exists = get().sessions.some((s) => s.id === id)
        if (!exists) return
        set({ currentId: id, error: null })
      },

      renameSession: (id, title) => {
        set((st) => ({ sessions: updateSession(st.sessions, id, (s) => ({ ...s, title, updatedAt: Date.now() })) }))
      },

      clearCurrentMessages: () => {
        const cur = get().currentId
        if (!cur) return
        set((st) => ({ sessions: updateSession(st.sessions, cur, (s) => ({ ...s, messages: [], updatedAt: Date.now() })) }))
      },

      abort: () => {
        const cur = get().currentId
        if (!cur) return
        // most recent active stream of the current session
        let targetId: string | null = null
        for (const [id, h] of streams) {
          if (h.sessionId === cur) targetId = id
        }
        if (!targetId) return
        const handle = streams.get(targetId)
        handle?.dispose()
        patchAssistant(cur, targetId, { pending: false, error: 'aborted' })
        set({ error: 'aborted' })
        refreshStreaming()
        // the send() promise must not dangle waiting for a terminal event we just unsubscribed from
        handle?.settle()
        void resolveApi()?.invoke('chat:abort', { id: targetId })
      },

      retry: async (opts) => {
        const st = get()
        const curId = st.currentId
        if (!curId) return
        const sess = st.sessions.find((s) => s.id === curId)
        if (!sess || sess.messages.length === 0) return
        const hasUser = sess.messages.some((m) => m.role === 'user')
        if (!hasUser) return
        // if last assistant is pending/error, remove it before retry
        const last = sess.messages[sess.messages.length - 1]
        if (last && last.role === 'assistant' && (last.pending || last.error)) {
          set((prev) => ({
            sessions: updateSession(prev.sessions, curId, (s) => ({
              ...s,
              messages: s.messages.slice(0, -1),
              updatedAt: Date.now(),
            })),
          }))
        }
        // fresh assistant placeholder (do NOT duplicate the user turn)
        const placeholder = newAssistantPlaceholder()
        set((prev) => ({
          sessions: updateSession(prev.sessions, curId, (s) => ({ ...s, messages: [...s.messages, placeholder], updatedAt: Date.now() })),
          error: null,
        }))
        await launch(curId, placeholder.id, historyWithout(curId, placeholder.id), opts ?? {})
      },

      send: async (content, opts) => {
        const text = content.trim()
        if (!text) return

        let curId = get().currentId
        if (!curId) {
          curId = get().createSession()
        }
        const sessionId = curId

        const userMsg: ChatMessage = { id: genId('u'), role: 'user', content: text, createdAt: Date.now() }
        const placeholder = newAssistantPlaceholder()

        set((st) => ({
          sessions: updateSession(st.sessions, sessionId, (s) => ({
            ...s,
            title: s.messages.length === 0 ? text.slice(0, 32) : s.title,
            messages: [...s.messages, userMsg, placeholder],
            updatedAt: Date.now(),
          })),
          error: null,
        }))

        await launch(sessionId, placeholder.id, historyWithout(sessionId, placeholder.id), opts ?? {})
      },
    }
  })
}

// Singleton for app
export const useChatStore = createChatStore()

export default useChatStore
