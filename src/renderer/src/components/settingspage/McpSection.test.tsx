// @vitest-environment jsdom
/**
 * McpSection.test.tsx — todo40 设置页「MCP 服务器」区（OcrSection.test 同款假
 * api 约定）：listServers 渲染行（状态徽章 / 工具数 / env keys）；failed 行 →
 * 重启按钮 + lastError tooltip；enable 开关 → mcp:setEnabled；表单 →
 * mcp:upsertServer（args/env 行解析）；列工具 → mcp:listTools → 测试 →
 * mcp:callTool（结果行）；'mcp:status' 事件即时刷新行状态；无 api 整区隐藏。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { McpSection, parseArgsLines, parseEnvLines } from './McpSection'
import type { McpServerView, McpStatusEvent } from '../../../../main/ipc/whitelist'

;(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const RUNNING: McpServerView = {
  name: 'demo', command: 'node', args: ['server.js'], envKeys: ['TOKEN'],
  enabled: true, state: 'running', toolCount: 2, lastError: null,
}
const FAILED: McpServerView = { ...RUNNING, state: 'failed', toolCount: null, lastError: 'spawn ENOENT' }

function makeApi(servers: McpServerView[] = [RUNNING]) {
  const listeners: Array<(ev: McpStatusEvent) => void> = []
  const invoke = vi.fn(async (channel: string, payload?: Record<string, unknown>) => {
    if (channel === 'mcp:listServers') return { ok: true, servers }
    if (channel === 'mcp:upsertServer') return { ok: true, server: { ...RUNNING, name: String(payload?.name ?? 'demo') } }
    if (channel === 'mcp:removeServer') return { ok: true }
    if (channel === 'mcp:setEnabled') return { ok: true, server: { ...RUNNING, enabled: Boolean(payload?.enabled) } }
    if (channel === 'mcp:listTools') return { ok: true, tools: [{ name: 'echo', description: 'echoes' }] }
    if (channel === 'mcp:callTool') return { ok: true, result: { content: [{ type: 'text', text: 'hi' }] } }
    throw new Error(`unexpected channel ${channel}`)
  })
  const on = vi.fn((_ch: string, cb: (ev: McpStatusEvent) => void) => {
    listeners.push(cb)
    return () => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    }
  })
  ;(window as unknown as { api: unknown }).api = { invoke, on }
  return { invoke, emit: (ev: McpStatusEvent) => listeners.slice().forEach((l) => l(ev)) }
}

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<McpSection />)
    await new Promise((r) => setTimeout(r, 0))
  })
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  if (root !== undefined) {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
  delete (window as unknown as { api?: unknown }).api
})

describe('line parsers', () => {
  it('parseArgsLines 去空行去空白; parseEnvLines 首个 = 分割、坏行丢弃', () => {
    expect(parseArgsLines(' a \n\nb\n')).toEqual(['a', 'b'])
    expect(parseEnvLines('K=V\nBROKEN\nA=b=c')).toEqual({ K: 'V', A: 'b=c' })
  })
})

describe('McpSection', () => {
  it('running 行：状态徽章 + 工具数 + env keys + 无重启按钮', async () => {
    const api = makeApi()
    await mount()
    expect(api.invoke).toHaveBeenCalledWith('mcp:listServers', {})
    expect(container.querySelector('[data-testid="mcp-state-demo"]')?.textContent).toContain('运行中')
    expect(container.querySelector('[data-testid="mcp-state-demo"]')?.textContent).toContain('env:TOKEN')
    expect(container.querySelector('[data-testid="mcp-tools-count-demo"]')?.textContent).toContain('2 工具')
    expect(container.querySelector('[data-testid="mcp-restart-demo"]')).toBeNull()
  })

  it('failed 行：重启按钮 + lastError tooltip → mcp:setEnabled(true)', async () => {
    const api = makeApi([FAILED])
    await mount()
    const btn = container.querySelector<HTMLButtonElement>('[data-testid="mcp-restart-demo"]')
    expect(btn?.title).toBe('spawn ENOENT')
    await act(async () => {
      btn!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('mcp:setEnabled', { name: 'demo', enabled: true })
  })

  it("'mcp:status' 事件 → 行状态即时刷新", async () => {
    makeApi([RUNNING])
    await mount()
    const listener = (window as unknown as { api: { on: ReturnType<typeof vi.fn> } }).api.on.mock.calls[0]?.[1] as (
      ev: McpStatusEvent,
    ) => void
    await act(async () => {
      listener({ name: 'demo', state: 'failed', error: 'boom' })
      await flush()
    })
    expect(container.querySelector('[data-testid="mcp-state-demo"]')?.textContent).toContain('失败')
  })

  it('enable 开关 → mcp:setEnabled；删除 → mcp:removeServer + 列表刷新', async () => {
    const api = makeApi()
    await mount()
    await act(async () => {
      const box = container.querySelector<HTMLInputElement>('[data-testid="mcp-enabled-demo"]')
      box!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('mcp:setEnabled', { name: 'demo', enabled: false })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-remove-demo"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('mcp:removeServer', { name: 'demo' })
  })

  it('表单保存 → mcp:upsertServer（args/env 行解析）', async () => {
    const api = makeApi([])
    await mount()
    await act(async () => {
      const set = (testid: string, value: string) => {
        const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testid}"]`)!
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set('mcp-form-name', 'fs')
      set('mcp-form-command', 'npx')
      set('mcp-form-args', '-y\n@modelcontextprotocol/server-filesystem')
      set('mcp-form-env', 'KEY=val')
      await flush()
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-save"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('mcp:upsertServer', {
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { KEY: 'val' },
      enabled: true,
    })
  })

  it('列工具 → mcp:listTools → 测试 → mcp:callTool 结果行', async () => {
    const api = makeApi()
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-tools-demo"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('mcp:listTools', { name: 'demo' })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-call-demo-echo"]')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('mcp:callTool', { name: 'demo', tool: 'echo', args: {} })
    expect(container.querySelector('[data-testid="mcp-call-result-demo-echo"]')?.textContent).toContain('hi')
  })

  it('listTools 失败 → 行内提示错误码', async () => {
    const api = makeApi()
    api.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'mcp:listTools') return { ok: false, error: 'server-failed' }
      if (channel === 'mcp:listServers') return { ok: true, servers: [FAILED] }
      return { ok: true }
    })
    await mount()
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-tools-demo"]')!.click()
      await flush()
    })
    expect(container.textContent).toContain('server-failed')
  })

  it('无 window.api（纯浏览器预览）→ 整区不渲染', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<McpSection />)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(container.textContent).toBe('')
  })
})
