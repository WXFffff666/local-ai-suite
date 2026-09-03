/** Chat 页 — todo11 实装流式对话；todo17 增加左侧会话侧栏（chat.db 持久化），仅布局包裹，不改 Chat 内部
 *  todo29: 根级挂载 PermissionDialogHost（代理审批对话框，全局单例；无 window.api 时渲染 null），
 *  模式开关/时间线/终端抽屉由 Chat 内部的 agentui 组件承担（agent 面板只在会话前台可见）。*/
import { Chat } from '../../../chat/Chat'
import ConversationSidebar from '../components/conversations/ConversationSidebar'
import PermissionDialogHost from '../components/permission/PermissionDialogHost'

export function ChatPage(): React.JSX.Element {
  return (
    <section className="las-page" aria-labelledby="page-title-chat" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <h1 id="page-title-chat" className="las-page-title">
        Chat
      </h1>
      <p className="las-page-subtitle">本地模型对话 · 主进程转发流式 · 会话持久化于 chat.db</p>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 12, alignItems: 'stretch' }}>
        <ConversationSidebar />
        <div className="las-page-card" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', padding: 0 }}>
          <Chat />
        </div>
      </div>
      <PermissionDialogHost />
    </section>
  )
}

export default ChatPage
