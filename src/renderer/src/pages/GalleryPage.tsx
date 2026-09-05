/**
 * Gallery 页 — todo37 实装「条目列表 + 本地 OCR」。
 * (原占位页；生图/复用表单在 ImagePage，本页专注画廊动作。)
 *
 * 数据流：mount → gallery:list（主进程 Gallery 注册表，含 canonical
 * originalPath）→ 卡片（id/prompt/时间）。每卡「识别文字」→
 * ocr:recognize {galleryId}（路径由 MAIN 侧经 Gallery.get 复核，渲染层
 * 从不提交文件系统路径）→ 文本结果 + 复制。引擎缺失/平台不支持时按钮
 * 禁用并提示去 设置 → OCR 下载（plan QA-fail 场景）。
 * 非 Electron（window.api 缺失）诚实降级为只读空态，不崩页。
 */
import { useCallback, useEffect, useState } from 'react'
import type { AllowedChannel, OcrRecognizeReply, OcrStatusReply } from '../../../main/ipc/whitelist'
import { useHashRoute } from '../hashRouter'

type ApiLike = {
  invoke: (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>
}

function getApi(): ApiLike | undefined {
  return typeof window === 'undefined' ? undefined : (window.api as unknown as ApiLike | undefined)
}

/** 渲染层自持镜像（同 imagepage/apiTypes 惯例；src/gallery 不在 tsconfig.web 域内） */
type GalleryItemWire = { id: string; prompt: string; createdAt: number }
type GalleryListReply = { items?: GalleryItemWire[] }

type OcrEntry = { busy: boolean; text?: string; error?: string }

/** 复用参数跨页交接（sessionStorage；ImagePage 挂载时消费后清除） */
export const GALLERY_REUSE_KEY = 'las:gallery-reuse-params'

export function GalleryPage(): React.JSX.Element {
  const [items, setItems] = useState<GalleryItemWire[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [engineReady, setEngineReady] = useState(false)
  const [ocrState, setOcrState] = useState<Record<string, OcrEntry>>({})
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [lightbox, setLightbox] = useState<string | null>(null)
  const { navigate } = useHashRoute()

  const api = getApi()

  useEffect(() => {
    if (!api) return
    let cancelled = false
    void (async () => {
      try {
        const list = (await api.invoke('gallery:list')) as GalleryListReply
        const listed = list.items ?? []
        if (!cancelled) setItems(listed)
        // 阶段4：缩略图懒加载（并发 4，逐批拉取 thumb.png base64）
        const load = async (): Promise<void> => {
          for (let i = 0; i < listed.length; i += 4) {
            const batch = listed.slice(i, i + 4)
            const entries = await Promise.all(
              batch.map(async (it) => {
                try {
                  const r = (await api.invoke('gallery:readImage', { id: it.id, kind: 'thumb' })) as { ok?: boolean; b64?: string }
                  return r?.ok === true && typeof r.b64 === 'string' ? ([it.id, r.b64] as const) : null
                } catch {
                  return null
                }
              }),
            )
            if (cancelled) return
            setThumbs((prev) => {
              const next = { ...prev }
              for (const e of entries) if (e !== null) next[e[0]] = e[1]
              return next
            })
          }
        }
        void load()
      } catch (e) {
        if (!cancelled) setLoadError(`画廊读取失败：${(e as Error).message}`)
      }
      try {
        const st = (await api.invoke('ocr:status', {})) as OcrStatusReply
        if (!cancelled && st?.ok === true) setEngineReady(st.supported && st.engine.source !== 'none')
      } catch {
        if (!cancelled) setEngineReady(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api])

  const runOcr = useCallback(
    async (id: string): Promise<void> => {
      const a = getApi()
      if (!a) return
      setOcrState((s) => ({ ...s, [id]: { busy: true } }))
      try {
        const reply = (await a.invoke('ocr:recognize', { galleryId: id })) as OcrRecognizeReply
        if (reply?.ok === true) {
          setOcrState((s) => ({ ...s, [id]: { busy: false, text: reply.text } }))
        } else {
          const detail = reply && reply.ok === false ? (reply.detail ?? reply.error) : 'unknown'
          setOcrState((s) => ({ ...s, [id]: { busy: false, error: detail } }))
        }
      } catch (e) {
        setOcrState((s) => ({ ...s, [id]: { busy: false, error: (e as Error).message } }))
      }
    },
    [],
  )

  const reuseParams = useCallback(
    async (id: string): Promise<void> => {
      const a = getApi()
      if (!a) return
      try {
        const reply = (await a.invoke('gallery:reuse', { id })) as { ok?: boolean; params?: unknown }
        if (reply?.ok === true && reply.params) {
          try {
            sessionStorage.setItem(GALLERY_REUSE_KEY, JSON.stringify(reply.params))
          } catch {
            /* storage unavailable — 复用降级为仅导航 */
          }
        }
        navigate('image')
      } catch {
        /* 诚实忽略：复用失败留在画廊页 */
      }
    },
    [navigate],
  )

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text)
    } catch {
      /* clipboard denied — text stays visible for manual copy */
    }
  }

  return (
    <section className="las-page" aria-labelledby="page-title-gallery">
      <h1 id="page-title-gallery" className="las-page-title">
        画廊
      </h1>
      <p className="las-page-subtitle">生图画廊 · 点击缩略图看大图，可把任一条目的参数带回画图页</p>
      {loadError ? (
        <p className="las-page-card" role="alert" data-testid="gallery-error">
          {loadError}
        </p>
      ) : null}
      {!api ? (
        <div className="las-page-card">未检测到 window.api — 画廊仅在 Electron 主窗口内可用。</div>
      ) : items.length === 0 && !loadError ? (
        <div className="las-page-card" data-testid="gallery-empty">
          画廊为空 — 生图完成后条目会自动落盘于此。
        </div>
      ) : (
        <div className="las-gallery-grid" data-testid="gallery-grid">
          {items.map((it) => {
            const entry = ocrState[it.id]
            return (
              <article key={it.id} className="las-page-card las-gallery-item" data-gallery-id={it.id}>
                <header className="las-gallery-item-head">
                  <strong>{it.prompt || it.id}</strong>
                  <span className="las-gallery-item-date">{new Date(it.createdAt).toLocaleString()}</span>
                </header>
                {thumbs[it.id] !== undefined ? (
                  <img
                    className="las-gallery-thumb"
                    src={`data:image/png;base64,${thumbs[it.id]}`}
                    alt={it.prompt || it.id}
                    loading="lazy"
                    onClick={() => setLightbox(thumbs[it.id] ?? null)}
                  />
                ) : null}
                <p className="las-gallery-prompt">{it.prompt}</p>
                <code className="las-gallery-item-id">{it.id}</code>
                <div className="las-gallery-item-actions">
                  <button
                    type="button"
                    data-testid={`gallery-reuse-${it.id}`}
                    onClick={() => void reuseParams(it.id)}
                  >
                    复用参数
                  </button>
                  <button
                    type="button"
                    data-testid={`gallery-ocr-${it.id}`}
                    disabled={!api || !engineReady || Boolean(entry?.busy)}
                    title={engineReady ? '本地 OCR 提取文字' : 'OCR 引擎未安装 — 到 设置 → OCR 下载'}
                    onClick={() => void runOcr(it.id)}
                  >
                    {entry?.busy ? '识别中…' : '识别文字'}
                  </button>
                </div>
                {entry?.error ? (
                  <p className="las-gallery-ocr-error" role="alert">{`提取失败 — ${entry.error}`}</p>
                ) : null}
                {entry?.text !== undefined ? (
                  <div className="las-gallery-ocr-result" data-testid={`gallery-ocr-result-${it.id}`}>
                    <pre className="las-gallery-ocr-text">{entry.text}</pre>
                    <button type="button" onClick={() => void copyText(entry.text ?? '')}>
                      复制
                    </button>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
      {lightbox !== null ? (
        <button
          type="button"
          className="las-lightbox"
          aria-label="关闭大图"
          data-testid="gallery-lightbox"
          onClick={() => setLightbox(null)}
        >
          <img src={`data:image/png;base64,${lightbox}`} alt="大图预览" />
        </button>
      ) : null}
    </section>
  )
}

export default GalleryPage
