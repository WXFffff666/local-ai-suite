// @vitest-environment jsdom
/**
 * MessageBubble.images.test.tsx — todo21 气泡贴图渲染 + lightbox
 * 覆盖：dataURL 图内联渲染；远端/svg URL 一律不生成 <img>（渲染层第二道闸）；
 * 点击缩略 → <dialog> 全尺寸预览；关闭按钮收敛。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MessageBubble from './MessageBubble'
import type { ChatMessage } from '../../../../chat/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'u1', role: 'user', content: '看图', createdAt: 1, ...overrides }
}

function mount(message: ChatMessage): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MessageBubble message={message} />)
  })
}

afterEach(() => {
  const r = root as Root | undefined
  const c = container as HTMLDivElement | undefined
  if (r) act(() => r.unmount())
  c?.remove()
})

describe('MessageBubble — todo21 images', () => {
  it('无 images 字段：与旧渲染逐字兼容（meta 行 + 文本，不出现图节点）', () => {
    mount(msg({}))
    expect(container.querySelector('[data-testid="msg-images"]')).toBeNull()
    expect(container.textContent).toContain('user')
    expect(container.textContent).toContain('看图')
  })

  it('dataURL 图逐张内联渲染（containment 类 + alt）', () => {
    mount(msg({ images: [PNG, JPEG] }))
    const imgs = container.querySelectorAll('[data-testid="msg-images"] img')
    expect(imgs).toHaveLength(2)
    expect(imgs[0]?.getAttribute('src')).toBe(PNG)
    expect(imgs[1]?.getAttribute('src')).toBe(JPEG)
  })

  it('远端 URL / svg / 非图 dataURL 一律不渲染（schema 之外的第二道闸）', () => {
    mount(msg({ images: ['https://evil.example/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)'] }))
    expect(container.querySelectorAll('[data-testid="msg-images"] img')).toHaveLength(0)
  })

  it('点击缩略图 → dialog lightbox 展示全尺寸；关闭按钮移除', () => {
    mount(msg({ images: [PNG] }))
    expect(container.querySelector('[data-testid="img-lightbox"]')).toBeNull()
    const thumb = container.querySelector<HTMLButtonElement>('.las-msg-image')!
    act(() => {
      thumb.click()
    })
    const dialog = container.querySelector('[data-testid="img-lightbox"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(PNG)
    const close = dialog?.querySelector<HTMLButtonElement>('[aria-label="close-lightbox"]')!
    act(() => {
      close.click()
    })
    expect(container.querySelector('[data-testid="img-lightbox"]')).toBeNull()
  })

  it('assistant 图片同样内联（VLM 输出侧预留）', () => {
    mount(msg({ role: 'assistant', content: '', images: [PNG] }))
    expect(container.querySelectorAll('[data-testid="msg-images"] img')).toHaveLength(1)
  })
})
