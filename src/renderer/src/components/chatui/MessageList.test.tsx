// @vitest-environment jsdom
/**
 * MessageList.test.tsx — todo15 自动滚动/虚拟化
 * 覆盖：短会话 plain 路径全渲染；500 条走 virtuoso（VirtuosoMockContext 提供
 * 可测高度）窗口化 —— 挂载条目 ≪ 500 且定位到末条（长对话滚动容器受控 = 验收）；
 * 用户上滚（合成 scroll 事件）浮出 "Jump to latest" 药丸；isNearBottom 纯函数。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VirtuosoMockContext } from 'react-virtuoso'
import MessageList, { AT_BOTTOM_EPS, VIRTUALIZE_THRESHOLD, isNearBottom } from './MessageList'
import type { ChatMessage } from '../../../../chat/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function msg(i: number): ChatMessage {
  return { id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}`, createdAt: i }
}

function msgs(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => msg(i))
}

function mount(node: React.JSX.Element): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(node)
  })
}

/** virtuoso（MockContext）在计时器 tick 后才落窗口条目 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60))
  })
}

afterEach(() => {
  const r = root as Root | undefined
  const c = container as HTMLDivElement | undefined
  if (r) act(() => r.unmount())
  c?.remove()
})

describe('isNearBottom', () => {
  it('贴底/离底/容差边界', () => {
    expect(isNearBottom(800, 1000, 200)).toBe(true)
    expect(isNearBottom(0, 1000, 200)).toBe(false)
    expect(isNearBottom(1000 - 200 - AT_BOTTOM_EPS, 1000, 200)).toBe(true)
    expect(isNearBottom(1000 - 200 - AT_BOTTOM_EPS - 1, 1000, 200)).toBe(false)
  })
})

describe('plain 路径（≤ 阈值）', () => {
  it('全部气泡挂载且 scroller 存在', () => {
    mount(<MessageList messages={msgs(VIRTUALIZE_THRESHOLD)} />)
    expect(container.querySelectorAll('.las-bubble').length).toBe(VIRTUALIZE_THRESHOLD)
    expect(container.querySelector('[data-testid="message-scroller"]')).not.toBeNull()
  })

  it('上滚离开底部 → Jump to latest 药丸出现，点击后消失', () => {
    mount(<MessageList messages={msgs(3)} />)
    expect(container.querySelector('.las-jump-pill')).toBeNull()
    const el = container.querySelector<HTMLDivElement>('[data-testid="message-scroller"]')!
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 0, writable: true })
    act(() => {
      el.dispatchEvent(new Event('scroll'))
    })
    const pill = container.querySelector<HTMLButtonElement>('.las-jump-pill')
    expect(pill?.textContent).toContain('Jump to latest')
    act(() => {
      pill!.click()
    })
    expect(container.querySelector('.las-jump-pill')).toBeNull()
  })
})

describe('virtuoso 路径（> 阈值，MockContext 提供视口/条目高度）', () => {
  it('500 条消息：窗口化挂载（≪500 且 >0）——滚动容器受控', async () => {
    mount(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 80 }}>
        <MessageList messages={msgs(500)} />
      </VirtuosoMockContext.Provider>,
    )
    await settle()
    const rows = container.querySelectorAll('.las-bubble')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(100)
    expect(rows.length).toBeLessThan(500)
    expect(container.querySelector('[data-testid="message-scroller"]')).not.toBeNull()
    // 末条贴底定位由 mount 效应 + followOutput 承担（真实浏览器行为；
    // MockContext 不模拟 handle.scrollToIndex 的最终锚点，此处锁定窗口化本身）
  })
})
