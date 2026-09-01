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
 * - store 数据形状不变（Thinking / reasoning 解析兼容，见下方 SSE 解析纯函数）
 */
import { create } from 'zustand'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent } from '../main/ipc/whitelist'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Role = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: Role
  content: string
  reasoning?: string
  createdAt: number
  pending?: boolean
  error?: string
}

export type ChatSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export type SseDelta = {
  content?: string
  reasoning?: string
  done?: boolean
  stop?: boolean
  raw?: unknown
}

// ---------------------------------------------------------------------------
// IPC contract (landing surface of src/main/ipc/chatRelay.ts, todo8/10)
// ---------------------------------------------------------------------------
export type ChatSendPayload = {
  id: string
  model: string
  messages: Array<{ role: Role; content: string }>
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
}

export type ChatSendAck = { ok: true; id: string; streaming: true } | { ok?: false; error?: string; issues?: unknown }

/** Minimal structural view of the preload WindowApi the chat store needs. */
export type ChatIpcApi = {
  invoke(channel: 'chat:send', payload: ChatSendPayload): Promise<unknown>
  invoke(channel: 'chat:abort', payload: { id: string }): Promise<unknown>
  on(channel: 'chat:delta', listener: (e: ChatDeltaEvent) => void): () => void
  on(channel: 'chat:done', listener: (e: ChatDoneEvent) => void): () => void
  on(channel: 'chat:error', listener: (e: ChatErrorEvent) => void): () => void
}

/** Resolve window.api when present; null outside the Electron shell (vitest node env, plain browser). */
export function getChatIpcApi(): ChatIpcApi | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: Partial<ChatIpcApi> }).api
  if (api && typeof api.invoke === 'function' && typeof api.on === 'function') return api as ChatIpcApi
  return null
}

export const IPC_UNAVAILABLE_MESSAGE = 'IPC 不可用：聊天需要 Electron 主进程转发（非桌面环境时降级为只读）'

