/**
 * ExportHtmlButton.tsx — todo42 聊天头部「导出 HTML」入口（additive）。
 *
 * 组合在渲染层（buildChatHtml：与在线聊天同一 sanitize 管线 + 内联样式/图片），
 * 主进程只管文件名净化 + save dialog + 落盘（chat:exportHtml）。无 window.api
 * （纯浏览器预览/vitest 壳）时按钮禁用而非隐藏 —— 诚实不可用，与 Chat 头部
 * 其他动作同一姿态。'cancelled' 是良性的用户取消，不弹错误 toast。
 */
import { useState } from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { buildChatHtml } from './chatHtml'
import type { ChatSession } from '../../../../chat/types'
import type { ChatExportHtmlReply } from '../../../../main/ipc/whitelist'

export type ExportHtmlButtonProps = {
  session: ChatSession
}

function hasApi(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.invoke === 'function'
}

export function ExportHtmlButton({ session }: ExportHtmlButtonProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const available = hasApi()
  const disabled = !available || busy || session.messages.length === 0

  const onClick = async (): Promise<void> => {
    if (disabled) return
    setBusy(true)
    try {
      const html = buildChatHtml({
        title: session.title,
        // 流式占位不导出（空串占位本会被 messageNode 跳过 — 这里显式剔除
        // 半截 pending，导出永远是已定稿消息）。
        messages: session.messages.filter((m) => m.pending !== true),
      })
      const reply = (await window.api.invoke('chat:exportHtml', {
        html,
        filename: session.title,
      })) as ChatExportHtmlReply | undefined
      if (reply?.ok === true) {
        toast.success('已导出 HTML', { description: reply.path })
      } else if (reply?.ok === false && reply.error === 'cancelled') {
        // 用户取消保存对话框 — 良性，不打扰。
      } else {
        // reply union: detail 只挂在 'cancelled'|'write-failed'|'not-ready' 臂 —
        // 用 in 收窄，不在联合上直取（严格模式下非法属性是编译错误）。
        const description =
          reply && reply.ok === false
            ? ('detail' in reply && typeof reply.detail === 'string' ? reply.detail : undefined) ?? reply.error
            : 'no-reply'
        toast.error('导出失败', { description })
      }
    } catch (error) {
      toast.error('导出失败', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      data-testid="export-html-button"
      title={available ? '导出当前会话为单文件 HTML（离线可读，无脚本）' : '桌面端运行时可导出'}
      disabled={disabled}
      onClick={() => void onClick()}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <Download size={14} aria-hidden style={{ verticalAlign: 'middle', marginRight: 4 }} />
      {busy ? '…' : '导出'}
    </button>
  )
}

export default ExportHtmlButton
