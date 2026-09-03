// @vitest-environment jsdom
/**
 * OcrSection.test.tsx — todo37 设置页「本地 OCR」区（SpeechSection.test 同款
 * 假 api 约定）：getStatus 渲染引擎来源/就绪行；未安装 → 下载按钮 →
 * ocr:install ack + 'ocr:progress' 事件推进（downloading→…→done→刷新状态）；
 * 已安装 → 按钮禁用文案「已安装」；quarantined 显示隔离备注；无 api 整区隐藏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OcrSection } from './OcrSection'
import type { OcrProgressEvent } from '../../../../main/ipc/whitelist'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const PACK_STATUS = {
  ok: true as const,
  supported: true,
  engine: { bin: 'D:\\u\\engines\\ocr-cpu\\PaddleOCR-json.exe', source: 'pack' as const, version: 'v1.4.1' },
  running: false,
}
const NONE_STATUS = {
  ok: true as const,
  supported: true,
  engine: { bin: null, source: 'none' as const, version: null },
  running: false,
}

function makeApi(opts: { status?: unknown; installReply?: unknown } = {}) {
  const listeners: Array<(ev: OcrProgressEvent) => void> = []
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'ocr:status') return opts.status ?? NONE_STATUS
    if (channel === 'ocr:install') return opts.installReply ?? { ok: true }
    throw new Error(`unexpected channel ${channel}`)
  })
  const on = vi.fn((_ch: string, cb: (ev: OcrProgressEvent) => void) => {
    listeners.push(cb)
    return () => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    }
  })
  ;(window as unknown as { api: unknown }).api = { invoke, on }
  return { invoke, emit: (ev: OcrProgressEvent) => listeners.slice().forEach((l) => l(ev)) }
}

let container: HTMLDivElement
let root: Root

async function mount(api: ReturnType<typeof makeApi> | null): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<OcrSection />)
    await new Promise((r) => setTimeout(r, 0))
  })
  void api
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  delete (window as unknown as { api?: unknown }).api
})

describe('OcrSection', () => {
  it('getStatus(none) → 未安装 + 下载按钮可用 + 来源行', async () => {
    const api = makeApi()
    await mount(api)
    expect(api.invoke).toHaveBeenCalledWith('ocr:status', {})
    expect(container.querySelector('[data-testid="ocr-engine-source"]')?.textContent).toContain('未安装')
    expect(container.querySelector('[data-testid="ocr-ready"]')?.textContent).toContain('未安装')
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="ocr-install"]')
    expect(btn?.disabled).toBe(false)
    expect(btn?.textContent).toContain('下载引擎')
  })

  it('getStatus(pack) → 已安装禁用 + 版本与来源文案', async () => {
    const api = makeApi({ status: PACK_STATUS })
    await mount(api)
    expect(container.querySelector('[data-testid="ocr-engine-source"]')?.textContent).toContain('sha256 钉校验')
    expect(container.querySelector('[data-testid="ocr-engine-source"]')?.textContent).toContain('v1.4.1')
    expect(container.querySelector('[data-testid="ocr-ready"]')?.textContent).toContain('就绪')
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="ocr-install"]')
    expect(btn?.disabled).toBe(true)
    expect(btn?.textContent).toContain('已安装')
  })

  it('下载点击 → ocr:install ack + 进度事件推进条 + done 后刷新状态', async () => {
    const api = makeApi()
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ocr-install"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('ocr:install', {})
    await act(async () => {
      api.emit({ state: 'downloading', received: 50, total: 100 })
      await flush()
    })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="ocr-install"]')?.textContent).toContain('50%')
    expect(container.querySelector('[data-testid="ocr-progress"]')).not.toBeNull()
    await act(async () => {
      api.emit({ state: 'done', received: 100, total: 100 })
      await flush()
    })
    // done → 重新拉状态（fake 仍是 none，但调用次数 +1 证明刷新发生）
    expect(api.invoke.mock.calls.filter((c) => c[0] === 'ocr:status').length).toBeGreaterThanOrEqual(2)
  })

  it('quarantined 事件 → 显示隔离备注', async () => {
    const api = makeApi()
    await mount(api)
    await act(async () => {
      api.emit({ state: 'quarantined', received: 0, total: 0, note: '引擎包损坏，已隔离' })
      await flush()
    })
    expect(container.querySelector('[data-testid="ocr-install-note"]')?.textContent).toContain('已隔离')
  })

  it('install 被拒(already-downloading) → 行内提示', async () => {
    const api = makeApi({ installReply: { ok: false, error: 'already-downloading' } })
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ocr-install"]')!.click()
      await flush()
    })
    expect(container.querySelector('[data-testid="ocr-install-note"]')?.textContent).toContain('already-downloading')
  })

  it('不支持平台 → 就绪行明示 + 下载禁用', async () => {
    const api = makeApi({ status: { ...NONE_STATUS, supported: false } })
    await mount(api)
    expect(container.querySelector('[data-testid="ocr-ready"]')?.textContent).toContain('不支持')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="ocr-install"]')?.disabled).toBe(true)
  })

  it('无 window.api（纯浏览器预览）→ 整区不渲染', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<OcrSection />)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.textContent).toBe('')
  })
})