/** Default upstream model tag; relay/resolver decides the real engine. */
export const DEFAULT_CHAT_MODEL = 'local'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function genId(prefix = 'm'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newSession(title?: string): ChatSession {
  const now = Date.now()
  return {
    id: genId('s'),
    title: title?.trim() || 'New Chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
}

// ---------------------------------------------------------------------------
// SSE parsing — delta.content / reasoning_content 透传
// (legacy-compatible pure parsers: the main-process relay delivers parsed
//  strings via chat:delta, but these stay exported for store-shape parity)
// ---------------------------------------------------------------------------
/**
 * Parse single SSE line `data: {...}` or `data: [DONE]`.
 * Extracts delta.content + delta.reasoning_content (or delta.reasoning) for 透传.
 * Returns null for non-data / empty / [DONE] / unparsable.
 */
export function parseSseLine(line: string): SseDelta | null {
  const t = line.trim()
  if (!t) return null
  if (!t.startsWith('data:')) return null
  const data = t.slice(5).trim()
  if (!data || data === '[DONE]') return { done: true }
  try {
    const obj = JSON.parse(data) as Record<string, unknown>
    // stop sentinel without content
    if (obj['stop'] === true) return { stop: true, done: true, raw: obj }
    // OpenAI chat.completion.chunk: choices[0].delta.content / reasoning_content / finish_reason
    const choices = obj['choices'] as Array<Record<string, unknown>> | undefined
    if (Array.isArray(choices) && choices[0]) {
      const ch = choices[0] as Record<string, unknown>
      if (ch['finish_reason']) return { done: true, raw: obj }
      const delta = (ch['delta'] ?? ch['message']) as Record<string, unknown> | undefined
      if (delta) {
        const c = typeof delta['content'] === 'string' ? (delta['content'] as string) : undefined
        const r =
          typeof delta['reasoning_content'] === 'string'
            ? (delta['reasoning_content'] as string)
            : typeof delta['reasoning'] === 'string'
              ? (delta['reasoning'] as string)
              : undefined
        if (c !== undefined || r !== undefined) return { content: c, reasoning: r, raw: obj }
        if (delta['stop'] === true) return { done: true, raw: obj }
      }
      // Some providers put content at choices[0].text
      if (typeof ch['text'] === 'string') return { content: ch['text'] as string, raw: obj }
      return null
    }
    // llama.cpp style: {content, stop} or {delta:{content}}
    if (typeof obj['content'] === 'string') {
      return { content: obj['content'] as string, done: Boolean(obj['stop']), raw: obj }
    }
    const delta = obj['delta'] as Record<string, unknown> | undefined
    if (delta && typeof delta['content'] === 'string') {
      const r =
        typeof delta['reasoning_content'] === 'string'
          ? (delta['reasoning_content'] as string)
          : typeof delta['reasoning'] === 'string'
            ? (delta['reasoning'] as string)
            : typeof obj['reasoning_content'] === 'string'
              ? (obj['reasoning_content'] as string)
              : undefined
      return { content: delta['content'] as string, reasoning: r, done: Boolean(obj['stop'] ?? delta['stop']), raw: obj }
    }
    // direct reasoning_content at top level
    if (typeof obj['reasoning_content'] === 'string' || typeof obj['reasoning'] === 'string') {
      return {
        reasoning: (obj['reasoning_content'] as string) ?? (obj['reasoning'] as string),
        raw: obj,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Split buffered SSE text into lines and parse deltas.
 */
export function parseSseBuffer(buf: string): { deltas: SseDelta[]; remainder: string } {
  const parts = buf.split('\n')
  const remainder = parts.pop() ?? ''
  const deltas: SseDelta[] = []
  for (const line of parts) {
    const d = parseSseLine(line)
    if (d) deltas.push(d)
  }
  return { deltas, remainder }
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------
export type ChatSendOptions = {
  model?: string
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
}

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
    /** Rewrite one assistant message inside a session. */
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
          patchAssistant(sessionId, assistantId, { pending: false, error: 'aborted' })
          set({ error: 'aborted' })
        } else {
          set((st) => ({
            sessions: updateSession(st.sessions, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)),
              updatedAt: Date.now(),
            })),
          }))
        }
        streams.get(assistantId)?.dispose()
        settle()
      })
      const offError = api.on('chat:error', (e: ChatErrorEvent) => {
        if (e.id !== assistantId) return
        patchAssistant(sessionId, assistantId, { pending: false, error: e.message })
        set({ error: e.message })
        streams.get(assistantId)?.dispose()
        settle()
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
          patchAssistant(sessionId, assistantId, { pending: false, error: msg })
          set({ error: msg })
          streams.get(assistantId)?.dispose()
          settle()
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        patchAssistant(sessionId, assistantId, { pending: false, error: msg })
        set({ error: msg })
        streams.get(assistantId)?.dispose()
        settle()
      }
      await finished
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
        // most recent active stream of the current session
        let targetId: string | null = null
        for (const [id, h] of streams) {
          if (h.sessionId === cur) targetId = id
        }
        if (!targetId) return
        const handle = streams.get(targetId)
        handle?.dispose()
        patchAssistant(cur!, targetId, { pending: false, error: 'aborted' })
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
        // find last user message
        let lastUserIndex = -1
        for (let i = sess.messages.length - 1; i >= 0; i--) {
          if (sess.messages[i]!.role === 'user') {
            lastUserIndex = i
            break
          }
        }
        if (lastUserIndex === -1) return
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
        // create fresh assistant placeholder (do NOT duplicate user)
        const assistantId = genId('a')
        const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', reasoning: '', createdAt: Date.now(), pending: true }
        set((prev) => ({
          sessions: updateSession(prev.sessions, curId, (s) => ({ ...s, messages: [...s.messages, assistantMsg], updatedAt: Date.now() })),
          error: null,
        }))
        const sessNow = get().sessions.find((s) => s.id === curId)!
        const history = sessNow.messages
          .filter((m) => m.id !== assistantId && !m.pending)
          .map((m) => ({ role: m.role, content: m.content }))
        await launch(curId, assistantId, history, opts ?? {})
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
        const assistantId = genId('a')
        const assistantMsg: ChatMessage = {
          id: assistantId,
          role: 'assistant',
          content: '',
          reasoning: '',
          createdAt: Date.now(),
          pending: true,
        }

        set((st) => ({
          sessions: updateSession(st.sessions, sessionId, (s) => ({
            ...s,
            title: s.messages.length === 0 ? text.slice(0, 32) : s.title,
            messages: [...s.messages, userMsg, assistantMsg],
            updatedAt: Date.now(),
          })),
          error: null,
        }))

        const sessNow = get().sessions.find((s) => s.id === sessionId)!
        const history = sessNow.messages
          .filter((m) => m.id !== assistantId && !m.pending)
          .map((m) => ({ role: m.role, content: m.content }))

        await launch(sessionId, assistantId, history, opts ?? {})
      },
    }
  })
}

// Singleton for app
export const useChatStore = createChatStore()

export default useChatStore
