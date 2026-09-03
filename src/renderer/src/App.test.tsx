// @vitest-environment jsdom
/**
 * App.test.tsx — todo9 应用壳组件测试
 * 项目此前无 DOM 组件测试（theme.test.tsx 为纯 node 逻辑测试），
 * 本文件建立约定：per-file `@vitest-environment jsdom` + react act + createRoot。
 * 覆盖：六页导航渲染 / hash 路由切换改变标题 / 'app:notification' 仅在 window.api 存在时订阅。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from './App'
import { ThemeProvider } from '../../theme/theme'
import type { AppNotificationEvent } from '../../main/ipc/whitelist'

// react-dom/client 需要显式 act 环境标记
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// react-resizable-panels 依赖 ResizeObserver，jsdom 未实现 → 无害桩
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}

// next-themes 初始化会触碰 matchMedia，jsdom 未实现 → 恒非 dark 桩
window.matchMedia = ((query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList) as typeof window.matchMedia

/** 以未知形状读写 window.api 的测试辅助（绕过 preload 声明的非可选类型）。 */
function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}
function getFakeApi(): { on: ReturnType<typeof vi.fn> } | undefined {
  return (window as unknown as { api?: { on: ReturnType<typeof vi.fn> } }).api
}

const NAV_LABELS = ['Chat', 'Image', 'Gallery', 'Search', 'Market', 'Models', 'Settings'] as const

let container: HTMLDivElement
let root: Root

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  )
  act(() => {
    root.render(tree)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function navButton(label: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('button.las-nav-item')).find(
    (b) => b.textContent?.includes(label),
  )
  if (!btn) throw new Error(`nav button not found: ${label}`)
  return btn
}

beforeEach(() => {
  window.localStorage.clear()
  window.location.hash = ''
  setFakeApi(undefined)
})

afterEach(() => {
  unmount()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

describe('应用壳导航', () => {
  it('渲染 7 个导航项标签（todo13 新增 Models）', () => {
    mount()
    const labels = Array.from(container.querySelectorAll('button.las-nav-item')).map(
      (b) => b.textContent?.trim(),
    )
    expect(labels).toEqual([...NAV_LABELS])
  })

  it('默认路由为 Chat，标题渲染 Chat', () => {
    mount()
    expect(container.querySelector('h1')?.textContent).toBe('Chat')
  })

  it('点击导航切换路由改变页面标题', () => {
    mount()
    act(() => {
      navButton('Settings').click()
    })
    expect(container.querySelector('h1')?.textContent).toBe('Settings')
    expect(window.location.hash).toBe('#/settings')
    act(() => {
      navButton('Market').click()
    })
    expect(container.querySelector('h1')?.textContent).toBe('Market')
  })

  it('直接设置 hash 亦可路由（hashchange 驱动）', () => {
    mount()
    act(() => {
      window.location.hash = '#/gallery'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(container.querySelector('h1')?.textContent).toBe('Gallery')
  })
})

describe('主题集成（next-themes + 既有 ThemeProvider）', () => {
  it('无持久化记录时默认 dark（class + data-theme）', () => {
    mount()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('las:theme')).toBe('dark')
  })
})

describe('app:notification toast 订阅', () => {
  it('window.api 不存在（非 Electron 环境）→ 不订阅、不崩、Toaster 仍挂载一次', () => {
    mount()
    expect(document.querySelectorAll('section[aria-label^="Notifications"]')).toHaveLength(1)
  })

  it('window.api 存在 → 订阅 app:notification 并渲染 toast', async () => {
    const listeners: Array<(n: AppNotificationEvent) => void> = []
    setFakeApi({
      on: vi.fn((_channel: string, cb: (n: AppNotificationEvent) => void) => {
        listeners.push(cb)
        return () => {
          listeners.splice(listeners.indexOf(cb), 1)
        }
      }),
    })
    mount()
    expect(getFakeApi()?.on).toHaveBeenCalledWith('app:notification', expect.any(Function))
    await act(async () => {
      listeners[0]({ level: 'error', title: '端口冲突', message: '11434 已被占用', persistent: true })
      // sonner 经 height 测量（rAF/timeout）后提交 DOM，给一个 flush 窗口
      await new Promise((r) => setTimeout(r, 120))
    })
    expect(document.body.textContent).toContain('端口冲突')
  })
})
