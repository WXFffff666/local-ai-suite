/**
 * QuickAskApp.tsx — todo41 快速问答浮窗（main.tsx 以 #/quickask 分支挂载，
 * 与 todo38 遮罩同一 electron-vite 单 bundle + hash 分支现实）。
 *
 * 行为契约（plan）：
 *  - 单行输入 + 发送按钮；Enter=发送，Shift+Enter=换行，Esc=隐藏（invoke
 *    'quickask:hide'，主进程 hide-to-memory，历史留在本窗内存）；
 *  - 会话 Ephemeral：消息只存本组件内存（上限 50 条），永不走 conversations:*
 *    → chat.db 零写入；发送经 'quickask:ask'（主进程 ChatRelay 同一条上游，
 *    delta 以 'quickask:delta/done/error' 事件回流，仅达本帧）；
 *  - 剪贴板占位：挂载时 PULL 'quickask:prefill:get'（首窗竞态决定性的那条路），
 *    此后每次呼起收 'quickask:prefill' 推送 — 两者都只更新 placeholder
 *    （"自动带入占位"，用户输入非空时不打扰）；
 *  - 历史 50 条封顶：超出即丢最旧（保持成对的 user 先行序，从尾部截 50）。
 * MIT only, no AGPL.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  QuickAskAskReply,
  QuickAskPrefillReply,
} from '../../../main/ipc/whitelist'
import { DEFAULT_CHAT_MODEL } from '../../../chat/ipc'

/** 计划值：内存历史上限（含 user/assistant 两条流式对）。 */
export const QUICKASK_HISTORY_CAP = 50
/** 计划值：失焦后延迟隐藏毫秒（pointer 回到窗口即取消）。 */
export const QUICKASK_BLUR_GRACE_MS = 300

type QaMessage = { id: string; role: 'user' | 'assistant'; content: string; pending?: boolean }

