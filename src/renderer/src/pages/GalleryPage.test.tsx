// @vitest-environment jsdom
/**
 * GalleryPage.test.tsx — todo37 画廊条目列表 + 每卡 OCR：
 * gallery:list 渲染条目（prompt/时间）；ocr:status pack → 识别按钮可用 →
 * ocr:recognize {galleryId} 往返；引擎缺失 → 按钮禁用 + 去设置提示；
 * 条目不存在 → 提取失败行；无 window.api → 诚实只读文案。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import GalleryPage from './GalleryPage'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const ITEMS = {
  items: [
    { id: 'aaa-1', prompt: '一只猫', createdAt: 1700000000000 },
    { id: 'bbb-2', prompt: '一只狗', createdAt: 1700000000001 },
  ],
}

function makeApi(opts: { engineReady?: boolean } = {}) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => {
    if (channel === 'gallery:list') return ITEMS
    if (channel === 'ocr:status') {
      return {
        ok: true,
        supported: true,
        running: false,
        engine: { bin: 'D:\\x\\PaddleOCR-json.exe', source: opts.engineReady === false ? 'none' : 'pack', version: 'v1.4.1' },
      }
    }
    if (channel === 'ocr:recognize') {
      const id = (payload as { galleryId?: string }).galleryId
      if (id === 'aaa-1') return { ok: true, text: '猫的图片说明' }
      return { ok: false, error: 'gallery-item-not-found' }
    }
    throw new Error(`unexpected channel ${channel}`)
  })
  ;(window as unknown as { api: unknown }).api = { invoke, on: vi.fn(() => () => undefined) }
  return { invoke }
}

let container: HTMLDivElement
let root: Root

async function mount(api: ReturnType<typeof makeApi>): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<GalleryPage />)
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

describe('GalleryPage — todo37', () => {
  it('gallery:list 条目渲染（prompt + id 卡）', async () => {
    const api = makeApi()
    await mount(api)
    expect(api.invoke).toHaveBeenCalledWith('gallery:list')
    expect(container.textContent).toContain('一只猫')
    expect(container.querySelector('[data-testid="gallery-grid"]')).not.toBeNull()
    expect(container.querySelectorAll('article.las-gallery-item')).toHaveLength(2)
  })

  it('引擎就绪：识别 → ocr:recognize {galleryId} → 文本结果', async () => {
    const api = makeApi()
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="gallery-ocr-aaa-1"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('ocr:recognize', { galleryId: 'aaa-1' })
    expect(container.querySelector('[data-testid="gallery-ocr-result-aaa-1"]')?.textContent).toContain('猫的图片说明')
  })

  it('条目失败应答 → 提取失败行（code 明示）', async () => {
    const api = makeApi()
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="gallery-ocr-bbb-2"]')!.click()
      await flush()
    })
    expect(container.textContent).toContain('提取失败')
    expect(container.textContent).toContain('gallery-item-not-found')
  })

  it('引擎缺失 → 识别按钮禁用且 title 指路设置（QA-fail 场景）', async () => {
    const api = makeApi({ engineReady: false })
    await mount(api)
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="gallery-ocr-aaa-1"]')
    expect(btn?.disabled).toBe(true)
    expect(btn?.title).toContain('设置')
    // 点击不发起 recognize
    await act(async () => {
      btn!.click()
      await flush()
    })
    expect(api.invoke).not.toHaveBeenCalledWith('ocr:recognize', expect.anything())
  })

  it('无 window.api → 只读降级文案，不崩', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<GalleryPage />)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.textContent).toContain('window.api')
  })
})
