/**
 * EngineStatus.tsx — todo30b 设置页「引擎状态」区
 *
 * 数据流（lane-30 交付的 channels，spec 逐条对应）：
 *   mount → invoke('engines:status') → availability 矩阵 (engine|source|version|platform)
 *     + NVIDIA 检测卡（detectNvidia summary，含显存 GB 行）
 *     + manifest 摘要（present/generatedAt/variants → GPU 包按钮矩阵）
 *   按钮点击 → invoke('engines:gpuDownload',{engine,variant}) → {ok:true} 仅表示已启动；
 *     进度经 'engines:progress' 事件回流（downloading/verifying/activating → done）
 *   终态 quarantined → 红色 toast「GPU 包损坏，已回退 CPU」（plan QA-fail 场景）
 *
 * 禁用逻辑：无 NVIDIA → tooltip 说明；manifest 缺席（todo34 CI 未出）→
 * tooltip「dev模式:由 CI 生成」且按钮禁用（引擎区仍渲染 CPU 矩阵与检测卡）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EnginesGpuDownloadReply,
  EnginesProgressEvent,
  EnginesStatusReply,
} from '../../../../main/ipc/whitelist'
import './enginestatus.css'

/** 无 manifest 变体表时的兜底展示集（与 manifest.MANIFEST_ENGINES 对齐，仅 llama/sd 有 UI 意义）。 */
const GPU_ENGINES_FALLBACK = ['llama', 'sd'] as const

const SOURCE_LABELS: Record<string, string> = {
  system: '系统',
  'bundled-cpu': '内置CPU',
  'gpu-pack': 'GPU包',
  none: '缺失',
}

const STATE_LABELS: Record<EnginesProgressEvent['state'], string> = {
  downloading: '下载中',
  verifying: '校验中',
  activating: '激活中',
  done: '完成',
  quarantined: '已隔离',
  error: '失败',
}

function progressPercent(p: EnginesProgressEvent): number {
  if (p.total <= 0) return 0
  return Math.min(100, Math.round((p.received / p.total) * 100))
}

