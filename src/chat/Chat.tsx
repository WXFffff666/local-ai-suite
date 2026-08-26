import { useState, useRef } from 'react'
import { useChatStore } from './store'

export function Chat(): React.JSX.Element {
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const cur = sessions.find((s) => s.id === currentId) ?? null

  const handleSend = async (): Promise<void> => {
    const t = input.trim()
    if (!t || streaming) return
    setInput('')
    await send(t)
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui,sans-serif' }}>
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

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#111', color: '#e6e6e6' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #222', display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong style={{ flex: 1 }}>{cur ? cur.title : 'Select or create a chat'}</strong>
          {cur && <button onClick={clearCurrentMessages} style={{ cursor: 'pointer' }}>Clear</button>}
          {streaming && <button onClick={abort} style={{ cursor: 'pointer', color: '#f55' }}>Abort</button>}
          {!streaming && error && <button onClick={() => void retry()} style={{ cursor: 'pointer' }}>Retry</button>}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cur?.messages.map((m) => (
            <div key={m.id} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '78%', background: m.role === 'user' ? '#1a3a5a' : '#1e1e1e', padding: '10px 12px', borderRadius: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: m.error ? '1px solid #a33' : '1px solid #2a2a2a' }}>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{m.role}{m.pending ? ' · streaming…' : ''}{m.error ? ` · ${m.error}` : ''}</div>
              {m.reasoning ? <div style={{ fontSize: 12, color: '#9ab', marginBottom: 6, borderLeft: '2px solid #334', paddingLeft: 8, whiteSpace: 'pre-wrap' }}>{m.reasoning}</div> : null}
              <div>{m.content || (m.pending ? '…' : '')}</div>
            </div>
          ))}
          {!cur && <div style={{ color: '#666' }}>Create a new chat to start. Streaming via SSE delta.content / reasoning_content透传.</div>}
          {cur && cur.messages.length === 0 && <div style={{ color: '#666' }}>No messages — say hello.</div>}
          {error && error !== 'aborted' && <div style={{ color: '#f88', fontSize: 12 }}>Error: {error}</div>}
        </div>

        <div style={{ padding: 12, borderTop: '1px solid #222', display: 'flex', gap: 8 }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() }
            }}
            placeholder="Type a message… (Enter to send, Shift+Enter newline)"
            rows={2}
            style={{ flex: 1, resize: 'none', padding: 10, borderRadius: 8, border: '1px solid #333', background: '#0f0f0f', color: '#eee' }}
            disabled={streaming}
          />
          <button onClick={() => void handleSend()} disabled={streaming || !input.trim()} style={{ padding: '0 18px', cursor: streaming ? 'not-allowed' : 'pointer' }}>
            {streaming ? '…' : 'Send'}
          </button>
        </div>
      </main>
    </div>
  )
}

export default Chat
