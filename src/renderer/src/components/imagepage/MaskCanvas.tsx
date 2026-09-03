import { forwardRef, useCallback, useImperativeHandle, useRef, type PointerEvent } from 'react'

export const MASK_CANVAS_SIZE = 512
const BRUSH_COLOR = '#ffffff' // sd.cpp/A1111 约定：白色 = 重绘区
const BRUSH_WIDTH = 28

export type MaskCanvasHandle = {
  /** 无笔迹返回 null（供页面在 inpaint 校验时区分"未涂抹"） */
  exportPNG: () => string | null
  clear: () => void
}

export type MaskCanvasProps = {
  /** 底图预览（img2img 已导入时铺在蒙版画布下） */
  backgroundURL: string | null
  onStrokesChange: (hasStrokes: boolean) => void
  disabled?: boolean
}

/**
 * todo20 — inpaint 蒙版画笔。透明画布叠加底图 <img>，pointer 画白色笔迹；
 * 导出 toDataURL('image/png') 经 image:saveTempImage 落盘为 maskPath。
 */
export const MaskCanvas = forwardRef<MaskCanvasHandle, MaskCanvasProps>(function MaskCanvas(
  { backgroundURL, onStrokesChange, disabled },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawingRef = useRef(false)
  const hasStrokesRef = useRef(false)

  const ctx2d = useCallback((): CanvasRenderingContext2D | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    return canvas.getContext('2d')
  }, [])

  const toCanvasPoint = (e: PointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    const sx = MASK_CANVAS_SIZE / rect.width
    const sy = MASK_CANVAS_SIZE / rect.height
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  const beginStroke = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (disabled) return
    const ctx = ctx2d()
    const p = toCanvasPoint(e)
    if (!ctx) return
    drawingRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    ctx.strokeStyle = BRUSH_COLOR
    ctx.lineWidth = BRUSH_WIDTH
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
    // 单击一个点也要留迹（点在 toCanvasPoint 后 lineTo+stroke）
    ctx.lineTo(p.x + 0.01, p.y)
    ctx.stroke()
    if (!hasStrokesRef.current) {
      hasStrokesRef.current = true
      onStrokesChange(true)
    }
  }

  const extendStroke = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current || disabled) return
    const ctx = ctx2d()
    if (!ctx) return
    const p = toCanvasPoint(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }

  const endStroke = (): void => {
    drawingRef.current = false
  }

  useImperativeHandle(
    ref,
    (): MaskCanvasHandle => ({
      exportPNG: () => {
        if (!hasStrokesRef.current) return null
        return canvasRef.current?.toDataURL('image/png') ?? null
      },
      clear: () => {
        const ctx = ctx2d()
        if (ctx) ctx.clearRect(0, 0, MASK_CANVAS_SIZE, MASK_CANVAS_SIZE)
        hasStrokesRef.current = false
        onStrokesChange(false)
      },
    }),
    [ctx2d, onStrokesChange],
  )

  return (
    <div className="las-img-mask" data-testid="mask-canvas">
      <div className="las-img-mask-stage">
        {backgroundURL ? <img className="las-img-mask-bg" src={backgroundURL} alt="底图" /> : null}
        <canvas
          ref={canvasRef}
          width={MASK_CANVAS_SIZE}
          height={MASK_CANVAS_SIZE}
          className="las-img-mask-canvas"
          aria-label="inpaint 蒙版画笔：在底图上涂抹白色区域"
          onPointerDown={beginStroke}
          onPointerMove={extendStroke}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
        />
      </div>
      <button
        type="button"
        className="las-img-mask-clear"
        disabled={disabled}
        onClick={() => {
          // 走 imperative clear，保证笔迹状态与父组件同步
          canvasRef.current && ctx2d()?.clearRect(0, 0, MASK_CANVAS_SIZE, MASK_CANVAS_SIZE)
          hasStrokesRef.current = false
          onStrokesChange(false)
        }}
      >
        清空蒙版
      </button>
    </div>
  )
})

export default MaskCanvas
