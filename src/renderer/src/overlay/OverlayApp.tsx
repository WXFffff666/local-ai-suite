/**
 * OverlayApp.tsx — todo38 截图问屏的全屏透明选区遮罩（main.tsx 以 #/overlay
 * 分支挂载，主壳 App 不渲染）。流程（plan FLOW）：
 *  热键 → 主进程 desktopCapturer 单次抓屏 → 本窗挂载后 PULL 'overlay:frame:get'
 *  （拉取式，杜绝 push 与监听器挂载的竞态）→ pointer 事件橡皮筋选区
 *  （<MIN_SELECT_CSS_PX 视同误点 → cancel）→ 底栏三 chip（解释这张图/提取文字/
 *  翻译，默认 chip1；Enter=确认默认，点击 chip=确认该项；Esc 任意阶段取消）
 *  → canvas 裁剪（crop.ts，与主进程共用 scaleMath）→ invoke 'overlay:select'
 *  → 主进程关闭本窗并向主窗口发 'ask:seed' 走 todo21 VLM 通路。
 * 帧数据只在内存（ipc.select 后即随主进程遮罩一起丢弃），永不落盘。
 * MIT only, no AGPL.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OverlayDisplayInfo, OverlayFrameReply } from '../../../main/ipc/whitelist'
import { isMeaningfulSelection, normalizeDragRect, type CssRect, type ScreenPoint } from '../../../main/overlay/scaleMath'
import { cropFrameToPng } from './crop'

/** 三枚快捷 chip（plan 原文）。'提取文字' 按 plan 仅作为 VLM prompt 文本。 */
export const OVERLAY_CHIPS = ['解释这张图', '提取文字', '翻译'] as const
export const DEFAULT_CHIP_INDEX = 0

type OverlayInvokeApi = {
  invoke(channel: 'overlay:frame:get', payload: Record<string, never>): Promise<unknown>
  invoke(channel: 'overlay:cancel', payload: Record<string, never>): Promise<unknown>
  invoke(
    channel: 'overlay:select',
    payload: { rect: CssRect; dataURL: string; prompt: string },
  ): Promise<unknown>
}

export type OverlayCropFn = (dataURL: string, rect: CssRect, display: OverlayDisplayInfo) => Promise<string>

type Phase = 'pending' | 'selecting' | 'confirm' | 'busy' | 'closed'

type OverlayProps = {
  /** injectable for tests; defaults to the preload bridge + canvas crop */
  api?: OverlayInvokeApi | null
  crop?: OverlayCropFn
}

function resolveApi(prop: OverlayProps['api']): OverlayInvokeApi | null {
  if (prop !== undefined) return prop
  if (typeof window === 'undefined' || typeof window.api?.invoke !== 'function') return null
  return window.api as unknown as OverlayInvokeApi
}

