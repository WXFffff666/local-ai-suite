/** Chat 页占位 — 由 todo11（IPC 流式）/ todo15（markdown 打磨）接入实装 */
export function ChatPage(): React.JSX.Element {
  return (
    <section className="las-page" aria-labelledby="page-title-chat">
      <h1 id="page-title-chat" className="las-page-title">
        Chat
      </h1>
      <p className="las-page-subtitle">本地模型对话</p>
      <div className="las-page-card">
        占位页面 — 由 todo 11（chat:send IPC 流式 + abort）与 todo 15（markdown/代码块/预设）接线实装。
      </div>
    </section>
  )
}

export default ChatPage
