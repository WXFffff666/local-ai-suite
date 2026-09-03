/**
 * MessageBubble.tsx — todo15 消息气泡
 * user = 纯文本（不渲染用户输入的 markdown，防注入面）；assistant = Thinking 折叠
 * + MarkdownMessage（流式不闪、完成高亮）。meta 行文案与 todo11 逐字兼容
 * （ChatPage.test / e2e smoke 依赖 'streaming' 子串与 '· <error>' 形态）。
 */
import type { ChatMessage } from '../../../../chat/types'
import { Thinking } from '../../../../chat/Thinking'
import { MarkdownMessage } from './MarkdownMessage'

export type MessageBubbleProps = {
  message: ChatMessage
}

export function MessageBubble({ message: m }: MessageBubbleProps): React.JSX.Element {
  const isUser = m.role === 'user'
  const pending = Boolean(m.pending)
  return (
    <div
      className={`las-bubble${isUser ? ' las-bubble--user' : ' las-bubble--assistant'}`}
      data-error={m.error ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
    >
      <div className="las-bubble-meta">
        {m.role}
        {m.pending ? ' · streaming…' : ''}
        {m.error ? ` · ${m.error}` : ''}
      </div>
      {m.role === 'assistant' && m.reasoning ? (
        <div style={{ marginBottom: 6 }}>
          <Thinking content={m.reasoning} isStreaming={pending} hideWhenEmpty />
        </div>
      ) : null}
      {isUser ? (
        <div className="las-bubble-text">{m.content}</div>
      ) : m.content ? (
        <>
          <MarkdownMessage content={m.content} streaming={pending} />
          {pending ? (
            <span className="las-cursor" aria-hidden>
              {' ▍'}
            </span>
          ) : null}
        </>
      ) : pending ? (
        <span className="las-bubble-pending">…</span>
      ) : null}
    </div>
  )
}

export default MessageBubble
