/** Chat 页 — todo11 实装：IPC 流式对话（chat:send / chat:abort + delta/done/error 事件） */
import { Chat } from '../../../chat/Chat'

export function ChatPage(): React.JSX.Element {
  return (
    <section className="las-page" aria-labelledby="page-title-chat" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <h1 id="page-title-chat" className="las-page-title">
        Chat
      </h1>
      <p className="las-page-subtitle">本地模型对话 · 主进程转发流式</p>
      <div className="las-page-card" style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 0 }}>
        <Chat />
      </div>
    </section>
  )
}

export default ChatPage
