/**
 * LoraPicker.tsx — todo19 LoRA 选择器：models:loraScan 列表 + 多选 +
 * 每项权重滑杆(0..1.5 步进 0.05) + 选中 chips + `<lora:name:scale>` 实时预览；
 * 勾选时懒拉 models:loraMeta（解析失败显示 unknown 但仍可选择）。
 * 挂在 ImagePage 生成面板；value/onChange 受控，提交由 ImagePage 组 loras 载荷。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  LORA_SCALE_DEFAULT,
  LORA_SCALE_MAX,
  LORA_SCALE_MIN,
  LORA_SCALE_STEP,
  invokeLoraMeta,
  invokeLoraScan,
  loraMetaSummary,
  loraTag,
  loraTagPreview,
  type LoraFile,
  type LoraMetaReply,
  type LoraSelection
} from './loraShared'
import type { AllowedChannel } from '../../../../main/ipc/whitelist'
import './lora.css'

type LoraApi = {
  invoke: (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>
}

function getApi(): LoraApi | undefined {
  return typeof window === 'undefined' ? undefined : (window.api as LoraApi | undefined)
}

export type LoraPickerProps = {
  value: LoraSelection[]
  onChange: (next: LoraSelection[]) => void
  disabled?: boolean
}

type ScanPhase = 'loading' | 'ready' | 'unavailable'
/** unavailable 的两种成因：非 Electron 环境 vs scan invoke 抛错（文案区分）。 */
type UnavailableReason = 'no-api' | 'scan-failed'

export function LoraPicker({ value, onChange, disabled }: LoraPickerProps): React.JSX.Element {
  const [files, setFiles] = useState<LoraFile[]>([])
  const [phase, setPhase] = useState<ScanPhase>('loading')
  const [unavailableReason, setUnavailableReason] = useState<UnavailableReason>('no-api')
  const [meta, setMeta] = useState<Record<string, LoraMetaReply>>({})
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    const api = getApi()
    if (!api) {
      setUnavailableReason('no-api')
      setPhase('unavailable')
      return
    }
    void (async () => {
      try {
        const list = await invokeLoraScan((ch, p) => api.invoke(ch, p))
        if (!aliveRef.current) return
        setFiles(list)
        setPhase('ready')
      } catch {
        // models:loraScan 失败（主进程未就绪/通道被拒）→ 诚实降级，不阻塞生图
        if (aliveRef.current) {
          setUnavailableReason('scan-failed')
          setPhase('unavailable')
        }
      }
    })()
  }, [])

  const fetchMeta = useCallback((file: LoraFile): void => {
    const api = getApi()
    if (!api || meta[file.path] !== undefined) return
    void (async () => {
      let reply: LoraMetaReply
      try {
        reply = await invokeLoraMeta((ch, p) => api.invoke(ch, p), file.path)
      } catch {
        reply = { ok: false, error: 'bad-header' }
      }
      if (aliveRef.current) setMeta((m) => ({ ...m, [file.path]: reply }))
    })()
  }, [meta])

  const toggle = (file: LoraFile, checked: boolean): void => {
    if (checked) {
      fetchMeta(file)
      onChange([...value, { file, scale: LORA_SCALE_DEFAULT }])
    } else {
      onChange(value.filter((s) => s.file.path !== file.path))
    }
  }

  const setScale = (file: LoraFile, scale: number): void => {
    onChange(value.map((s) => (s.file.path === file.path ? { ...s, scale } : s)))
  }

  const selectedByPath = new Map(value.map((s) => [s.file.path, s]))

  return (
    <div className="las-lora" data-testid="lora-picker">
      <div className="las-lora-head">
        LoRA
        <span className="las-lora-count">{value.length > 0 ? `已选 ${value.length}` : ''}</span>
      </div>
      {phase === 'loading' ? <p className="las-lora-note">扫描 LoRA 目录…</p> : null}
      {phase === 'unavailable' ? (
        <p className="las-lora-note" data-testid="lora-unavailable">
          {unavailableReason === 'no-api'
            ? 'window.api 缺失 — LoRA 列表仅在 Electron 主窗口内可用；生图不受影响。'
            : 'models:loraScan 失败 — LoRA 列表暂不可用；生图不受影响。'}
        </p>
      ) : null}
      {phase === 'ready' && files.length === 0 ? (
        <p className="las-lora-note" data-testid="lora-empty">
          未发现 LoRA 文件 — 放入 models/diffusion/lora/ 下的 .safetensors/.gguf 即可。
        </p>
      ) : null}
      {files.length > 0 ? (
        <ul className="las-lora-list">
          {files.map((file) => {
            const sel = selectedByPath.get(file.path)
            const reply = sel ? meta[file.path] : undefined
            const summary = sel ? loraMetaSummary(reply?.ok ? reply.meta : undefined) : null
            return (
              <li className="las-lora-item" key={file.path} data-testid={`lora-item-${file.name}`}>
                <label className="las-lora-check">
                  <input
                    type="checkbox"
                    checked={sel !== undefined}
                    disabled={disabled}
                    onChange={(e) => toggle(file, e.target.checked)}
                  />
                  <span className="las-lora-name">{file.name}</span>
                  <span className="las-lora-size">{file.sizeLabel}</span>
                  <span className="las-lora-format">{file.format}</span>
                </label>
                {sel ? (
                  <div className="las-lora-scale">
                    <input
                      type="range"
                      min={LORA_SCALE_MIN}
                      max={LORA_SCALE_MAX}
                      step={LORA_SCALE_STEP}
                      value={sel.scale}
                      disabled={disabled}
                      aria-label={`LoRA 权重 ${file.name}`}
                      data-testid={`lora-scale-${file.name}`}
                      onChange={(e) => setScale(file, Number(e.target.value))}
                    />
                    <output className="las-lora-scale-value">{sel.scale.toFixed(2)}</output>
                    <span className="las-lora-meta" data-testid={`lora-meta-${file.name}`}>
                      {reply === undefined
                        ? '元数据读取中…'
                        : reply.ok
                          ? summary ?? '无可用元数据'
                          : reply.error === 'meta-unsupported'
                            ? '元数据未知（非 safetensors，仍可用）'
                            : '元数据未知（头解析失败，仍可用）'}
                    </span>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
      {value.length > 0 ? (
        <div className="las-lora-chips" data-testid="lora-chips">
          {value.map((s) => (
            <span className="las-lora-chip" key={s.file.path} data-testid={`lora-chip-${s.file.name}`}>
              <code>{loraTag(s)}</code>
              <button
                type="button"
                aria-label={`移除 ${s.file.name}`}
                disabled={disabled}
                onClick={() => onChange(value.filter((x) => x.file.path !== s.file.path))}
              >
                ×
              </button>
            </span>
          ))}
          <code className="las-lora-preview" data-testid="lora-preview">
            {loraTagPreview(value)}
          </code>
        </div>
      ) : null}
    </div>
  )
}

export default LoraPicker
