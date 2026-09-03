// @vitest-environment jsdom
/**
 * MessageBubble.ocr.test.tsx — todo37 气泡贴图「提取文字」（hover 最小动作钮）：
 * 无 ocr prop = 旧渲染逐字兼容（特征测试守门）；有 ocr：每张图一个
 * msg-ocr-btn，available=false 禁用 + 去设置提示；点击 → busy → 结果
 * <pre> + 复制/追加到输入框；追加回调收到识别文本；失败显示错误行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MessageBubble from './MessageBubble'
import type { MessageOcrApi } from './MessageBubble'
import type { ChatMessage } from '../../../../chat/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

let container: HTMLDivElement
let root: Root

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'u1', role: 'user', content: '看图', createdAt: 1, ...overrides }
}

function mount(props: { message: ChatMessage; ocr?: MessageOcrApi; onOcrInsert?: (t: string) => void }): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MessageBubble {...props} />)
  })
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('MessageBubble — todo37 提取文字', () => {
  it('无 ocr prop：不渲染任何 OCR 节点（旧 DOM 逐字兼容）', () => {
    mount({ message: msg({ images: [PNG] }) })
    expect(container.querySelector('[data-testid^="msg-ocr-btn"]')).toBeNull()
    expect(container.textContent).toContain('看图')
  })

  it('有 ocr：每图一个按钮；available=false 禁用且 title 指路设置', () => {
    mount({ message: msg({ images: [PNG] }), ocr: { available: false, recognize: vi.fn() } })
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')
    expect(btn).not.toBeNull()
    expect(btn?.disabled).toBe(true)
    expect(btn?.title).toContain('设置')
  })

  it('点击 → busy → 结果文本 + 追加到输入框回调', async () => {
    const recognize = vi.fn(async () => '提取的文字')
    const onOcrInsert = vi.fn()
    mount({ message: msg({ images: [PNG] }), ocr: { available: true, recognize }, onOcrInsert })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')!.click()
      await flush()
    })
    expect(recognize).toHaveBeenCalledWith(PNG)
    expect(container.querySelector('[data-testid="msg-ocr-0"]')?.textContent).toContain('提取的文字')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-insert-0"]')!.click()
    })
    expect(onOcrInsert).toHaveBeenCalledWith('提取的文字')
  })

  it('识别失败 → 错误行明示，按钮恢复可用', async () => {
    const recognize = vi.fn(async () => {
      throw new Error('engine-missing')
    })
    mount({ message: msg({ images: [PNG] }), ocr: { available: true, recognize } })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')!.click()
      await flush()
    })
    expect(container.querySelector('[data-testid="msg-ocr-0"]')?.textContent).toContain('engine-missing')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')?.disabled).toBe(false)
  })

  it('单图进行中：仅该按钮禁用，另一图不受影响', async () => {
    let release = (): void => undefined
    const recognize = vi.fn(
      () =>
        new Promise<string>((res) => {
          release = () => res('done')
        }),
    )
    mount({ message: msg({ images: [PNG, PNG] }), ocr: { available: true, recognize } })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')!.click()
      await flush()
    })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-1"]')?.disabled).toBe(false)
    await act(async () => {
      release()
      await flush()
    })
    expect(container.querySelector<HTMLButtonElement>('[data-testid="msg-ocr-btn-0"]')?.disabled).toBe(false)
  })
})
