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
import type { AllowedChannel, ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent, RagCitation } from '../main/ipc/whitelist'
import type { ChatMessage, ChatSession, ChatSendOptions, Role } from './types'
import { genId, newAssistantPlaceholder, newSession } from './types'
import type { ChatIpcApi, ChatSendAck, ChatSendPayload } from './ipc'
import { DEFAULT_CHAT_MODEL, getChatIpcApi, IPC_UNAVAILABLE_MESSAGE, toWireContent } from './ipc'
// 阶段1：对话画图工具（[[IMG:…]] 标记 → 本地生图回填会话）
import { asImageJobApi, extractImageMarks, IMAGE_TOOL_SYSTEM_PROMPT, runImageJob } from './imageTool'

export type { Role, ChatMessage, ChatSession, ChatSendOptions } from './types'
export { genId, newSession, newAssistantPlaceholder } from './types'
export type { SseDelta } from './sse'
export { parseSseLine, parseSseBuffer } from './sse'
export type { ChatSendPayload, ChatSendAck, ChatIpcApi } from './ipc'
export { getChatIpcApi, IPC_UNAVAILABLE_MESSAGE, DEFAULT_CHAT_MODEL } from './ipc'

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// todo17 conversation bridge (ADDITIVE ONLY — sessions/messages shapes frozen)
// ---------------------------------------------------------------------------
/** Minimal seam the store uses to persist finalized messages into chat.db.
 *  The sidebar owns conversation selection; the store only appends. */
export type ConversationBridge = {
  appendMessage(chatId: string, role: Role, content: string): Promise<unknown>
}

/** Resolve a bridge over window.api ('conversations:appendMessage'); null outside Electron. */
export function getConversationBridge(): ConversationBridge | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: { invoke?: (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown> } }).api
  if (!api || typeof api.invoke !== 'function') return null
  const invoke = api.invoke.bind(api)
  return {
    appendMessage: (chatId, role, content) => invoke('conversations:appendMessage', { chatId, role, content })
  }
}

