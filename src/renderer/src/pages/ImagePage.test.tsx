// @vitest-environment jsdom
/**
 * ImagePage.test.tsx — todo20 生图工作台组件测试。
 * 约定同 SettingsPage.test：per-file jsdom + createRoot + fake window.api。
 * 覆盖计划验收：模式切换显隐、拖放导入→image:saveTempImage、inpaint 无蒙版
 * QA-fail 提示、strength 透传、done→gallery:save、非 Electron 诚实降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ImagePage } from './ImagePage'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'
const TINY_PNG_DATAURL = `data:image/png;base64,${TINY_PNG_B64}`

type Listener = (payload: unknown) => void

function makeFakeApi(opts: { generateReply?: unknown; tempFail?: boolean } = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown): Promise<unknown> => {
    if (channel === 'image:saveTempImage') {
      if (opts.tempFail) return { ok: false, error: 'dataurl-too-large' }
      const p = payload as { dataURL?: string }
      if (typeof p?.dataURL !== 'string' || !p.dataURL.startsWith('data:image/png;base64,')) {
        return { ok: false, error: 'invalid-payload', issues: [{ path: 'dataURL', message: 'bad' }] }
      }
      return { ok: true, path: 'C:\\userData\\tmp\\img-123.png' }
    }
    if (channel === 'image:generate') {
      return (opts.generateReply ?? { ok: true, statusCode: 202, jobId: 'job-1' }) as Record<string, unknown>
    }
    if (channel === 'image:queue:status') {
      return { ok: true, job: { status: 'done', result: { b64: TINY_PNG_B64 } } }
    }
    if (channel === 'gallery:save') return { ok: true, item: { id: 'g1' } }
    if (channel === 'gallery:list') return { items: [] }
    throw new Error(`unexpected channel: ${channel}`)
  })
  const listeners = new Map<string, Set<Listener>>()
  const on = vi.fn((channel: string, listener: Listener) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    return () => listeners.get(channel)?.delete(listener)
  })
  const emit = (channel: string, payload: unknown): void => {
    for (const l of listeners.get(channel) ?? []) l(payload)
  }
  return { api: { invoke, on }, invoke, emit }
}

let container: HTMLDivElement
let root: Root

function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

async function mount(fake?: ReturnType<typeof makeFakeApi>): Promise<void> {
  setFakeApi(fake?.api)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<ImagePage />)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function q(sel: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(sel)
}

function byTestId(id: string): HTMLElement {
  const el = q(`[data-testid="${id}"]`)
  if (!el) throw new Error(`testid ${id} not found`)
  return el
}

async function clickMode(modeLabel: string): Promise<void> {
  const btn = [...container.querySelectorAll<HTMLButtonElement>('.las-img-mode-btn')].find((b) => b.textContent === modeLabel)
  if (!btn) throw new Error(`mode button ${modeLabel} not found`)
  await act(async () => {
    btn.click()
  })
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** jsdom 无 canvas 后端：stub 2d ctx + toDataURL（蒙版导出非空 PNG 的验收面） */
function stubCanvas(): void {
  const ctx: Partial<CanvasRenderingContext2D> = {
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(TINY_PNG_DATAURL)
}

async function strokeMask(): Promise<void> {
  const canvas = byTestId('mask-canvas').querySelector('canvas') as HTMLCanvasElement
  await act(async () => {
    canvas.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    canvas.dispatchEvent(new Event('pointermove', { bubbles: true }))
    canvas.dispatchEvent(new Event('pointerup', { bubbles: true }))
  })
}

async function dropInitImage(): Promise<void> {
  const input = byTestId('img-drop-input') as HTMLInputElement
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'init.png', { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  // jsdom FileReader 的 onload 是宏任务：多轮 flush 保证 state 落地
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  setFakeApi(undefined)
})

afterEach(() => {
  unmount()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

describe('ImagePage — 模式与降级', () => {
  it('txt2img 默认态：无底图区/无强度滑杆；切图生图两者出现；切回消失', async () => {
    await mount(makeFakeApi())
    expect(q('.las-img-drop')).toBeNull()
    expect(q('.las-img-strength')).toBeNull()
    await clickMode('图生图')
    expect(q('.las-img-drop')).not.toBeNull()
    expect(q('.las-img-strength')).not.toBeNull()
    await clickMode('inpaint')
    expect(byTestId('mask-canvas')).not.toBeNull()
    await clickMode('文生图')
    expect(q('.las-img-drop')).toBeNull()
  })

  it('window.api 缺失 → 生成点击给出诚实降级错误，不崩', async () => {
    await mount(undefined)
    setInputValue(container.querySelector('textarea')!, 'a cat')
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(byTestId('img-error').textContent).toContain('window.api')
  })
})

describe('ImagePage — img2img/inpaint 参数通路', () => {
  it('拖入图片 → image:saveTempImage 收到 PNG dataURL 并落预览', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    await clickMode('图生图')
    await dropInitImage()
    expect(fake.invoke).toHaveBeenCalledWith('image:saveTempImage', expect.objectContaining({ dataURL: expect.stringMatching(/^data:image\/png;base64,/) }))
    expect(q('.las-img-drop-preview')).not.toBeNull()
  })

  it('inpaint 未涂抹蒙版 → 明示 mask-required 且不发 image:generate（QA-fail）', async () => {
    stubCanvas()
    const fake = makeFakeApi()
    await mount(fake)
    await clickMode('inpaint')
    await dropInitImage()
    setInputValue(container.querySelector('textarea')!, 'a cat')
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(byTestId('img-error').textContent).toContain('蒙版')
    expect(fake.invoke).not.toHaveBeenCalledWith('image:generate', expect.anything())
  })

  it('涂抹蒙版后提交 → image:generate 携带 mode/inImagePath/strength/maskPath', async () => {
    stubCanvas()
    const fake = makeFakeApi()
    await mount(fake)
    await clickMode('inpaint')
    await dropInitImage()
    await strokeMask()
    setInputValue(container.querySelector('textarea')!, 'a cat')
    const strengthInput = q('.las-img-strength input[type="range"]') as HTMLInputElement
    await act(async () => {
      setInputValue(strengthInput, '0.4')
    })
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(fake.invoke).toHaveBeenCalledWith('image:saveTempImage', expect.objectContaining({ dataURL: TINY_PNG_DATAURL }))
    expect(fake.invoke).toHaveBeenCalledWith('image:generate', expect.objectContaining({
      mode: 'inpaint',
      initImagePath: 'C:\\userData\\tmp\\img-123.png',
      maskPath: 'C:\\userData\\tmp\\img-123.png',
      strength: 0.4,
    }))
  })

  it('图生图未导入底图 → 前端拒绝并提示 init-image-missing', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    await clickMode('图生图')
    setInputValue(container.querySelector('textarea')!, 'a cat')
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(byTestId('img-error').textContent).toContain('底图')
    expect(fake.invoke).not.toHaveBeenCalledWith('image:generate', expect.anything())
  })

  it('服务端 400-shape（inpaint 缺蒙版穿透前端时）→ 拒绝信息上屏', async () => {
    stubCanvas()
    const fake = makeFakeApi({
      generateReply: { ok: false, error: 'invalid-payload', issues: [{ path: 'maskPath', message: 'mask-required' }] },
    })
    await mount(fake)
    await clickMode('inpaint')
    await dropInitImage()
    await strokeMask()
    setInputValue(container.querySelector('textarea')!, 'a cat')
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(byTestId('img-error').textContent).toContain('mask-required')
  })
})

describe('ImagePage — 队列事件与画廊落盘', () => {
  it('done 事件 → 拉取 job 结果并以生成参数调用 gallery:save', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    setInputValue(container.querySelector('textarea')!, 'a lovely cat')
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      fake.emit('image:queue:status', { type: 'progress', jobId: 'job-1', progress: 50, status: 'running' })
    })
    expect((byTestId('img-progress') as HTMLProgressElement).value).toBe(50)
    await act(async () => {
      fake.emit('image:queue:status', { type: 'done', jobId: 'job-1', progress: 100, status: 'done' })
    })
    expect(fake.invoke).toHaveBeenCalledWith('image:queue:status', { jobId: 'job-1' })
    expect(fake.invoke).toHaveBeenCalledWith('gallery:save', expect.objectContaining({ prompt: 'a lovely cat', b64: TINY_PNG_B64 }))
    expect(byTestId('img-message').textContent).toContain('画廊')
  })

  it('failed 事件 → 队列错误上屏并解锁提交', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    setInputValue(container.querySelector('textarea')!, 'boom')
    await act(async () => {
      q('.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      fake.emit('image:queue:status', { type: 'failed', jobId: 'job-1', progress: 3, status: 'failed', message: 'sd-cli down' })
    })
    expect(byTestId('img-error').textContent).toContain('sd-cli down')
    expect((q('.las-img-form button[type="submit"]') as HTMLButtonElement).disabled).toBe(false)
  })
})
