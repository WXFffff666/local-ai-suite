/**
 * ImagePage — todo20 生图工作台：文生图/图生图/inpaint 三模式 + 拖放导入 +
 * 蒙版画笔 + 强度滑杆。todo22 的画廊「复用」按钮回填本表单。
 *
 * 数据流：File/canvas dataURL → image:saveTempImage → userData/tmp 绝对路径
 * → image:generate (mode/initImagePath/maskPath/strength/loras) → jobId
 * → image:queue:status 事件推进度 → done 后 gallery:save 落盘。
 * 非 Electron（window.api 缺失）诚实降级，不崩页。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DropImageField } from '../components/imagepage/DropImageField'
import { GenerationFields, type GenerationFieldsValue } from '../components/imagepage/GenerationFields'
import { ImageModeToggle, type ImageMode } from '../components/imagepage/ImageModeToggle'
import { MaskCanvas, type MaskCanvasHandle } from '../components/imagepage/MaskCanvas'
import { StrengthSlider } from '../components/imagepage/StrengthSlider'
import {
  buildGallerySnapshot,
  buildGeneratePayload,
  DEFAULT_SAMPLER,
  fileToDataURL,
  PNG_B64_PREFIX_RE,
  type GalleryListReply,
  type GalleryReuseReply,
  type GenerateReply,
  type QueueStatusReply,
  type SaveTempReply,
} from '../components/imagepage/apiTypes'
import type { AllowedEventChannel, ImageQueueStatusEvent } from '../../../main/ipc/whitelist'
import '../components/imagepage/imagepage.css'

type ApiLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: AllowedEventChannel, listener: (payload: ImageQueueStatusEvent) => void) => () => void
}

function getApi(): ApiLike | undefined {
  return typeof window === 'undefined' ? undefined : (window.api as unknown as ApiLike | undefined)
}

export function ImagePage(): React.JSX.Element {
  const [mode, setMode] = useState<ImageMode>('txt2img')
  const [fields, setFields] = useState<GenerationFieldsValue>({
    prompt: '',
    negative: '',
    width: 512,
    height: 512,
    steps: 20,
    cfg: 7,
    seed: -1,
    model: '',
  })
  const [initImage, setInitImage] = useState<{ path: string; preview: string } | null>(null)
  const [strength, setStrength] = useState(0.75)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [resultB64, setResultB64] = useState<string | null>(null)
  const maskRef = useRef<MaskCanvasHandle>(null)
  const jobIdRef = useRef<string | null>(null)
  /** 提交瞬间的表单快照 — done 回调存画廊用，避免闭包读到后续编辑值 */
  const requestSnapshotRef = useRef<Record<string, unknown> | null>(null)

  const api = getApi()
  const patchFields = (patch: Partial<GenerationFieldsValue>): void => setFields((f) => ({ ...f, ...patch }))

  const onJobDone = useCallback(async (jobId: string): Promise<void> => {
    const a = getApi()
    if (!a) return
    try {
      const status = (await a.invoke('image:queue:status', { jobId })) as QueueStatusReply
      const b64 = status?.job?.result?.b64
      setBusy(false)
      setProgress(100)
      const snap = requestSnapshotRef.current ?? {}
      if (typeof b64 === 'string' && PNG_B64_PREFIX_RE.test(b64)) {
        setResultB64(b64)
        // 落画廊：todo22 会在 original.png 内嵌 parameters tEXt
        const payload: Record<string, unknown> = { b64, ...snap, sampler: DEFAULT_SAMPLER }
        const saved = (await a.invoke('gallery:save', payload)) as SaveTempReply
        if (saved?.ok) setMessage('已保存到画廊')
      } else {
        setMessage('生成完成（结果不含 PNG，未写入画廊）')
      }
    } catch (e) {
      setError(`结果处理失败：${(e as Error).message}`)
      setBusy(false)
    }
  }, [])

  // 队列事件：只跟踪本页面提交的 job（onJobDone 走 ref 保证订阅拿到最新实现）
  const onJobDoneRef = useRef(onJobDone)
  onJobDoneRef.current = onJobDone
  useEffect(() => {
    if (!api) return
    return api.on('image:queue:status', (ev: ImageQueueStatusEvent) => {
      if (ev.jobId !== jobIdRef.current) return
      if (ev.type === 'progress' || ev.type === 'retry') setProgress(ev.progress)
      if (ev.type === 'failed') {
        setBusy(false)
        setError(ev.message ?? '生成失败')
      }
      if (ev.type === 'cancelled') setBusy(false)
      if (ev.type === 'done') void onJobDoneRef.current(ev.jobId)
    })
  }, [api])

  const onFilePicked = useCallback(async (file: File): Promise<void> => {
    setError(null)
    const a = getApi()
    if (!a) {
      setError('未检测到 window.api — 图片导入仅在 Electron 主窗口内可用')
      return
    }
    try {
      const dataURL = await fileToDataURL(file)
      const reply = (await a.invoke('image:saveTempImage', { dataURL })) as SaveTempReply
      if (!reply?.ok || !reply.path) {
        setError(`底图落盘失败：${reply?.error ?? reply?.issues?.[0]?.message ?? 'unknown'}`)
        return
      }
      setInitImage({ path: reply.path, preview: dataURL })
    } catch (e) {
      setError(`底图导入失败：${(e as Error).message}`)
    }
  }, [])

  const generate = async (): Promise<void> => {
    setError(null)
    setMessage(null)
    if (!api) {
      setError('未检测到 window.api — 生图仅在 Electron 主窗口内可用')
      return
    }
    if (!fields.prompt.trim()) {
      setError('请填写提示词')
      return
    }
    // 客户端先行校验：把 QA-fail（inpaint 未涂抹蒙版等）以中文明示，
    // 服务端 zod 400-shape 仍是最终门禁。
    if (mode !== 'txt2img' && initImage === null) {
      setError('缺少底图：图生图/inpaint 需要先导入一张图片（init-image-missing）')
      return
    }
    let maskPath: string | undefined
    if (mode === 'inpaint') {
      const maskDataURL = maskRef.current?.exportPNG() ?? null
      if (maskDataURL === null) {
        setError('缺少蒙版：inpaint 需要先在底图上涂抹（mask-required）')
        return
      }
      const saved = (await api.invoke('image:saveTempImage', { dataURL: maskDataURL })) as SaveTempReply
      if (!saved?.ok || !saved.path) {
        setError(`蒙版落盘失败：${saved?.error ?? saved?.issues?.[0]?.message ?? 'unknown'}`)
        return
      }
      maskPath = saved.path
    }
    // 载荷与画廊快照均由纯函数组装（apiTypes.ts），提交瞬间定格
    const payload = buildGeneratePayload(fields, mode, {
      initImagePath: initImage?.path,
      maskPath,
      strength,
    })
    requestSnapshotRef.current = buildGallerySnapshot(fields, mode, strength)
    setBusy(true)
    setResultB64(null)
    setProgress(0)
    try {
      const reply = (await api.invoke('image:generate', payload)) as GenerateReply
      if (!reply?.ok) {
        setBusy(false)
        const issues = reply?.issues?.map((i) => i.message).join('; ')
        const detail = [reply?.error, issues].filter(Boolean).join(': ') || 'unknown'
        setError(`生成请求被拒绝：${detail}`)
        return
      }
      jobIdRef.current = reply.jobId ?? null
      if (reply.warning) setMessage(reply.warning)
    } catch (e) {
      setBusy(false)
      setError(`生成请求失败：${(e as Error).message}`)
    }
  }

  const reuseLatest = async (): Promise<void> => {
    if (!api) return
    try {
      const list = (await api.invoke('gallery:list')) as GalleryListReply
      const latest = list.items?.[0]
      if (!latest) {
        setMessage('画廊为空，没有可复用的参数')
        return
      }
      const reply = (await api.invoke('gallery:reuse', { id: latest.id })) as GalleryReuseReply
      const p = reply?.params
      if (!p) return
      patchFields({
        prompt: p.prompt ?? '',
        negative: p.negative_prompt ?? '',
        ...(p.width !== undefined ? { width: p.width } : {}),
        ...(p.height !== undefined ? { height: p.height } : {}),
        ...(p.steps !== undefined ? { steps: p.steps } : {}),
        ...(p.cfg_scale !== undefined ? { cfg: p.cfg_scale } : {}),
        ...(p.seed !== undefined ? { seed: p.seed } : {}),
        ...(p.model !== undefined ? { model: p.model } : {}),
      })
      setMessage(`已复用画廊最新条目 ${latest.id} 的参数`)
    } catch (e) {
      setError(`复用失败：${(e as Error).message}`)
    }
  }

  return (
    <section className="las-page" aria-labelledby="page-title-image">
      <h1 id="page-title-image" className="las-page-title">
        Image
      </h1>
      <p className="las-page-subtitle">本地生图 — sd-cli · 127.0.0.1:11436</p>
      <div className="las-page-card las-img-workbench">
        <form
          className="las-img-form"
          onSubmit={(e) => {
            e.preventDefault()
            void generate()
          }}
        >
          <ImageModeToggle value={mode} onChange={setMode} disabled={busy} />
          <GenerationFields value={fields} onChange={patchFields} disabled={busy} />
          {mode !== 'txt2img' ? <StrengthSlider value={strength} onChange={setStrength} disabled={busy} /> : null}
          <div className="las-img-actions">
            <button type="submit" disabled={busy}>
              {busy ? '生成中…' : '生成'}
            </button>
            <button type="button" onClick={() => void reuseLatest()} disabled={busy}>
              复用最新画廊参数
            </button>
          </div>
          {progress !== null ? <progress className="las-img-progress" max={100} value={progress} data-testid="img-progress" /> : null}
          {error ? <p className="las-img-error" role="alert" data-testid="img-error">{error}</p> : null}
          {message ? <p className="las-img-message" data-testid="img-message">{message}</p> : null}
        </form>
        <div className="las-img-side">
          {mode !== 'txt2img' ? (
            <DropImageField
              label="底图（图生图/inpaint）"
              previewURL={initImage?.preview ?? null}
              onFile={(f) => void onFilePicked(f)}
              onClear={() => {
                setInitImage(null)
                maskRef.current?.clear()
              }}
              disabled={busy}
            />
          ) : null}
          {mode === 'inpaint' ? (
            <MaskCanvas ref={maskRef} backgroundURL={initImage?.preview ?? null} onStrokesChange={() => undefined} disabled={busy} />
          ) : null}
          {resultB64 ? <img className="las-img-result" src={`data:image/png;base64,${resultB64}`} alt="生成结果" /> : null}
        </div>
      </div>
    </section>
  )
}

export default ImagePage
