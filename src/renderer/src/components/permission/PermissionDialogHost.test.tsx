// @vitest-environment jsdom
/**
 * todo25 — PermissionDialogHost jsdom tests (convention per App.test.tsx:
 * per-file jsdom + react act + createRoot + fake window.api). Covers the
 * plan acceptance matrix: all four grant buttons post the exact enum,
 * Esc = deny, diff rows render with +/- semantics, command/net previews
 * show the raw target, the countdown is rendered, stale responses close
 * the dialog, requests queue, and the host degrades to null without
 * window.api.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PermissionDialogHost from './PermissionDialogHost'
import type { PermissionRequestEvent } from '../../../../main/ipc/whitelist'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// vi.hoisted: the sonner mock factory runs during import processing, before
// module-level consts initialize — plain `const toastSpy` would be in TDZ.
const toastInfo = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: Object.assign((..._args: unknown[]): void => undefined, {
    info: toastInfo,
    error: toastError
  })
}))

type FakeApi = {
  on: ReturnType<typeof vi.fn>
  invoke: ReturnType<typeof vi.fn>
  listener: ((payload: unknown) => void) | null
}

let fakeApi: FakeApi
let container: HTMLDivElement
let root: Root

function makeRequest(overrides?: Partial<PermissionRequestEvent>): PermissionRequestEvent {
  return {
    requestId: 'req-1',
    action: { type: 'fs.write', target: { path: 'src/app.ts' } },
    assessment: { decision: 'ask', rule: null, ruleId: null, scope: null },
    preview: { kind: 'diff', path: 'src/app.ts', oldText: 'alpha\nbeta\ngamma', newText: 'alpha\nBETA\ngamma' },
    timeoutMs: 120_000,
    requestedAt: Date.now(),
    ...overrides
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return container.querySelector<T>(sel)
}
function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="permission-dialog"] button'))
}
function clickByText(label: string): HTMLButtonElement {
  const btn = buttons().find((b) => b.textContent === label)
  if (!btn) throw new Error(`button ${label} not rendered`)
  act(() => {
    btn.click()
  })
  return btn
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<PermissionDialogHost />)
  })
}

beforeEach(() => {
  toastInfo.mockReset()
  toastError.mockReset()
  fakeApi = {
    on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
      fakeApi.listener = listener
      return () => undefined
    }),
    invoke: vi.fn(async () => ({ ok: true })),
    listener: null
  }
  ;(window as unknown as { api: unknown }).api = fakeApi
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as unknown as { api: unknown }).api
})

describe('PermissionDialogHost', () => {
  it('window.api 缺失 → 渲染 null，不崩', () => {
    delete (window as unknown as { api: unknown }).api
    mount()
    expect(q('[data-testid="permission-dialog"]')).toBeNull()
  })

  it('订阅 permission:request；无请求时不渲染弹窗', () => {
    mount()
    expect(fakeApi.on).toHaveBeenCalledWith('permission:request', expect.any(Function))
    expect(q('[data-testid="permission-dialog"]')).toBeNull()
  })

  it('fs.write 请求 → 弹窗渲染 unified diff 行（+绿 / -红）与规则、按钮、倒计时', () => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    expect(q('[data-testid="permission-dialog"]')).not.toBeNull()
    expect(q('[data-testid="permission-summary"]')?.textContent).toContain('src/app.ts')
    const diff = q('[data-testid="permission-diff"]')
    expect(diff).not.toBeNull()
    expect(diff?.querySelector('.diff-ctx')?.textContent).toBe('alpha')
    expect(diff?.querySelector('.diff-del')?.textContent).toBe('beta')
    expect(diff?.querySelector('.diff-add')?.textContent).toBe('BETA')
    expect(diff?.querySelector('.diff-rule')?.textContent).toContain('Edit(src/app.ts)')
    expect(buttons().map((b) => b.textContent)).toEqual(['本次允许', '本会话允许', '始终允许', '拒绝'])
    expect(q('[data-testid="permission-countdown"]')?.textContent).toMatch(/^\d+s$/)
  })

  it('默认规则（无命中）→ 显示默认 ask 说明', () => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    expect(q('.diff-rule')?.textContent).toContain('默认询问')
  })

  it('shell 请求 → command 预览显示完整命令与 cwd', () => {
    mount()
    act(() => {
      fakeApi.listener?.(
        makeRequest({
          action: { type: 'fs.shell', target: { cmd: 'rm -rf build' } },
          preview: { kind: 'command', cmd: 'rm -rf build', cwd: 'D:/work/proj' }
        })
      )
    })
    expect(q('[data-testid="permission-command"]')?.textContent).toContain('rm -rf build')
    expect(q('[data-testid="permission-cwd"]')?.textContent).toContain('D:/work/proj')
  })

  it('net 请求 → 预览显示 host/path', () => {
    mount()
    act(() => {
      fakeApi.listener?.(
        makeRequest({
          action: { type: 'net', target: { host: 'api.openai.com', path: '/v1' } },
          preview: { kind: 'net', host: 'api.openai.com', path: '/v1' }
        })
      )
    })
    expect(q('[data-testid="permission-net"]')?.textContent).toContain('api.openai.com/v1')
  })

  it('超大 diff（>300 行）→ 原文回退渲染', () => {
    mount()
    const big = Array.from({ length: 301 }, (_, i) => `l${i}`).join('\n')
    act(() => {
      fakeApi.listener?.(
        makeRequest({ preview: { kind: 'diff', path: 'big.ts', oldText: big, newText: `${big}\nx` } })
      )
    })
    expect(q('[data-testid="permission-raw"]')).not.toBeNull()
    expect(q('[data-testid="permission-diff"]')).toBeNull()
  })

  it.each([
    ['本次允许', 'once'],
    ['本会话允许', 'session'],
    ['始终允许', 'always'],
    ['拒绝', 'deny']
  ] as const)('按钮「%s」→ invoke permission:respond choice=%s', async (label, choice) => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    clickByText(label)
    expect(fakeApi.invoke).toHaveBeenCalledWith('permission:respond', { requestId: 'req-1', choice })
    await flush()
  })

  it('点击「始终允许」后弹窗关闭（单请求队列清空）', async () => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    clickByText('始终允许')
    await flush()
    expect(q('[data-testid="permission-dialog"]')).toBeNull()
  })

  it('拒绝（含 Esc）→ toast 提示拒绝原因', async () => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(fakeApi.invoke).toHaveBeenCalledWith('permission:respond', { requestId: 'req-1', choice: 'deny' })
    await flush()
    expect(toastInfo).toHaveBeenCalled()
  })

  it('主进程回 unknown-request（已超时/已中止）→ 弹窗自动关闭', async () => {
    fakeApi.invoke.mockResolvedValue({ ok: false, error: 'unknown-request' })
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    clickByText('本次允许')
    await flush()
    expect(q('[data-testid="permission-dialog"]')).toBeNull()
    expect(toastError).toHaveBeenCalled()
  })

  it('弹窗期间新请求排队，前一请求结算后显示下一个', async () => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest({ requestId: 'req-a' }))
      fakeApi.listener?.(makeRequest({ requestId: 'req-b' }))
    })
    expect(q('[data-testid="permission-dialog"]')?.getAttribute('data-request-id')).toBe('req-a')
    clickByText('拒绝')
    await flush()
    expect(q('[data-testid="permission-dialog"]')?.getAttribute('data-request-id')).toBe('req-b')
  })

  it('焦点陷阱：打开时拒绝按钮获得焦点，Tab 在弹窗内循环', () => {
    mount()
    act(() => {
      fakeApi.listener?.(makeRequest())
    })
    const btns = buttons()
    const deny = btns[btns.length - 1]
    expect(document.activeElement).toBe(deny)
    act(() => {
      deny.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(document.activeElement).toBe(btns[0])
  })
})