export type ChatStoreState = {
  sessions: ChatSession[]
  currentId: string | null
  streaming: boolean
  error: string | null
  /** chat.db conversation id backing currentId, set by the sidebar (todo17). */
  activeConversationId: string | null
  // actions
  createSession: (title?: string) => string
  deleteSession: (id: string) => void
  switchSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  /** Replace/insert a full session loaded from chat.db and make it current. */
  loadConversation: (session: ChatSession) => void
  setActiveConversation: (id: string | null) => void
  clearCurrentMessages: () => void
  abort: () => void
  retry: (opts?: ChatSendOptions) => Promise<void>
  /** todo21: images = base64 data-URLs attached to the user turn (≤2, additive param). */
  /** todo39: rag = knowledge-grounded turn (additive 4th param; citations ride
   *  the USER message for the chips UI, the context only reaches the wire via
   *  toWireContent — never display or chat.db). */
  send: (content: string, opts?: ChatSendOptions, images?: readonly string[], rag?: { context: string; citations: RagCitation[] }) => Promise<void>
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

export function createChatStore(
  deps: { resolveApi?: () => ChatIpcApi | null; conversations?: () => ConversationBridge | null } = {},
) {
  const resolveApi = deps.resolveApi ?? getChatIpcApi
  const resolveConversations = deps.conversations ?? getConversationBridge
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
     * todo17 persistence seam: append a finalized message to chat.db via the
     * injected bridge. Only the active conversation persists (sessions created
     * in-memory without a chat.db row stay ephemeral); empty content is skipped
     * (aborted-before-first-token). Bridge rejections surface in store.error.
     */
    const persistMessage = (sessionId: string, role: Role, content: string): void => {
      if (content.length === 0) return
      if (get().activeConversationId !== sessionId) return
      const bridge = resolveConversations()
      if (!bridge) return
      void bridge.appendMessage(sessionId, role, content).catch((e: unknown) => {
        set({ error: e instanceof Error ? e.message : String(e) })
      })
    }

    /**
     * Launch a relay stream for an already-inserted assistant placeholder.
     * Returns a promise that settles when the stream terminates
     * (done / error / rejected ack) — events are routed by message id, so
     * concurrent sessions never cross-talk.
     */
    const launch = async (
      sessionId: string,
      assistantId: string,
      history: ChatSendPayload['messages'],
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
      /** Final message state + store error + teardown, exactly once.
       *  persistAssistant = the stream reached chat:done (normal or aborted):
       *  the partial/full answer belongs in chat.db. Error paths never persist. */
      const terminate = (finalPatch: Partial<ChatMessage>, storeError: string | null, bumpSessionTime: boolean, persistAssistant = false) => {
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
        if (persistAssistant) {
          const msg = get().sessions.find((s) => s.id === sessionId)?.messages.find((m) => m.id === assistantId)
          if (msg) persistMessage(sessionId, 'assistant', msg.content)
        }
        streams.get(assistantId)?.dispose()
        settle()
      }
      const offDelta = api.on('chat:delta', (e: ChatDeltaEvent) => {
        if (e.id !== assistantId) return
        const content = typeof e.delta === 'string' ? e.delta : ''
        // todo11b parity: reasoning?: string carried beside content (omitted
        // when absent). Thinking text accumulates in ChatMessage.reasoning;
        // content-only deltas leave the reasoning field untouched.
        const reasoning = typeof e.reasoning === 'string' ? e.reasoning : ''
        if (!content && !reasoning) return
        set((st) => ({
          sessions: updateSession(st.sessions, sessionId, (s) => ({
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== assistantId) return m
              const next: ChatMessage = { ...m, content: m.content + content }
              if (reasoning) next.reasoning = (m.reasoning ?? '') + reasoning
              return next
            }),
            updatedAt: Date.now(),
          })),
        }))
      })
      const offDone = api.on('chat:done', (e: ChatDoneEvent) => {
        if (e.id !== assistantId) return
        if (e.aborted) {
          terminate({ pending: false, error: 'aborted' }, 'aborted', false, true)
        } else {
          terminate({ pending: false }, null, true, true)
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
      // 阶段1：画图工具开启时本轮注入 [[IMG:…]] 标记 system 提示（additive，
      // 关闭时 payload 与历史字节一致）
      const wireMessages = opts.imageTool
        ? [{ role: 'system' as const, content: IMAGE_TOOL_SYSTEM_PROMPT }, ...history]
        : history
      const payload: ChatSendPayload = {
        id: assistantId,
        model: opts.model ?? DEFAULT_CHAT_MODEL,
        messages: wireMessages,
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
    const historyWithout = (sessionId: string, excludeAssistantId: string): ChatSendPayload['messages'] => {
      const sess = get().sessions.find((s) => s.id === sessionId)
      return (sess?.messages ?? [])
        .filter((m) => m.id !== excludeAssistantId && !m.pending)
        .map((m) => ({ role: m.role, content: toWireContent(m) }))
    }

    return {
      sessions: [],
      currentId: null,
      streaming: false,
      error: null,
      activeConversationId: null,

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

      loadConversation: (session) => {
        set((st) => ({
          sessions: st.sessions.some((s) => s.id === session.id)
            ? st.sessions.map((s) => (s.id === session.id ? session : s))
            : [...st.sessions, session],
          currentId: session.id,
          activeConversationId: session.id,
          error: null,
        }))
      },

      setActiveConversation: (id) => set({ activeConversationId: id }),

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
        // chat:done will never arrive after local dispose — persist the partial answer here
        const abortedMsg = get().sessions.find((s) => s.id === cur)?.messages.find((m) => m.id === targetId)
        if (abortedMsg) persistMessage(cur, 'assistant', abortedMsg.content)
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

      send: async (content, opts, images, rag) => {
        const text = content.trim()
        const attached = (images ?? []).slice(0, 2)
        if (!text && attached.length === 0) return

        let curId = get().currentId
        if (!curId) {
          curId = get().createSession()
        }
        const sessionId = curId

        const userMsg: ChatMessage = {
          id: genId('u'),
          role: 'user',
          content: text,
          createdAt: Date.now(),
          ...(attached.length > 0 ? { images: attached } : {}),
          ...(rag && rag.citations.length > 0 ? { citations: rag.citations } : {}),
          ...(rag && rag.context.length > 0 ? { ragContext: rag.context } : {}),
        }
        const placeholder = newAssistantPlaceholder()

        set((st) => ({
          sessions: updateSession(st.sessions, sessionId, (s) => ({
            ...s,
            title: s.messages.length === 0 ? (text || '图片对话').slice(0, 32) : s.title,
            messages: [...s.messages, userMsg, placeholder],
            updatedAt: Date.now(),
          })),
          error: null,
        }))

        persistMessage(sessionId, 'user', text)
        await launch(sessionId, placeholder.id, historyWithout(sessionId, placeholder.id), opts ?? {})
        // 阶段1：画图工具 — done 后解析 [[IMG:…]] 标记，逐个走本地生图并把
        // 图片回填会话（追加 assistant 消息；额外消息不入 chat.db，刷新即失）。
        if (opts?.imageTool === true) {
          const api2 = resolveApi()
          if (api2) {
            const sess = get().sessions.find((s) => s.id === sessionId)
            const assistant = sess?.messages.find((m) => m.id === placeholder.id)
            const marks = assistant ? extractImageMarks(assistant.content).marks : []
            for (const mark of marks.slice(0, 3)) {
              const drawingId = genId('a')
              const drawingMsg: ChatMessage = {
                id: drawingId,
                role: 'assistant',
                content: `🎨 正在绘制：${mark}`,
                createdAt: Date.now(),
                pending: true,
              }
              set((st) => ({
                sessions: updateSession(st.sessions, sessionId, (s) => ({
                  ...s,
                  messages: [...s.messages, drawingMsg],
                  updatedAt: Date.now(),
                })),
              }))
              try {
                const dataUrl = await runImageJob(asImageJobApi(api2), mark, { enhance: true })
                patchAssistant(sessionId, drawingId, {
                  pending: false,
                  content: `🎨 ${mark}`,
                  images: [dataUrl],
                })
              } catch (e) {
                patchAssistant(sessionId, drawingId, {
                  pending: false,
                  content: `🎨 绘制失败（${mark}）：${e instanceof Error ? e.message : String(e)}`,
                })
              }
            }
          }
        }
      },
    }
  })
}

// Singleton for app
export const useChatStore = createChatStore()

export default useChatStore
