// @vitest-environment jsdom
/**
 * EngineStatus.test.tsx — todo30b 设置页引擎状态区测试（约定同 SecretRow /
 * ModelsPage：per-file jsdom + react act + createRoot + fake window.api）。
 * 覆盖计划验收：availability 矩阵渲染（engine|source|version|platform）、
 * NVIDIA 检测卡 + VRAM 行、GPU 包按钮启用逻辑（无 nvidia / manifest 缺席
 * = 'dev模式:由 CI 生成' 禁用+tooltip）、engines:progress → 进度条、
 * quarantined → 红色 toast「GPU 包损坏，已回退 CPU」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EngineStatus } from './EngineStatus'
import type { EnginesProgressEvent, EnginesStatusReply } from '../../../../main/ipc/whitelist'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const STATUS_OK: EnginesStatusReply = {
  ok: true,
  platform: 'win32',
  resolutions: [
    { name: 'llama', source: 'bundled-cpu', bin: 'C:/app/engines/llama-server.exe', version: 'b4000', skipped: [] },
    { name: 'ollama', source: 'none', bin: null, skipped: [{ source: 'system', reason: 'not on PATH' }] },
    { name: 'sd', source: 'gpu-pack', bin: 'C:/ud/engines/sd-cuda/sd-cli.exe', skipped: [] },
  ],
  nvidia: { available: true, name: 'RTX 4060', driverVersion: '552.22', memoryMB: 8188 },
  manifest: { present: true, generatedAt: '2026-09-01T00:00:00Z', variants: { llama: ['cuda', 'vulkan'], sd: ['cuda'] } },
}

function statusWith(patch: Partial<Extract<EnginesStatusReply, { ok: true }>>): EnginesStatusReply {
  return { ...STATUS_OK, ...patch } as EnginesStatusReply
}

type FakeApi = {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  fire: (ev: EnginesProgressEvent) => void
  listeners: Set<(p: EnginesProgressEvent) => void>
}

function makeFakeApi(reply: EnginesStatusReply | Error = STATUS_OK): FakeApi {
  const listeners = new Set<(p: EnginesProgressEvent) => void>()
  const api: FakeApi = {
    listeners,
    on: vi.fn((_ch: string, l: (p: EnginesProgressEvent) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    }),
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      if (channel === 'engines:status') {
        if (reply instanceof Error) throw reply
        return reply
      }
      if (channel === 'engines:gpuDownload') {
        expect(payload).toEqual({ engine: expect.any(String), variant: expect.any(String) })
        return { ok: true }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }),
    fire: (ev) => {
      for (const l of [...listeners]) l(ev)
    },
  }
  return api
}

let container: HTMLDivElement
let root: Root

function flush(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0))
}

async function mount(api: FakeApi | undefined): Promise<void> {
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<EngineStatus />)
    await flush()
  })
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button.las-engine-dl')]
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
    await flush()
  })
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = undefined
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('引擎可用性矩阵', () => {
  it('渲染 3 行（engine|source|version|platform），来源译名 + 缺失行如实呈现', async () => {
    await mount(makeFakeApi())
    const rows = container.querySelectorAll('table.las-engine-matrix tbody tr')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('llama')
    expect(rows[0].textContent).toContain('内置CPU')
    expect(rows[0].textContent).toContain('b4000')
    expect(rows[0].textContent).toContain('win32')
    expect(rows[1].textContent).toContain('缺失')
    expect(rows[1].querySelector('td')?.getAttribute('title')).toContain('not on PATH')
    expect(rows[2].textContent).toContain('GPU包')
  })

  it('NVIDIA 检测卡：显卡名 + VRAM GB 行', async () => {
    await mount(makeFakeApi())
    const card = container.querySelector('.las-engine-nvidia')
    expect(card?.textContent).toContain('RTX 4060')
    expect(card?.textContent).toContain('8.0 GB')
  })

  it('无 NVIDIA → 检测卡显示未检测到，GPU 按钮全部禁用且 tooltip 说明原因', async () => {
    await mount(
      makeFakeApi(
        statusWith({
          nvidia: { available: false, reason: 'no-nvidia-smi' },
        }),
      ),
    )
    expect(container.querySelector('.las-engine-nvidia')?.textContent).toContain('未检测到')
    const btns = buttons()
    expect(btns.length).toBeGreaterThan(0)
    for (const b of btns) {
      expect(b.disabled).toBe(true)
      expect(b.title).toContain('NVIDIA')
    }
  })

  it('manifest 缺席（dev）→ 按钮禁用 + tooltip「dev模式:由 CI 生成」', async () => {
    await mount(
      makeFakeApi(
        statusWith({
          manifest: { present: false, generatedAt: null, variants: {} },
        }),
      ),
    )
    const btns = buttons()
    expect(btns.length).toBeGreaterThan(0)
    for (const b of btns) {
      expect(b.disabled).toBe(true)
      expect(b.title).toContain('dev模式:由 CI 生成')
    }
  })
})

describe('GPU 包下载按钮 + 进度', () => {
  it('manifest 有变体 + NVIDIA 可用 → 每变体一枚启用按钮；点击 invoke engines:gpuDownload{engine,variant}', async () => {
    const api = makeFakeApi()
    await mount(api)
    const btns = buttons()
    expect(btns.map((b) => `${b.dataset.engine}/${b.dataset.variant}`)).toEqual(['llama/cuda', 'llama/vulkan', 'sd/cuda'])
    expect(btns[0].disabled).toBe(false)
    await click(btns[0])
    expect(api.invoke).toHaveBeenCalledWith('engines:gpuDownload', { engine: 'llama', variant: 'cuda' })
  })

  it('engines:progress 下载事件 → 进度条呈现（received/total 百分比 + 状态）', async () => {
    const api = makeFakeApi()
    await mount(api)
    await click(buttons()[0])
    act(() => {
      api.fire({ engine: 'llama', variant: 'cuda', received: 420, total: 1000, state: 'downloading' })
    })
    const bar = container.querySelector<HTMLProgressElement>('progress.las-engine-bar')
    if (!bar) throw new Error('progress bar missing')
    expect(bar.getAttribute('value')).toBe('42')
    expect(bar.getAttribute('max')).toBe('100')
    expect(container.querySelector('.las-engine-progress-slot')?.textContent).toContain('42%')
  })

  it('done 事件 → 进度条移除并重新拉取 engines:status', async () => {
    const api = makeFakeApi()
    await mount(api)
    await click(buttons()[0])
    await act(async () => {
      api.fire({ engine: 'llama', variant: 'cuda', received: 1000, total: 1000, state: 'done' })
      await flush()
    })
    expect(container.querySelector('progress.las-engine-bar')).toBeNull()
    const statusCalls = api.invoke.mock.calls.filter((c) => c[0] === 'engines:status').length
    expect(statusCalls).toBeGreaterThanOrEqual(2)
  })

  it('quarantined 事件 → 红色 toast「GPU 包损坏，已回退 CPU」', async () => {
    const api = makeFakeApi()
    await mount(api)
    await click(buttons()[0])
    await act(async () => {
      api.fire({
        engine: 'llama',
        variant: 'cuda',
        received: 1000,
        total: 1000,
        state: 'quarantined',
        note: 'GPU 包损坏，已回退 CPU',
      })
      await flush()
    })
    const toast = container.querySelector<HTMLElement>('[role="alert"].las-engine-toast-danger')
    expect(toast?.textContent).toContain('GPU 包损坏，已回退 CPU')
  })
})

describe('降级路径', () => {
  it('window.api 缺席 → 诚实 note，不崩', async () => {
    await mount(undefined)
    expect(container.textContent).toContain('window.api')
  })

  it('engines:status 失败 → 错误条呈现', async () => {
    await mount(makeFakeApi(new Error('ipc down')))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('ipc down')
  })
})