export function OverlayApp({ api, crop = cropFrameToPng }: OverlayProps): React.JSX.Element | null {
  const invoke = useRef<OverlayInvokeApi | null>(resolveApi(api))
  const [frame, setFrame] = useState<{ dataURL: string; display: OverlayDisplayInfo } | null>(null)
  const [phase, setPhase] = useState<Phase>('pending')
  const [chip, setChip] = useState<number>(DEFAULT_CHIP_INDEX)
  const [selection, setSelection] = useState<CssRect | null>(null)
  const dragStart = useRef<ScreenPoint | null>(null)

  const cancel = useCallback((): void => {
    setPhase('closed')
    void invoke.current?.invoke('overlay:cancel', {}).catch(() => undefined)
  }, [])

  // mount → pull the pre-captured frame (no-frame = stale overlay → self-close)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const apiNow = invoke.current
      if (apiNow === null) {
        setPhase('closed')
        return
      }
      try {
        const reply = (await apiNow.invoke('overlay:frame:get', {})) as OverlayFrameReply
        if (cancelled) return
        if (reply?.ok === true) {
          setFrame({ dataURL: reply.dataURL, display: reply.display })
          setPhase('selecting')
        } else {
          cancel()
        }
      } catch {
        if (!cancelled) cancel()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cancel])

  const confirmSelection = useCallback(
    async (rect: CssRect, prompt: string): Promise<void> => {
      if (frame === null) return
      setPhase('busy')
      try {
        const dataURL = await crop(frame.dataURL, rect, frame.display)
        await invoke.current?.invoke('overlay:select', { rect, dataURL, prompt })
        // main closes this window on success; keep the frame dark meanwhile
        setPhase('closed')
      } catch {
        cancel()
      }
    },
    [frame, crop, cancel],
  )

  // keyboard: Esc anywhere cancels; Enter confirms the default chip (plan)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
        return
      }
      if (e.key === 'Enter' && phase === 'confirm' && selection !== null) {
        e.preventDefault()
        void confirmSelection(selection, OVERLAY_CHIPS[chip] ?? OVERLAY_CHIPS[DEFAULT_CHIP_INDEX])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, selection, chip, cancel, confirmSelection])

  const size = frame ? { width: frame.display.width, height: frame.display.height } : { width: 0, height: 0 }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (phase !== 'selecting') return
    dragStart.current = { x: e.clientX, y: e.clientY }
    setSelection({ x: e.clientX, y: e.clientY, width: 0, height: 0 })
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (phase !== 'selecting' || dragStart.current === null) return
    setSelection(normalizeDragRect(dragStart.current, { x: e.clientX, y: e.clientY }, size))
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    if (phase !== 'selecting' || dragStart.current === null) return
    const rect = normalizeDragRect(dragStart.current, { x: e.clientX, y: e.clientY }, size)
    dragStart.current = null
    if (!isMeaningfulSelection(rect)) {
      // 误点/过小选区 → 等同 Esc 取消（plan: min 10px else Esc-cancel）
      setSelection(null)
      cancel()
      return
    }
    setSelection(rect)
    setChip(DEFAULT_CHIP_INDEX)
    setPhase('confirm')
  }

  if (phase === 'closed' || invoke.current === null) return null

  return (
    <div
      data-testid="las-overlay-root"
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        cursor: 'crosshair',
        userSelect: 'none',
        background: '#000',
        fontFamily: 'system-ui,sans-serif',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {frame !== null && (
        <img
          data-testid="las-overlay-frame"
          src={frame.dataURL}
          alt=""
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', userSelect: 'none' }}
        />
      )}
      {frame === null && phase === 'pending' && (
        <div data-testid="las-overlay-pending" style={{ position: 'absolute', top: 12, left: 12, color: '#eee', fontSize: 12 }}>
          正在截取屏幕…
        </div>
      )}
      {selection !== null && selection.width > 0 && (
        <div
          data-testid="las-overlay-selection"
          style={{
            position: 'absolute',
            left: selection.x,
            top: selection.y,
            width: selection.width,
            height: selection.height,
            border: '1px solid #4da3ff',
            background: 'rgba(77,163,255,0.12)',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
          }}
        />
      )}
      {phase === 'confirm' && (
        <div
          data-testid="las-overlay-chips"
          role="toolbar"
          aria-label="提问方式"
          style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: 8 }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
        >
          {OVERLAY_CHIPS.map((label, i) => (
            <button
              key={label}
              type="button"
              data-chip-index={i}
              onClick={() => void confirmSelection(selection as CssRect, label)}
              onMouseEnter={() => setChip(i)}
              style={{
                padding: '6px 14px',
                cursor: 'pointer',
                borderRadius: 16,
                border: i === chip ? '1px solid #4da3ff' : '1px solid #555',
                background: i === chip ? '#1d3a57' : '#171717',
                color: '#e6e6e6',
              }}
            >
              {label}
            </button>
          ))}
          <span style={{ alignSelf: 'center', color: '#999', fontSize: 12 }}>Enter 确认 · Esc 取消</span>
        </div>
      )}
      {phase === 'busy' && (
        <div role="status" style={{ position: 'absolute', top: 12, left: 12, color: '#eee', fontSize: 12 }}>
          正在提问…
        </div>
      )}
    </div>
  )
}

export default OverlayApp
