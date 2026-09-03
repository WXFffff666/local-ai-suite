/**
 * CopyButton.tsx — todo15 通用复制按钮（代码块 + 消息原文共用）
 * navigator.clipboard 优先，缺失/拒绝时回退隐藏 textarea + execCommand；
 * 两路都失败也不抛错（静默），仅给出临时 "Copied" 反馈避免 UI 死透。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type CopyButtonProps = {
  text: string
  /** 未复制时的按钮文案 */
  label?: string
  className?: string
}

export function CopyButton({ text, label = 'Copy', className }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  const onCopy = useCallback((): void => {
    try {
      void navigator.clipboard.writeText(text)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      } catch {
        /* 环境不允许复制：静默，仅保留 UI 反馈 */
      }
    }
    setCopied(true)
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }, [text])

  return (
    <button
      type="button"
      className={className ?? 'las-copy-btn'}
      onClick={onCopy}
      aria-label={copied ? 'copied' : 'copy to clipboard'}
      data-copied={copied ? 'true' : 'false'}
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

export default CopyButton