export function EngineStatus(): React.JSX.Element {
  const [status, setStatus] = useState<EnginesStatusReply | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, EnginesProgressEvent>>({})
  const [toast, setToast] = useState<{ danger: boolean; text: string } | null>(null)
  // status 与事件回调共享的最新快照（避免 on 订阅闭包过期）
  const fetchRef = useRef<() => Promise<void>>(async () => undefined)

  const fetchStatus = useCallback(async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) {
      setLoadError('未检测到 window.api — 引擎状态仅在 Electron 主窗口内可用')
      return
    }
    try {
      const reply = (await api.invoke('engines:status', {})) as EnginesStatusReply
      if (reply?.ok === true) {
        setStatus(reply)
        setLoadError(null)
      } else {
        setLoadError(`engines:status 失败 — ${reply.ok === false ? reply.error : '应答格式异常'}`)
      }
    } catch (e) {
      setLoadError(`engines:status 失败 — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])
  fetchRef.current = fetchStatus

  useEffect(() => {
    void fetchStatus()
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    const listener = (ev: EnginesProgressEvent): void => {
      const key = `${ev.engine}:${ev.variant}`
      const isTerminal = ev.state === 'done' || ev.state === 'quarantined' || ev.state === 'error'
      if (isTerminal) {
        setProgress((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        if (ev.state === 'done') {
          setToast({ danger: false, text: `GPU 包 ${ev.engine}·${ev.variant} 已激活` })
          void fetchRef.current()
        } else if (ev.state === 'quarantined') {
          setToast({ danger: true, text: ev.note ?? 'GPU 包损坏，已回退 CPU' })
        } else {
          setToast({ danger: true, text: ev.note ?? 'GPU 包下载失败' })
        }
        return
      }
      setProgress((prev) => ({ ...prev, [key]: ev }))
    }
    const unsubscribe = api.on('engines:progress', listener)
    return unsubscribe
  }, [fetchStatus])

  const startDownload = useCallback(async (engine: string, variant: string): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    const reply = (await api.invoke('engines:gpuDownload', { engine, variant })) as EnginesGpuDownloadReply
    if (reply.ok !== true) {
      const reason = reply.error === 'manifest-missing' ? 'manifest 缺席（dev模式:由 CI 生成）' : reply.error
      setToast({ danger: true, text: `GPU 包下载未启动 — ${reason}` })
    }
  }, [])

  const ok = status?.ok === true ? status : null
  const nvidiaAvailable = ok?.nvidia?.available === true
  const manifestPresent = ok?.manifest?.present === true

  const variantRows: Array<{ engine: string; variant: string }> = []
  if (manifestPresent && ok?.manifest) {
    for (const [engine, variants] of Object.entries(ok.manifest.variants)) {
      for (const variant of variants ?? []) variantRows.push({ engine, variant })
    }
  } else {
    for (const engine of GPU_ENGINES_FALLBACK) variantRows.push({ engine, variant: 'cuda' })
  }

  const buttonDisabled = !nvidiaAvailable || !manifestPresent
  const buttonTitle = !nvidiaAvailable
    ? '未检测到 NVIDIA 显卡 — GPU 包不可用（CPU 解析仍工作）'
    : !manifestPresent
      ? 'dev模式:由 CI 生成'
      : '下载并激活 GPU 加速包（sha256 验证后原子切换）'

  return (
    <section className="las-settings-group las-engine" aria-label="引擎">
      <h2 className="las-settings-group-title">
        引擎状态
        <button
          type="button"
          className="las-engine-refresh"
          onClick={() => void fetchStatus()}
          title="重新探测（resolver.invalidate + availability）"
        >
          刷新
        </button>
      </h2>
      {loadError ? (
        <p className="las-settings-warn las-engine-load-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {toast ? (
        <p
          className={`las-engine-toast las-engine-toast-${toast.danger ? 'danger' : 'info'}`}
          role="alert"
        >
          {toast.text}
        </p>
      ) : null}
      {ok ? (
        <>
          <table className="las-engine-matrix" aria-label="引擎可用性矩阵">
            <thead>
              <tr>
                <th>引擎</th>
                <th>来源</th>
                <th>版本</th>
                <th>平台</th>
              </tr>
            </thead>
            <tbody>
              {ok.resolutions.map((r) => (
                <tr key={r.name} className={`las-engine-row las-engine-src-${r.source}`}>
                  <td title={r.bin ?? (r.skipped.length > 0 ? r.skipped.map((s) => s.reason).join('; ') : '未命中')}>
                    {r.name}
                  </td>
                  <td>{SOURCE_LABELS[r.source] ?? r.source}</td>
                  <td>{r.version ?? '—'}</td>
                  <td>{ok.platform}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={`las-engine-nvidia${nvidiaAvailable ? ' las-engine-nvidia-on' : ''}`}>
            {nvidiaAvailable ? (
              <>
                <span className="las-engine-nvidia-name">{ok.nvidia?.name}</span>
                <span className="las-engine-nvidia-vram">
                  显存 {((ok.nvidia?.memoryMB ?? 0) / 1024).toFixed(1)} GB
                </span>
                {ok.nvidia?.driverVersion ? (
                  <span className="las-engine-nvidia-driver">驱动 {ok.nvidia.driverVersion}</span>
                ) : null}
              </>
            ) : (
              <span>未检测到 NVIDIA 显卡（{ok.nvidia?.reason ?? '检测不可用'}）— 引擎以 CPU 模式运行</span>
            )}
          </div>
          <div className="las-engine-packs">
            {variantRows.map(({ engine, variant }) => {
              const key = `${engine}:${variant}`
              const p = progress[key]
              return (
                <div key={key} className="las-engine-pack">
                  <button
                    type="button"
                    className="las-engine-dl"
                    data-engine={engine}
                    data-variant={variant}
                    disabled={buttonDisabled || p !== undefined}
                    title={buttonTitle}
                    onClick={() => void startDownload(engine, variant)}
                  >
                    下载 GPU 包 · {engine}·{variant}
                  </button>
                  {p ? (
                    <span className="las-engine-progress-slot">
                      <progress className="las-engine-bar" value={String(progressPercent(p))} max="100" />
                      <span className="las-engine-progress-text">
                        {STATE_LABELS[p.state]} {progressPercent(p)}%
                      </span>
                    </span>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      ) : loadError ? null : (
        <p className="las-engine-loading">探测引擎…</p>
      )}
    </section>
  )
}

export default EngineStatus
