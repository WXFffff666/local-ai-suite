/**
 * MessageBubble.tsx — todo15 消息气泡 · todo21 图片内联 + lightbox
 * user = 纯文本（不渲染用户输入的 markdown，防注入面）；assistant = Thinking 折叠
 * + MarkdownMessage（流式不闪、完成高亮）。meta 行文案与 todo11 逐字兼容
 * （ChatPage.test / e2e smoke 依赖 'streaming' 子串与 '· <error>' 形态）。
 * todo21: ChatMessage.images（base64 dataURL）内联渲染，点击 → <dialog> 全尺寸
 * 预览（零新依赖）。只有 isRenderableImageSrc 通过的本地 data-URL 才会生成
 * <img> —— 远端 URL 即使混入存储层也不渲染（schema 是第一道闸，这里是第二道）。
 */
import { useState } from 'react'
import { ScanText, X } from 'lucide-react'
import type { ChatMessage } from '../../../../chat/types'
import { isRenderableImageSrc } from '../../../../chat/vision'
import { Thinking } from '../../../../chat/Thinking'
import { MarkdownMessage } from './MarkdownMessage'

/**
 * todo37 (ADDITIVE): OCR bridge handed down from Chat (ocr:status gates
 * `available`; recognize = ocr:recognize {dataURL}). Without the prop the
 * render tree is byte-identical to pre-37 (characterization-safe).
 */
export type MessageOcrApi = {
  available: boolean
  recognize: (dataUrl: string) => Promise<string>
}

type OcrEntry = { busy: boolean; text?: string; error?: string }

export type MessageBubbleProps = {
  message: ChatMessage
  ocr?: MessageOcrApi
  /** 追加识别文本到聊天输入框（Chat.insertAtCaret，MicButton 同款回调）。 */
  onOcrInsert?: (text: string) => void
}

export function MessageBubble({ message: m, ocr, onOcrInsert }: MessageBubbleProps): React.JSX.Element {
  const isUser = m.role === 'user'
  const pending = Boolean(m.pending)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [ocrState, setOcrState] = useState<Record<number, OcrEntry>>({})
  const images = (m.images ?? []).filter(isRenderableImageSrc)

  const runOcr = async (i: number, url: string): Promise<void> => {
    if (!ocr) return
    setOcrState((s) => ({ ...s, [i]: { busy: true } }))
    try {
      const text = await ocr.recognize(url)
      setOcrState((s) => ({ ...s, [i]: { busy: false, text } }))
    } catch (error) {
      setOcrState((s) => ({ ...s, [i]: { busy: false, error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text)
    } catch {
      /* clipboard denied (jsdom/dev) — text stays visible for manual copy */
    }
  }

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
      {images.length > 0 && (
        <div className="las-msg-images" data-testid="msg-images">
          {images.map((url, i) => (
            <span key={`${i}:${url.slice(-12)}`} className="las-msg-image-wrap">
              <button
                type="button"
                className="las-msg-image"
                aria-label={`放大图片 ${i + 1}`}
                onClick={() => setLightbox(url)}
              >
                <img src={url} alt={`${m.role} 附图 ${i + 1}`} loading="lazy" />
              </button>
              {ocr ? (
                <button
                  type="button"
                  className="las-msg-ocr-btn"
                  aria-label={`提取文字 ${i + 1}`}
                  data-testid={`msg-ocr-btn-${i}`}
                  disabled={!ocr.available || Boolean(ocrState[i]?.busy)}
                  title={ocr.available ? '本地 OCR 提取文字' : 'OCR 引擎未安装 — 到 设置 → OCR 下载'}
                  onClick={() => void runOcr(i, url)}
                >
                  <ScanText size={14} aria-hidden />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}
      {ocr && images.length > 0
        ? images.map((_, i) => {
            const entry = ocrState[i]
            if (!entry) return null
            return (
              <div key={`ocr-${i}`} className="las-msg-ocr-result" data-testid={`msg-ocr-${i}`}>
                {entry.busy ? <span className="las-msg-ocr-busy">识别中…</span> : null}
                {entry.error ? <span className="las-msg-ocr-error" role="alert">{`提取失败 — ${entry.error}`}</span> : null}
                {entry.text !== undefined ? (
                  <>
                    <pre className="las-msg-ocr-text">{entry.text}</pre>
                    <div className="las-msg-ocr-actions">
                      <button type="button" onClick={() => void copyText(entry.text ?? '')}>
                        复制
                      </button>
                      {onOcrInsert ? (
                        <button
                          type="button"
                          data-testid={`msg-ocr-insert-${i}`}
                          onClick={() => onOcrInsert(entry.text ?? '')}
                        >
                          追加到输入框
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            )
          })
        : null}
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
      {lightbox !== null && (
        <dialog
          open
          className="las-img-lightbox"
          data-testid="img-lightbox"
          onClick={(e) => {
            // 点击背板/关闭按钮都收敛到 dialog 自身边界判断
            if (e.target === e.currentTarget) setLightbox(null)
          }}
        >
          <button
            type="button"
            className="las-img-lightbox-close"
            aria-label="close-lightbox"
            onClick={() => setLightbox(null)}
          >
            <X size={18} aria-hidden />
          </button>
          <img src={lightbox} alt="图片全尺寸预览" />
        </dialog>
      )}
    </div>
  )
}

export default MessageBubble
