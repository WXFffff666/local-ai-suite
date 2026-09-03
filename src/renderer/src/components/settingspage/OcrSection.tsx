/**
 * OcrSection.tsx — todo37 设置页「本地 OCR」区（SpeechSection 数据流同款）：
 *   mount → ocr:status（不 spawn 引擎、不下载）→ 引擎来源 / 版本 / 就绪行；
 *   「下载引擎」→ ocr:install（ack），进度走 'ocr:progress' 事件
 *   （downloading→verifying→activating→done / quarantined / error）。
 * 引擎包（PaddleOCR-json v1.4.1，win-x64 pinned 92.7 MB .7z）按需下载到
 * userData/engines，sha256 校验后原子激活 — 绝不捆绑安装包（plan 体积红线）。
 * OCR 无用户模型文件（引擎自带 models/），故本区无「选择模型」（与语音差异）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OcrInstallReply, OcrProgressEvent, OcrStatusReply } from '../../../../main/ipc/whitelist'

const ENGINE_SOURCE_LABELS: Record<string, string> = {
  env: '环境变量 OCR_BIN',
  pack: '按需下载包（userData/engines · sha256 钉校验）',
  none: '未安装',
}

type StatusOk = Extract<OcrStatusReply, { ok: true }>
type InstallUi = { state: OcrProgressEvent['state'] | null; percent: number; note: string | null }

export function OcrSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<StatusOk | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [install, setInstall] = useState<InstallUi>({ state: null, percent: 0, note: null })
  const installRef = useRef(install)
  installRef.current = install

  const fetchStatus = useCallback(async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    try {
      const reply = (await api.invoke('ocr:status', {})) as OcrStatusReply
      if (reply?.ok === true) {
        setStatus(reply)
        setNote(null)
      } else if (reply) {
        setNote(`OCR 状态读取失败 — ${reply.ok === false ? reply.error : '应答格式异常'}`)
      }
    } catch {
      setNote('ocr:status 失败 — 本地 OCR 暂不可用')
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  // 安装进度订阅（on 返回 unsubscribe；done 后刷新状态）
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    return api.on('ocr:progress', (ev: OcrProgressEvent) => {
      const percent =
        ev.total > 0 ? Math.round((ev.received / ev.total) * 100) : ev.state === 'downloading' ? 0 : 100
      setInstall({ state: ev.state, percent, note: ev.note ?? null })
      if (ev.state === 'done' || ev.state === 'quarantined' || ev.state === 'error') {
        void fetchStatus()
      }
    })
  }, [fetchStatus])

  const startInstall = useCallback(async (): Promise<void> => {
    const api = window.api
    if (!api) return
    const reply = (await api.invoke('ocr:install', {})) as OcrInstallReply
    if (!reply.ok) {
      setInstall((i) => ({ ...i, note: `无法开始下载 — ${reply.error}` }))
      if (reply.error === 'already-installed') void fetchStatus()
      return
    }
    setInstall({ state: 'downloading', percent: 0, note: null })
  }, [fetchStatus])

  if (status === null) {
    // window.api 缺席（纯浏览器预览）或首次读取失败：整区隐藏，不干扰其余设置断言。
    if (note === null || typeof window === 'undefined' || !window.api) return null
  }

  const s = status
  const busy = install.state === 'downloading' || install.state === 'verifying' || install.state === 'activating'
  return (
    <section className="las-settings-group" aria-label="本地 OCR">
      <h2 className="las-settings-group-title">本地 OCR（图片提取文字 · PaddleOCR-json）</h2>
      {note !== null ? <p className="las-settings-note">{note}</p> : null}
      {s ? (
        <>
          <div className="las-settings-row">
            <span className="las-settings-label">引擎来源</span>
            <code className="las-settings-value" data-testid="ocr-engine-source" title={s.engine.bin ?? ''}>
              {ENGINE_SOURCE_LABELS[s.engine.source] ?? s.engine.source}
              {s.engine.version ? ` · ${s.engine.version}` : ''}
            </code>
            <span className="las-settings-note" data-testid="ocr-ready">
              {!s.supported ? '当前平台不支持（仅 win-x64）' : s.engine.source === 'none' ? '未安装' : '就绪'}
              {s.running ? ' · 引擎运行中' : ''}
            </span>
          </div>
          <div className="las-settings-row">
            <span className="las-settings-label">引擎包（约 93 MB，按需下载）</span>
            <button
              type="button"
              data-testid="ocr-install"
              disabled={!s.supported || s.engine.source === 'pack' || busy}
              onClick={() => void startInstall()}
            >
              {busy ? `下载/安装中… ${install.percent}%` : s.engine.source === 'pack' ? '已安装' : '下载引擎'}
            </button>
          </div>
          {busy ? <progress className="las-settings-progress" max={100} value={install.percent} data-testid="ocr-progress" /> : null}
          {install.note ? <p className="las-settings-note" data-testid="ocr-install-note">{install.note}</p> : null}
          <p className="las-settings-note">
            识别全程本地闭环（stdin/stdout JSON 协议子进程，零网络、零落盘临时图）；
            聊天贴图与画廊条目的「提取文字」入口在引擎就绪后自动可用。
          </p>
        </>
      ) : null}
    </section>
  )
}

export default OcrSection
