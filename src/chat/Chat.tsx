/**
 * Chat.tsx — 对话工作区（todo11 IPC 流式 + todo15 渲染打磨）
 * 数据流全部走 store（window.api chat:send / chat:abort + delta/done/error 事件），
 * 渲染层不直连侧车端口。无 window.api 时降级为诚实只读态。
 * todo15：消息 markdown/代码块/自动滚动/预设 chips 由 components/chatui/** 承担，
 * store 数据形状零改动（types.ts 冻结契约）。
 */
import { useState } from 'react'
import { useChatStore, getChatIpcApi, IPC_UNAVAILABLE_MESSAGE } from './store'
import { CHAT_PRESETS, fillChatPreset, type ChatPreset } from '../presets/presets'
import { MessageList } from '../renderer/src/components/chatui/MessageList'
import { PresetPicker } from '../renderer/src/components/chatui/PresetPicker'
import '../renderer/src/components/chatui/chatui.css'

export type ChatProps = {
  /** 对话预设（点击填充输入框）；传空数组隐藏预设行 */
  presets?: readonly ChatPreset[]
}

export function Chat({ presets = CHAT_PRESETS }: ChatProps): React.JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const currentId = useChatStore((s) => s.currentId)
  const streaming = useChatStore((s) => s.streaming)
  const error = useChatStore((s) => s.error)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const switchSession = useChatStore((s) => s.switchSession)
  const send = useChatStore((s) => s.send)
  const abort = useChatStore((s) => s.abort)
  const retry = useChatStore((s) => s.retry)
  const clearCurrentMessages = useChatStore((s) => s.clearCurrentMessages)

  const [input, setInput] = useState('')
  const cur = sessions.find((s) => s.id === currentId) ?? null
  const canStream = getChatIpcApi() !== null
  const streamingHere = Boolean(cur?.messages.some((m) => m.pending))

  const handleSend = async (): Promise<void> => {
    const t = input.trim()
    if (!t || streamingHere) return
    setInput('')
    await send(t)
  }

  const applyPreset = (preset: ChatPreset): void => {
    const fill = fillChatPreset(preset)
    if (fill) setInput(fill.prompt)
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: 'system-ui,sans-serif' }}>
      <aside style={{ width: 220, borderRight: '1px solid #222', padding: 12, background: '#0f0f0f', color: '#ddd', overflowY: 'auto' }}>
        <button
          onClick={() => createSession()}
          style={{ width: '100%', padding: '8px 10px', marginBottom: 12, cursor: 'pointer' }}
        >
          + New Chat
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => switchSession(s.id)}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                background: s.id === currentId ? '#1e1e1e' : 'transparent',
                border: '1px solid #2a2a2a',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                style={{ marginLeft: 6, background: 'transparent', color: '#888', border: 'none', cursor: 'pointer' }}
                aria-label="delete"
              >
                ×
              </button>
            </div>
          ))}
          {sessions.length === 0 && <span style={{ color: '#666', fontSize: 12 }}>No sessions</span>}
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#111', color: '#e6e6e6' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #222', display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cur ? cur.title : 'Select or create a chat'}
          </strong>
          {cur && <button onClick={clearCurrentMessages} style={{ cursor: 'pointer' }}>Clear</button>}
          {streamingHere && <button onClick={abort} style={{ cursor: 'pointer', color: '#f55' }}>Abort</button>}
          {!streaming && error && error !== 'aborted' && (
            <button onClick={() => void retry()} style={{ cursor: 'pointer' }}>Retry</button>
          )}
        </div>

        {!canStream && (
          <div role="status" style={{ padding: '8px 16px', background: '#2a1d1d', color: '#f0b4b4', fontSize: 12, borderBottom: '1px solid #4a2a2a' }}>
            {IPC_UNAVAILABLE_MESSAGE}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {cur && cur.messages.length > 0 ? (
            <MessageList key={cur.id} messages={cur.messages} />
          ) : (
            <div style={{ padding: 16, color: '#666' }}>
              {!cur && 'Create a new chat to start. 流式经主进程 chat:delta 事件转发。'}
              {cur && cur.messages.length === 0 && 'No messages — say hello.'}
            </div>
          )}
          {error && error !== 'aborted' && canStream && (
            <div style={{ color: '#f88', fontSize: 12, padding: '0 16px 8px' }}>Error: {error}</div>
          )}
        </div>

        {presets.length > 0 && <PresetPicker presets={presets} onPick={applyPreset} />}

        <div style={{ padding: 12, borderTop: '1px solid #222', display: 'flex', gap: 8 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() }
            }}
            placeholder={canStream ? 'Type a message… (Enter to send, Shift+Enter newline)' : '桌面端运行时可发送消息'}
            rows={2}
            style={{ flex: 1, resize: 'none', padding: 10, borderRadius: 8, border: '1px solid #333', background: '#0f0f0f', color: '#eee' }}
            disabled={!canStream}
          />
          <button onClick={() => void handleSend()} disabled={!canStream || streamingHere || !input.trim()} style={{ padding: '0 18px', cursor: streamingHere ? 'not-allowed' : 'pointer' }}>
            {streamingHere ? '…' : 'Send'}
          </button>
        </div>
      </main>
    </div>
  )
}

export default Chat
