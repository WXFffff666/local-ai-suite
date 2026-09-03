/**
 * SecretRow.tsx — todo16 密钥掩码编辑行（MaskedInput 模式）
 *
 * 显示态：invoke('secrets:decrypt', encPayload) → 明文 → maskSecret 脱敏回显。
 * 编辑态：新值经 invoke('secrets:encrypt', draft) 得 enc:v1:/enc:fallback:v1:
 * 载荷后由 onSave 交给页面 config:set 落盘 —— 明文只存在于内存与 IPC，永不写盘。
 * encrypt 应答带 warning（os-storage-unavailable）→ 显示降级告警条。
 */
import { useEffect, useState } from 'react'
import { maskSecret } from './types'

export type SecretRowProps = {
  label: string
  hint?: string
  placeholder?: string
  /** config 中已落盘的加密载荷（'' = 未配置）。 */
  payload: string
  /** 解密（main safeStorage）；window.api 缺失时返回 null。 */
  decrypt: (payload: string) => Promise<string | null>
  /** 加密并回传载荷；onSave 负责持久化，返回 false = 保存失败。 */
  commit: (plain: string) => Promise<{ ok: boolean; warning?: string }>
}

export function SecretRow({ label, hint, placeholder, payload, decrypt, commit }: SecretRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [display, setDisplay] = useState('未配置')
  const [busy, setBusy] = useState(false)
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!payload) {
      setDisplay('未配置')
      return
    }
    void decrypt(payload).then((plain) => {
      if (cancelled) return
      setDisplay(plain === null ? '无法解密（系统钥匙串不可用）' : maskSecret(plain))
    })
    return () => {
      cancelled = true
    }
  }, [payload, decrypt])

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setWarning(null)
    const value = draft.trim()
    const reply = await commit(value)
    setBusy(false)
    if (!reply.ok) {
      setError('保存失败 — 密钥加密或落盘未完成')
      return
    }
    if (reply.warning) setWarning('OS 安全存储不可用，已使用可逆回退编码（建议配置系统钥匙串）')
    setDraft('')
    setEditing(false)
  }

  return (
    <div className="las-setting-secret">
      <label className="las-setting-secret-label">{label}</label>
      {editing ? (
        <div className="las-setting-secret-edit">
          <input
            type="text"
            className="las-setting-secret-input"
            value={draft}
            placeholder={placeholder ?? '粘贴新密钥，留空清除'}
            aria-label={label}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <button type="button" className="las-setting-secret-save" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="las-setting-secret-cancel"
            onClick={() => {
              setEditing(false)
              setDraft('')
            }}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="las-setting-secret-view">
          <code className="las-setting-secret-mask">{display}</code>
          <button type="button" className="las-setting-secret-edit-btn" onClick={() => setEditing(true)}>
            {payload ? '编辑' : '设置'}
          </button>
        </div>
      )}
      {warning ? (
        <p className="las-setting-secret-warning" role="alert">
          {warning}
        </p>
      ) : null}
      {error ? (
        <p className="las-setting-secret-error" role="alert">
          {error}
        </p>
      ) : null}
      {hint ? <p className="las-setting-secret-hint">{hint}</p> : null}
    </div>
  )
}
