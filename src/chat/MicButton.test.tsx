// @vitest-environment jsdom
/**
 * MicButton.test.tsx — push-to-talk state machine (idle → recording →
 * transcribing → text) with the browser seam faked; no MediaRecorder,
 * no network, no whisper. Pins the QA pair from plan row 36: happy
 * 按住→松开→文本入框 and failure 麦克风拒绝 → 明确提示且不崩.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MicButton, type RecorderSurface } from './MicButton'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type StatusOk = {
  ok: true
  enabled: boolean
  modelPath: string
  modelReady: boolean
  engine: { bin: string | null; source: string }
  running: boolean
}

const READY: StatusOk = {
  ok: true,
  enabled: true,
  modelPath: 'M',
  modelReady: true,
  engine: { bin: 'b', source: 'bundled' },
  running: false,
}

function makeApi(status: unknown = READY) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'speech:getStatus') return status
    if (channel === 'speech:saveWav') return { ok: true, path: 'C:\\ud\\tmp\\speech-1.wav' }
    if (channel === 'speech:transcribe') return { ok: true, text: '你好世界' }
    throw new Error(`unexpected channel ${channel}`)
  })
  const api = { invoke, on: vi.fn(() => () => undefined) }
  ;(window as unknown as { api: unknown }).api = api
  return { invoke, api }
}

function makeRecorder(opts: { deny?: boolean } = {}): RecorderSurface & { rec: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } } {
  const handlers: { data?: (chunk: Blob) => void; stop?: () => void } = {}
  const rec = {
    start: vi.fn(),
    stop: vi.fn(() => {
      handlers.data?.(new Blob(['x'], { type: 'audio/webm' }))
      handlers.stop?.()
    }),
    onData: (cb: (chunk: Blob) => void) => {
      handlers.data = cb
    },
    onStop: (cb: () => void) => {
      handlers.stop = cb
    },
  }
  const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream
  const surface = {
    getUserMedia: opts.deny
      ? vi.fn(async () => {
          throw new DOMException('Permission denied', 'NotAllowedError')
        })
      : vi.fn(async () => stream),
    createRecorder: vi.fn(() => rec),
    toWavDataURL: vi.fn(async () => 'data:audio/wav;base64,Qg=='),
  }
  return { ...surface, rec }
}

let container: HTMLDivElement
let root: Root

async function mount(api: unknown, recorder: RecorderSurface, onTranscript = vi.fn(async () => undefined)): Promise<void> {
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<MicButton onTranscript={onTranscript} recorder={recorder} />)
    await Promise.resolve()
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function micBtn(): HTMLButtonElement {
  const b = container.querySelector<HTMLButtonElement>('[data-testid="mic-button"]')
  if (!b) throw new Error('mic button not rendered')
  return b
}

async function pressHold(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function release(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new Event('pointerup', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  unmount()
  delete (window as unknown as { api?: unknown }).api
})

describe('MicButton 渲染闸门', () => {
  it('无 window.api → 组件不存在（纯浏览器降级）', async () => {
    const rec = makeRecorder()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<MicButton onTranscript={vi.fn()} recorder={rec} />)
    })
    expect(container.querySelector('[data-testid="mic-button"]')).toBeNull()
  })

  it('getStatus 应答缺字段（chat characterization 假 api）→ 保持隐藏', async () => {
    const api = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) }
    ;(window as unknown as { api: unknown }).api = api
    const rec = makeRecorder()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<MicButton onTranscript={vi.fn()} recorder={rec} />)
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="mic-button"]')).toBeNull()
  })

  it('模型未就绪 → 渲染但禁用 + 指引 tooltip', async () => {
    const fake = makeApi({ ...READY, modelReady: false })
    const recorder = makeRecorder()
    await mount(fake, recorder)
    expect(micBtn().disabled).toBe(true)
    expect(micBtn().title).toContain('设置')
  })
})

describe('MicButton push-to-talk 主流程', () => {
  it('按住 → recording UI（计时+pulse 类）；松开 → saveWav+transcribe → 文本回调，麦克风轨关闭', async () => {
    const fake = makeApi()
    const recorder = makeRecorder()
    const onTranscript = vi.fn(async () => undefined)
    await mount(fake, recorder, onTranscript)

    await pressHold(micBtn())
    expect(recorder.rec.start).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="mic-timer"]')).toBeTruthy()
    expect(micBtn().className).toContain('las-mic-recording')

    await release(micBtn())
    expect(fake.invoke).toHaveBeenCalledWith('speech:saveWav', { dataURL: 'data:audio/wav;base64,Qg==' })
    expect(fake.invoke).toHaveBeenCalledWith('speech:transcribe', { wavPath: 'C:\\ud\\tmp\\speech-1.wav' })
    expect(onTranscript).toHaveBeenCalledWith('你好世界')
    expect(container.querySelector('[data-testid="mic-button-wrap"]')).toBeTruthy()
  })

  it('录音中 Esc 取消 → 不发送、回到 idle', async () => {
    const fake = makeApi()
    const recorder = makeRecorder()
    const onTranscript = vi.fn(async () => undefined)
    await mount(fake, recorder, onTranscript)
    await pressHold(micBtn())
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="mic-timer"]')).toBeNull()
    fake.invoke.mockClear()
    await act(async () => {
      await Promise.resolve()
    })
    expect(fake.invoke).not.toHaveBeenCalledWith('speech:saveWav', expect.anything())
    expect(onTranscript).not.toHaveBeenCalled()
  })

  it('pointerleave 等同松开（拖出按钮释放也转写）', async () => {
    const fake = makeApi()
    const recorder = makeRecorder()
    const onTranscript = vi.fn(async () => undefined)
    await mount(fake, recorder, onTranscript)
    await pressHold(micBtn())
    await act(async () => {
      // React synthesizes pointerleave from native pointerout (relatedTarget
      // null = left the window entirely).
      micBtn().dispatchEvent(new Event('pointerout', { bubbles: true }))
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
    })
    expect(onTranscript).toHaveBeenCalledWith('你好世界')
  })
})

describe('MicButton 失败路径 (QA-fail 场景)', () => {
  it('getUserMedia 拒绝 → role=alert 明确提示，不崩，按钮仍在', async () => {
    const fake = makeApi()
    const recorder = makeRecorder({ deny: true })
    await mount(fake, recorder)
    await pressHold(micBtn())
    const alert = container.querySelector<HTMLElement>('[data-testid="mic-error"]')
    expect(alert?.textContent).toContain('麦克风权限被拒绝')
    expect(container.querySelector('[data-testid="mic-button"]')).toBeTruthy()
  })

  it('transcribe 报 model-not-configured → 提示去设置而非静默', async () => {
    const rec = makeRecorder()
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'speech:getStatus') return READY
      if (channel === 'speech:saveWav') return { ok: true, path: 'p' }
      return { ok: false, error: 'model-not-configured' }
    })
    ;(window as unknown as { api: unknown }).api = { invoke, on: vi.fn(() => () => undefined) }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<MicButton onTranscript={vi.fn()} recorder={rec} />)
      await Promise.resolve()
    })
    await pressHold(micBtn())
    await release(micBtn())
    const alert = container.querySelector<HTMLElement>('[data-testid="mic-error"]')
    expect(alert?.textContent).toContain('设置')
  })
})
