/**
 * Chat store — Todo 14 Wave4
 * Zustand sessions/messages + SSE delta.content / reasoning_content 透传 + abort/retry
 * - MIT only, no AGPL
 * - SSE shape compatible with OpenAI / llama.cpp / ollama (choices[0].delta.content, reasoning_content, content)
 */
import { create } from 'zustand'

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
// SSE parsing — delta.content / reasoning_content透传
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
// Streaming helper — consumes fetch Response as SSE async generator
// ---------------------------------------------------------------------------
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export async function* streamSse(
  url: string,
  body: unknown,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal; headers?: Record<string, string> } = {},
): AsyncGenerator<SseDelta, void, unknown> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`chat SSE failed ${res.status} ${res.statusText} ${text}`.trim())
  }
  const ctype = res.headers.get('content-type') ?? ''
  if (!ctype.includes('text/event-stream')) {
    const json = (await res.json().catch(async () => ({ content: await res.text() }))) as Record<string, unknown>
    // non-stream fallback: interpret as single delta
    const text = typeof json['content'] === 'string' ? (json['content'] as string) : JSON.stringify(json)
    if (text) yield { content: text, done: true, raw: json }
    return
  }
  const stream = res.body as unknown as ReadableStream<Uint8Array> | null
  if (!stream) throw new Error('SSE response has no body')
  const reader = (stream as ReadableStream<Uint8Array>).getReader?.() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined
  if (!reader) {
    const text = await res.text()
    for (const line of text.split('\n')) {
      const d = parseSseLine(line)
      if (d) yield d
    }
    return
  }
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const d = parseSseLine(line)
        if (d) {
          yield d
          if (d.done && !d.content && !d.reasoning) {
            // still continue to allow final flush
          }
        }
      }
      if (opts.signal?.aborted) {
        await reader.cancel().catch(() => {})
        throw new DOMException('Aborted', 'AbortError')
      }
    }
    if (buf.trim()) {
      const d = parseSseLine(buf)
      if (d) yield d
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------
export const CHAT_COMPLETION_URL = 'http://127.0.0.1:11435/v1/chat/completions' as const

export type ChatStoreState = {
  sessions: ChatSession[]
  currentId: string | null
  streaming: boolean
  error: string | null
  // transient, not persisted: abort controller for current stream
  _abortCtrl: AbortController | null
  // actions
  createSession: (title?: string) => string
  deleteSession: (id: string) => void
  switchSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  clearCurrentMessages: () => void
  abort: () => void
  retry: (opts?: { fetchImpl?: FetchLike; url?: string }) => Promise<void>
  send: (content: string, opts?: { fetchImpl?: FetchLike; url?: string; signal?: AbortSignal }) => Promise<void>
}

function updateSession(
  sessions: ChatSession[],
  id: string,
  updater: (s: ChatSession) => ChatSession,
): ChatSession[] {
  return sessions.map((s) => (s.id === id ? updater(s) : s))
}

export function createChatStore() {
  return create<ChatStoreState>()((set, get) => ({
    sessions: [],
    currentId: null,
    streaming: false,
    error: null,
    _abortCtrl: null,

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
      const c = get()._abortCtrl
      if (c) {
        try {
          c.abort()
        } catch {}
      }
      // streaming flag cleared on next tick by send's finally; also clear here for immediate UI feedback
      set({ streaming: false, _abortCtrl: null })
      // mark pending assistant msg as aborted
      const cur = get().currentId
      if (cur) {
        set((st) => ({
          sessions: updateSession(st.sessions, cur, (s) => {
            const msgs = [...s.messages]
            const last = msgs[msgs.length - 1]
            if (last && last.role === 'assistant' && last.pending) {
              msgs[msgs.length - 1] = { ...last, pending: false, error: 'aborted' }
            }
            return { ...s, messages: msgs }
          }),
        }))
      }
    },

    retry: async (opts) => {
      const st = get()
      const curId = st.currentId
      if (!curId) return
      if (get().streaming) return
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
      const url = opts?.url ?? CHAT_COMPLETION_URL
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
        streaming: true,
        error: null,
      }))
      const ctrl = new AbortController()
      set({ _abortCtrl: ctrl })
      const signal = ctrl.signal
      const sessNow = get().sessions.find((s) => s.id === curId)!
      const history = sessNow.messages.filter((m) => m.id !== assistantId && !m.pending).map((m) => ({ role: m.role, content: m.content }))
      const payload = { model: 'local', stream: true, messages: history }
      try {
        for await (const delta of streamSse(url, payload, { fetchImpl: opts?.fetchImpl, signal })) {
          if (delta.done && !delta.content && !delta.reasoning) continue
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          if (delta.content || delta.reasoning) {
            set((prev2) => ({
              sessions: updateSession(prev2.sessions, curId, (s) => ({
                ...s,
                messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: m.content + (delta.content ?? ''), reasoning: (m.reasoning ?? '') + (delta.reasoning ?? '') } : m)),
                updatedAt: Date.now(),
              })),
            }))
          }
          if (delta.done || delta.stop) break
        }
      } catch (e: unknown) {
        const err = e as Error
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')
        const msg = isAbort ? 'aborted' : err?.message ?? String(e)
        set((prev2) => ({
          sessions: updateSession(prev2.sessions, curId, (s) => ({
            ...s,
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, pending: false, error: msg } : m)),
          })),
          error: msg,
        }))
      } finally {
        set((prev2) => ({
          sessions: updateSession(prev2.sessions, curId, (s) => ({
            ...s,
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)),
            updatedAt: Date.now(),
          })),
          streaming: false,
          _abortCtrl: null,
        }))
      }
    },

    send: async (content, opts) => {
      const text = content.trim()
      if (!text) return
      if (get().streaming) return // prevent concurrent sends

      let curId = get().currentId
      if (!curId) {
        curId = get().createSession()
      }
      const sessionId = curId!
      const url = opts?.url ?? CHAT_COMPLETION_URL

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
        streaming: true,
        error: null,
      }))

      const ctrl = opts?.signal ? null : new AbortController()
      const signal = opts?.signal ?? ctrl!.signal
      if (ctrl) set({ _abortCtrl: ctrl })

      // Build OpenAI-compatible payload; include history
      const sessNow = get().sessions.find((s) => s.id === sessionId)!
      const history = sessNow.messages
        .filter((m) => m.id !== assistantId && !m.pending)
        .map((m) => ({ role: m.role, content: m.content }))

      const payload = {
        model: 'local',
        stream: true,
        messages: history,
      }

      try {
        for await (const delta of streamSse(url, payload, { fetchImpl: opts?.fetchImpl, signal })) {
          if (delta.done && !delta.content && !delta.reasoning) {
            // stream end sentinel
            continue
          }
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          if (delta.content || delta.reasoning) {
            set((st) => ({
              sessions: updateSession(st.sessions, sessionId, (s) => {
                const msgs = s.messages.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: m.content + (delta.content ?? ''),
                        reasoning: (m.reasoning ?? '') + (delta.reasoning ?? ''),
                      }
                    : m,
                )
                return { ...s, messages: msgs, updatedAt: Date.now() }
              }),
            }))
          }
          if (delta.done || delta.stop) break
        }
      } catch (e: unknown) {
        const err = e as Error
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')
        const msg = isAbort ? 'aborted' : err?.message ?? String(e)
        if (isAbort) {
          set((st) => ({
            sessions: updateSession(st.sessions, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, pending: false, error: 'aborted' } : m)),
            })),
            error: 'aborted',
          }))
        } else {
          set((st) => ({
            sessions: updateSession(st.sessions, sessionId, (s) => ({
              ...s,
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, pending: false, error: msg } : m)),
            })),
            error: msg,
          }))
        }
      } finally {
        set((st) => ({
          sessions: updateSession(st.sessions, sessionId, (s) => ({
            ...s,
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)),
            updatedAt: Date.now(),
          })),
          streaming: false,
          _abortCtrl: null,
        }))
      }
    },
  }))
}

// Singleton for app
export const useChatStore = createChatStore()

export default useChatStore
