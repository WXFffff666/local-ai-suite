// @vitest-environment jsdom
/**
 * OverlayApp.test.tsx — todo38 遮罩交互状态机（jsdom，约定同 App/ChatPage.test：
 * 手工 createRoot + act + 假 window.api，crop 走注入 seam —— jsdom 无 canvas
 * 光栅，真实裁剪由 e2e（fake capturer）与 scaleMath 单测两端锁死）。
 * 覆盖：frame 拉取成功/失败、橡皮筋成框、<10px 误点=cancel、Esc=cancel、
 * Enter 确认默认 chip、点击 chip 以该 prompt 提交、裁剪失败诚实 cancel。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { OverlayApp, OVERLAY_CHIPS, DEFAULT_CHIP_INDEX, type OverlayCropFn } from './OverlayApp'
import type { OverlayDisplayInfo } from '../../../main/ipc/whitelist'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const DISPLAY: OverlayDisplayInfo = { width: 1920, height: 1080, scale: 1.25, physicalWidth: 2400, physicalHeight: 1350 }
const FRAME_PNG = 'data:image/png;base64,RkFNRQ=='
const CROP_PNG = 'data:image/png;base64,Q1JPVA=='

type SelectPayload = { rect: { x: number; y: number; width: number; height: number }; dataURL: string; prompt: string }

function makeFakeApi(frameReply: unknown) {
  const selects: SelectPayload[] = []
  let cancels = 0
  const invoke = vi.fn(async (channel: string, payload: unknown): Promise<unknown> => {
    if (channel === 'overlay:frame:get') return frameReply
    if (channel === 'overlay:select') {
      selects.push(payload as SelectPayload)
      return { ok: true }
    }
    if (channel === 'overlay:cancel') {
      cancels += 1
      return { ok: true }
    }
    throw new Error(`unexpected channel ${channel}`)
  })
  return {
    api: { invoke } as unknown as Parameters<typeof OverlayApp>[0]['api'],
    invoke,
    selects,
    getCancels: () => cancels,
  }
}

const cropOk: OverlayCropFn = vi.fn(async () => CROP_PNG)

let container: HTMLDivElement
let root: Root

async function mount(api: unknown, crop: OverlayCropFn = cropOk): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = <OverlayApp api={api as never} crop={crop} />
  await act(async () => {
    root.render(tree)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): void {
  const target = container.querySelector('[data-testid="las-overlay-root"]') ?? container
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  })
}

function key(k: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  unmount()
})

describe('OverlayApp frame pull', () => {
  it('ok reply → frame <img> renders with the captured dataURL, no chips yet', async () => {
    const { api } = makeFakeApi({ ok: true, dataURL: FRAME_PNG, display: DISPLAY })
    await mount(api)
    const img = container.querySelector('[data-testid="las-overlay-frame"]') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe(FRAME_PNG)
    expect(container.querySelector('[data-testid="las-overlay-chips"]')).toBeNull()
  })

  it('no-frame reply → self-cancel (invoke overlay:cancel, render nothing)', async () => {
    const { api, getCancels } = makeFakeApi({ ok: false, error: 'no-frame' })
    await mount(api)
    expect(getCancels()).toBe(1)
    expect(container.querySelector('[data-testid="las-overlay-root"]')).toBeNull()
  })

  it('invoke rejection (stale overlay/IPC error) → honest cancel', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('ipc down')
    })
    await mount({ invoke } as unknown as Parameters<typeof OverlayApp>[0]['api'])
    expect(container.querySelector('[data-testid="las-overlay-root"]')).toBeNull()
  })
})

describe('OverlayApp rubber-band', () => {
  const frameReply = { ok: true, dataURL: FRAME_PNG, display: DISPLAY }

  it('drag ≥10px reveals the three prompt chips, default chip highlighted', async () => {
    const { api } = makeFakeApi(frameReply)
    await mount(api)
    pointer('pointerdown', 100, 100)
    pointer('pointermove', 300, 250)
    pointer('pointerup', 300, 250)
    const bar = container.querySelector('[data-testid="las-overlay-chips"]')
    expect(bar).not.toBeNull()
    const buttons = bar!.querySelectorAll('button')
    expect(buttons).toHaveLength(3)
    expect([...buttons].map((b) => b.textContent)).toEqual([...OVERLAY_CHIPS])
    expect(buttons[DEFAULT_CHIP_INDEX].getAttribute('data-chip-index')).toBe('0')
    const sel = container.querySelector('[data-testid="las-overlay-selection"]') as HTMLElement
    expect(sel.style.width).toBe('200px')
    expect(sel.style.height).toBe('150px')
  })

  it('reversed (top-left) drag normalizes to a positive rect', async () => {
    const { api } = makeFakeApi(frameReply)
    await mount(api)
    pointer('pointerdown', 300, 250)
    pointer('pointermove', 100, 100)
    pointer('pointerup', 100, 100)
    const sel = container.querySelector('[data-testid="las-overlay-selection"]') as HTMLElement
    expect(sel.style.left).toBe('100px')
    expect(sel.style.top).toBe('100px')
  })

  it(`stray click (< ${10}px extent) behaves as cancel, never a select`, async () => {
    const { api, getCancels, selects } = makeFakeApi(frameReply)
    await mount(api)
    pointer('pointerdown', 100, 100)
    pointer('pointerup', 104, 105)
    expect(getCancels()).toBe(1)
    expect(selects).toHaveLength(0)
  })

  it('Esc during selection cancels', async () => {
    const { api, getCancels } = makeFakeApi(frameReply)
    await mount(api)
    key('Escape')
    expect(getCancels()).toBe(1)
  })
})

describe('OverlayApp confirm → select', () => {
  const frameReply = { ok: true, dataURL: FRAME_PNG, display: DISPLAY }

  async function dragSelection(api: unknown): Promise<void> {
    await mount(api as never)
    pointer('pointerdown', 50, 60)
    pointer('pointermove', 450, 460)
    pointer('pointerup', 450, 460)
  }

  it('Enter confirms with the DEFAULT chip prompt, crop result + CSS rect ride the payload', async () => {
    const { api, selects } = makeFakeApi(frameReply)
    await dragSelection(api)
    key('Enter')
    await act(async () => {})
    expect(selects).toEqual([{ rect: { x: 50, y: 60, width: 400, height: 400 }, dataURL: CROP_PNG, prompt: '解释这张图' }])
    expect(cropOk).toHaveBeenCalledWith(FRAME_PNG, { x: 50, y: 60, width: 400, height: 400 }, DISPLAY)
  })

  it('clicking 提取文字 submits THAT prompt (chip = VLM prompt text per plan)', async () => {
    const { api, selects } = makeFakeApi(frameReply)
    await dragSelection(api)
    const buttons = container.querySelectorAll('[data-testid="las-overlay-chips"] button')
    click(buttons[1])
    await act(async () => {})
    expect(selects[0]?.prompt).toBe('提取文字')
    expect(selects[0]?.dataURL).toBe(CROP_PNG)
  })

  it('crop rejection (canvas/size failure) → cancel, no select ever', async () => {
    const second = makeFakeApi(frameReply)
    const cropFails: OverlayCropFn = async () => {
      throw new Error('crop-too-large')
    }
    await mount(second.api, cropFails)
    pointer('pointerdown', 50, 60)
    pointer('pointermove', 450, 460)
    pointer('pointerup', 450, 460)
    click(container.querySelectorAll('[data-testid="las-overlay-chips"] button')[2])
    await act(async () => {})
    expect(second.selects).toHaveLength(0)
    expect(second.getCancels()).toBe(1)
  })
})
