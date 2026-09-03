// @vitest-environment jsdom
/**
 * SpeechSection.test.tsx — todo36 设置页语音区（EngineStatus.test 的假 api 约定）：
 * getStatus 渲染三行；开关 → speech:setPrefs {enabled}；选择模型 →
 * pickModel→setPrefs {modelPath}；取消不改；无 api 整区隐藏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SpeechSection } from './SpeechSection'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const OK = {
  ok: true as const,
  enabled: true,
  modelPath: '',
  modelReady: false,
  engine: { bin: 'D:\\app\\engines\\whisper\\whisper-server.exe', source: 'bundled' as const },
  running: false,
}

function makeApi(overrides: Partial<Record<string, unknown>> = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'speech:getStatus') return overrides['speech:getStatus'] ?? OK
    if (channel === 'speech:setPrefs') return { ...OK, ...((payload ?? {}) as object) }
    if (channel === 'speech:pickModel') return overrides['speech:pickModel'] ?? { ok: true, path: 'D:\\models\\whisper\\ggml-base.bin' }
    throw new Error(`unexpected channel ${channel}`)
  })
  ;(window as unknown as { api: unknown }).api = { invoke, on: vi.fn(() => () => undefined) }
  return { invoke }
}

let container: HTMLDivElement
let root: Root

async function mount(api: { invoke: ReturnType<typeof vi.fn> }): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<SpeechSection />)
    await new Promise((r) => setTimeout(r, 0))
  })
  void api
}

function flush(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('SpeechSection', () => {
  it('getStatus 成功 → 开关/模型路径/引擎来源三行 + 未就绪标记', async () => {
    const api = makeApi()
    await mount(api)
    expect(api.invoke).toHaveBeenCalledWith('speech:getStatus', {})
    expect(container.textContent).toContain('语音输入')
    expect(container.querySelector('[data-testid="speech-model-path"]')?.textContent).toBe('未配置')
    expect(container.querySelector('[data-testid="speech-engine-source"]')?.textContent).toContain('内置引擎')
    expect(container.querySelector('[data-testid="speech-ready"]')?.textContent).toContain('缺模型')
  })

  it('关 → 开切换发 speech:setPrefs {enabled:true} 并按应答刷新', async () => {
    const api = makeApi()
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speech-enabled-true"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('speech:setPrefs', { enabled: true })
  })

  it('选择模型 → pickModel 路径经 setPrefs 持久化并回填', async () => {
    const api = makeApi()
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speech-pick-model"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('speech:pickModel', {})
    expect(api.invoke).toHaveBeenCalledWith('speech:setPrefs', { modelPath: 'D:\\models\\whisper\\ggml-base.bin' })
    expect(container.querySelector('[data-testid="speech-model-path"]')?.textContent).toBe('D:\\models\\whisper\\ggml-base.bin')
  })

  it('dialog 取消 (path null) 不发 setPrefs', async () => {
    const api = makeApi({ 'speech:pickModel': { ok: true, path: null } })
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="speech-pick-model"]')!.click()
      await flush()
    })
    const setCalls = api.invoke.mock.calls.filter((c) => c[0] === 'speech:setPrefs')
    expect(setCalls).toHaveLength(0)
  })

  it('无 window.api（纯浏览器预览）→ 整区不渲染', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<SpeechSection />)
      await flush()
    })
    expect(container.querySelector('[aria-label="语音输入"]')).toBeNull()
  })

  it('getStatus 抛错 → 降级提示且不抛', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('boom')
    })
    ;(window as unknown as { api: unknown }).api = { invoke, on: vi.fn(() => () => undefined) }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      const tree: ReactNode = <SpeechSection />
      root.render(tree)
      await flush()
    })
    expect(container.textContent).toContain('speech:getStatus 失败')
  })
})