let idSeq = 0
function qaId(prefix: string): string {
  idSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${idSeq}`
}

/** The preload surface this window uses (injectable for jsdom tests). */
export type QuickAskApi = {
  invoke(channel: 'quickask:ask', payload: unknown): Promise<unknown>
  invoke(channel: 'quickask:hide', payload: Record<string, never>): Promise<unknown>
  invoke(channel: 'quickask:prefill:get', payload: Record<string, never>): Promise<unknown>
  on(channel: 'quickask:delta', l: (e: ChatDeltaEvent) => void): () => void
  on(channel: 'quickask:done', l: (e: ChatDoneEvent) => void): () => void
  on(channel: 'quickask:error', l: (e: ChatErrorEvent) => void): () => void
  on(channel: 'quickask:prefill', l: (e: { text: string }) => void): () => void
}

export function resolveQuickAskApi(injected?: QuickAskApi | null): QuickAskApi | null {
  if (injected !== undefined) return injected
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: QuickAskApi }).api
  return api ?? null
}

/** Trim a message list to the newest cap entries (plan: 50, drop oldest). */
export function capHistory<T>(messages: readonly T[], cap = QUICKASK_HISTORY_CAP): T[] {
  return messages.length <= cap ? [...messages] : messages.slice(messages.length - cap)
}

export type QuickAskProps = { api?: QuickAskApi | null }

export function QuickAskApp({ api }: QuickAskProps): React.JSX.Element | null {
  const invoke = useRef<QuickAskApi | null>(resolveQuickAskApi(api))
  const [messages, setMessages] = useState<QaMessage[]>([])
  const [input, setInput] = useState('')
  const [placeholder, setPlaceholder] = useState('输入问题，Enter 发送…')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const patchAssistant = useCallback((id: string, patch: (m: QaMessage) => Partial<QaMessage>) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)))
  }, [])

  // stream listeners: one mount, live for the window's whole life (hide keeps it)
  useEffect(() => {
    const apiNow = invoke.current
    if (apiNow === null) return
    const offDelta = apiNow.on('quickask:delta', (e) => {
      patchAssistant(e.id, (m) => ({ content: m.content + (typeof e.delta === 'string' ? e.delta : '') }))
    })
    const offDone = apiNow.on('quickask:done', (e) => {
      patchAssistant(e.id, () => ({ pending: false }))
    })
    const offError = apiNow.on('quickask:error', (e) => {
      patchAssistant(e.id, () => ({ pending: false }))
      setError(e.message)
    })
    const offPrefill = apiNow.on('quickask:prefill', (e) => {
      setPlaceholder(`${e.text}\n（剪贴板内容 — 输入并 Enter 提问）`)
    })
    return () => {
      offDelta()
      offDone()
      offError()
      offPrefill()
    }
  }, [patchAssistant])

  // mount-pull: the FIRST show may push before listeners exist — the pull is
  // the deterministic twin (overlay frame:get precedent).
  useEffect(() => {
    const apiNow = invoke.current
    if (apiNow === null) return
    void (async () => {
      try {
        const reply = (await apiNow.invoke('quickask:prefill:get', {})) as QuickAskPrefillReply
        if (reply?.ok && reply.prefill !== null) {
          setPlaceholder(`${reply.prefill}\n（剪贴板内容 — 输入并 Enter 提问）`)
        }
      } catch {
        /* prefill is a nicety — never blocks asking */
      }
    })()
  }, [])

  // auto-focus the input on every show (main's win.focus() lands here too)
  const focusInput = useCallback(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    const onFocus = (): void => focusInput()
    window.addEventListener('focus', onFocus)
    focusInput()
    return () => window.removeEventListener('focus', onFocus)
  }, [focusInput])

  const send = useCallback(async (): Promise<void> => {
    const apiNow = invoke.current
    const text = input.trim()
    if (apiNow === null || text.length === 0) return
    const userMsg: QaMessage = { id: qaId('u'), role: 'user', content: text }
    const assistant: QaMessage = { id: qaId('a'), role: 'assistant', content: '', pending: true }
    // wire history = everything finalized (pending placeholder excluded) + user
    const history = [...messages.filter((m) => !m.pending), userMsg].map((m) => ({ role: m.role, content: m.content }))
    setMessages((ms) => capHistory([...ms, userMsg, assistant]))
    setInput('')
    setError(null)
    try {
      const ack = (await apiNow.invoke('quickask:ask', {
        id: assistant.id,
        model: DEFAULT_CHAT_MODEL,
        messages: history,
      })) as QuickAskAskReply | { ok?: false; error?: string }
      if (!ack || ack.ok !== true) {
        const msg = ack && 'error' in ack && typeof ack.error === 'string' ? ack.error : 'quickask:ask 被主进程拒绝'
        patchAssistant(assistant.id, () => ({ pending: false }))
        setError(msg)
      }
    } catch (e) {
      patchAssistant(assistant.id, () => ({ pending: false }))
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [input, messages, patchAssistant])

  const hide = useCallback((): void => {
    void invoke.current?.invoke('quickask:hide', {}).catch(() => undefined)
  }, [])

  // BLUR GRACE (plan): losing focus schedules a hide after 300ms; refocus or
  // pointer re-enter (mousemove over the window) cancels the pending hide.
  // The timer lives HERE so jsdom fake timers drive it (main holds no timers);
  // 150ms cover the click-through refocus latency of alwaysOnTop windows.
  useEffect(() => {
    let grace: ReturnType<typeof setTimeout> | null = null
    const cancel = (): void => {
      if (grace !== null) {
        clearTimeout(grace)
        grace = null
      }
    }
    const onBlur = (): void => {
      cancel()
      grace = setTimeout(() => {
        grace = null
        hide()
      }, QUICKASK_BLUR_GRACE_MS)
    }
    const onPointerBack = (): void => cancel()
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onPointerBack)
    window.addEventListener('mousemove', onPointerBack)
    return () => {
      cancel()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onPointerBack)
      window.removeEventListener('mousemove', onPointerBack)
    }
  }, [hide])

  // Esc anywhere hides (hide-to-memory: history stays for the next summon)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        hide()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hide])

  const wireMessages = useMemo(
    () => messages.map(({ role, content }) => ({ role, content })),
    [messages],
  )

  if (invoke.current === null) return null

  return (
    <div
      data-testid="las-quickask-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        margin: 0,
        background: '#0f0f0f',
        color: '#e6e6e6',
        fontFamily: 'system-ui,sans-serif',
        fontSize: 13,
      }}
    >
      <div data-testid="las-quickask-log" style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {wireMessages.length === 0 && (
          <div style={{ color: '#777', alignSelf: 'center', marginTop: '30%' }}>快速问答 · Esc 隐藏 · 失焦自动隐藏</div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            data-role={m.role}
            style={{
              maxWidth: '92%',
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              background: m.role === 'user' ? '#1d3a57' : '#1b1b1b',
              border: '1px solid #2c2c2c',
              borderRadius: 8,
              padding: '6px 9px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {m.content}
            {m.pending && m.content.length === 0 ? <span style={{ color: '#777' }}>…</span> : null}
          </div>
        ))}
        {error !== null && (
          <div data-testid="las-quickask-error" role="alert" style={{ color: '#e06c6c' }}>
            {error}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #262626' }}>
        <textarea
          ref={inputRef}
          data-testid="las-quickask-input"
          rows={1}
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          style={{
            flex: 1,
            resize: 'none',
            background: '#171717',
            color: '#e6e6e6',
            border: '1px solid #2c2c2c',
            borderRadius: 6,
            padding: '6px 8px',
            font: 'inherit',
          }}
        />
        <button
          type="button"
          data-testid="las-quickask-send"
          onClick={() => void send()}
          disabled={input.trim().length === 0}
          style={{
            borderRadius: 6,
            border: '1px solid #2f5f8f',
            background: '#1d3a57',
            color: '#e6e6e6',
            padding: '0 14px',
            cursor: 'pointer',
          }}
        >
          发送
        </button>
      </div>
    </div>
  )
}

export default QuickAskApp
