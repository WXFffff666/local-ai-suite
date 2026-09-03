/**
 * DirControl.tsx — todo13 模型目录切换控件
 * 文本输入绝对路径 → invoke 'models:setDir' {path}。
 * 成功应答携带 restartRequired — 诚实呈现「目录监听重启后生效」（registry 实例
 * 由 services.ts 在启动时绑定，热切 watcher 不在本 lane 权限内）。
 */
import { useState } from 'react'
import type { SetDirReply } from './types'

export type DirControlProps = {
  /** 当前生效目录（config.modelsDir）。 */
  modelsDir: string
  /** 提交绝对路径；返回 main 侧应答（null = window.api 不可用）。 */
  onSubmit: (path: string) => Promise<SetDirReply | null>
}

const ERROR_TEXT: Record<string, string> = {
  'path-not-absolute': '请输入绝对路径（如 D:\\models）',
  'dir-not-found': '目录不存在或不是文件夹',
  'invalid-payload': '路径不合法',
}

export function DirControl({ modelsDir, onSubmit }: DirControlProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = async (): Promise<void> => {
    const p = draft.trim()
    if (!p || busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const reply = await onSubmit(p)
      if (reply === null) setError('未检测到 window.api — 目录切换仅在应用内可用')
      else if (reply.ok) setNote(reply.restartRequired ? '目录已保存 — 模型监听将在重启应用后指向新目录' : '目录已保存并重载')
      else setError(ERROR_TEXT[reply.error] ?? `设置失败：${reply.error}`)
    } catch (e) {
      setError(`models:setDir 调用失败 — ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="las-models-dir">
      <span className="las-models-dir-label">模型目录</span>
      <code className="las-models-dir-current">{modelsDir || '（默认 models/）'}</code>
      <input
        className="las-models-dir-input"
        type="text"
        value={draft}
        placeholder="绝对路径，例如 E:\ai\models"
        aria-label="新模型目录绝对路径"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void apply()
        }}
      />
      <button type="button" className="las-models-dir-apply" disabled={busy || !draft.trim()} onClick={() => void apply()}>
        {busy ? '保存中…' : '切换目录'}
      </button>
      {note ? <p className="las-models-dir-note">{note}</p> : null}
      {error ? (
        <p className="las-models-dir-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
