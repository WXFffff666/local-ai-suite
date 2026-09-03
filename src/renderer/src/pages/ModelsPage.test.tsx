// @vitest-environment jsdom
/**
 * ModelsPage.test.tsx — todo13 模型管理页组件测试（约定同 App.test.tsx /
 * MarketPage.test.tsx：per-file jsdom + react act + createRoot + fake window.api）。
 * 覆盖计划验收：fixture models 渲染行数与徽标（损坏隔离 / 正常 / 格式未识别）、
 * 目录切换触发 invoke('models:setDir')（main 侧 reloadModels spy 由
 * handlers.test.ts 守）、应答 models 即时刷新表、window.api 缺席诚实降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ModelsPage from './ModelsPage'
import type { ModelRow } from '../components/modelspage/types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

/** registry fixture：正常 GGUF / probeFileHeader 隔离项 / 未识别格式。 */
const FIXTURE_MODELS: ModelRow[] = [
  {
    name: 'qwen3-4b-instruct-Q4_K_M',
    file: 'qwen3-4b-instruct-Q4_K_M.gguf',
    path: 'models/llm/qwen3-4b-instruct-Q4_K_M.gguf',
    size: 2_480_000_000,
    quant: 'Q4_K_M',
    arch: 'qwen3',
    format: 'gguf',
    mtimeMs: 1_700_000_000_000,
  },
  {
    name: 'bad-Q4_K_M',
    file: 'bad-Q4_K_M.gguf',
    path: 'models/llm/bad-Q4_K_M.gguf',
    size: 10,
    quant: 'Q4_K_M',
    arch: 'unknown',
    format: 'gguf',
    mtimeMs: 1_700_000_000_000,
    corrupted: true,
    error: 'bad GGUF magic',
  },
  {
    name: 'mystery-weights',
    file: 'mystery.bin',
    path: 'models/llm/mystery.bin',
    size: 512,
    quant: '',
    arch: '',
    format: 'unknown',
    mtimeMs: 1_700_000_000_000,
  },
]

type FakeApi = {
  invoke: ReturnType<typeof vi.fn>
  models: ModelRow[]
}

function makeFakeApi(overrides: Partial<{ list: unknown; setDir: unknown; launch: unknown }> = {}): FakeApi {
  const state: FakeApi = {
    models: FIXTURE_MODELS,
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'config:get') return { ok: true, config: { modelsDir: 'D:/models' } }
      if (channel === 'models:list') return overrides.list ?? { models: state.models }
      if (channel === 'models:setDir') {
        return (
          overrides.setDir ?? {
            ok: true,
            modelsDir: 'E:/ai/models',
            models: [FIXTURE_MODELS[0]],
            restartRequired: true,
          }
        )
      }
      if (channel === 'models:launch') {
        // todo30b: default ack = sidecar running; overrides.launch can force a rejection.
        return (
          overrides.launch ?? {
            ok: true,
            status: { name: 'llama', running: true, port: 11435, healthUrl: 'http://127.0.0.1:11435/health', failures: 0, restarts: 0, state: 'running' },
          }
        )
      }
      throw new Error(`unexpected channel: ${channel}`)
    }),
  }
  return state
}

let container: HTMLDivElement
let root: Root

function flush(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0))
}

async function mount(api?: FakeApi): Promise<void> {
  if (api) setFakeApi(api)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = <ModelsPage />
  await act(async () => {
    root.render(tree)
    await flush() // config:get + models:list
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function dirInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input.las-models-dir-input')
  if (!el) throw new Error('dir input not found')
  return el
}

async function typeDir(value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(dirInput(), value)
    dirInput().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  setFakeApi(undefined)
})

afterEach(() => {
  unmount()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

describe('ModelsPage 列表渲染（fixture models.json 投影）', () => {
  it('渲染 3 行 + 计数徽标 + 当前目录（config:get）', async () => {
    const api = makeFakeApi()
    await mount(api)
    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(3)
    expect(api.invoke).toHaveBeenCalledWith('models:list')
    expect(container.textContent).toContain('3 个模型')
    expect(container.querySelector('code.las-models-dir-current')?.textContent).toBe('D:/models')
    // arch/quant/format 列透出
    expect(rows[0].textContent).toContain('qwen3')
    expect(rows[0].textContent).toContain('Q4_K_M')
    expect(rows[0].textContent).toContain('2.3 GB')
  })

  it('损坏文件显示隔离徽标（probeFileHeader 结果透出），未识别格式弱徽标，正常行「正常」', async () => {
    await mount(makeFakeApi())
    const rows = container.querySelectorAll('tbody tr')
    expect(rows[0].querySelector('.las-models-ok')?.textContent).toBe('正常')
    const corrupt = rows[1].querySelector('.las-models-badge-corrupt')
    expect(corrupt).not.toBeNull()
    expect(corrupt!.textContent).toContain('损坏')
    expect(corrupt!.getAttribute('title')).toBe('bad GGUF magic')
    expect(rows[1].getAttribute('data-corrupted')).toBe('true')
    expect(rows[2].querySelector('.las-models-badge-unknown')?.textContent).toContain('格式未识别')
  })

  it('空注册表 → 空态文案（指向 Market 下载）', async () => {
    await mount(makeFakeApi({ list: { models: [] } }))
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toContain('模型目录为空')
  })

  it('window.api 缺席 → 诚实错误条，不崩', async () => {
    await mount() // 无 fake api
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('window.api')
  })
})

describe('ModelsPage 目录切换（models:setDir）', () => {
  it('输入绝对路径提交 → invoke models:setDir{path}；ok 应答刷新表并提示重启生效', async () => {
    const api = makeFakeApi()
    await mount(api)
    await typeDir('E:/ai/models')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.las-models-dir-apply')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('models:setDir', { path: 'E:/ai/models' })
    // 应答 models 即时替换列表（main 侧已 reloadModels）
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.querySelector('code.las-models-dir-current')?.textContent).toBe('E:/ai/models')
    expect(container.querySelector('.las-models-dir-note')?.textContent).toContain('重启')
  })

  it('dir-not-found 拒绝 → 错误条呈现且不换列表', async () => {
    const api = makeFakeApi({ setDir: { ok: false, error: 'dir-not-found' } })
    await mount(api)
    await typeDir('E:/nope')
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.las-models-dir-apply')!.click()
      await flush()
    })
    const alerts = container.querySelectorAll<HTMLElement>('[role="alert"]')
    expect(alerts[alerts.length - 1].textContent).toContain('目录不存在')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('「刷新」按钮重拉 models:list', async () => {
    const api = makeFakeApi()
    await mount(api)
    const before = api.invoke.mock.calls.filter((c) => c[0] === 'models:list').length
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.las-models-refresh')!.click()
      await flush()
    })
    const after = api.invoke.mock.calls.filter((c) => c[0] === 'models:list').length
    expect(after).toBe(before + 1)
  })
})

// todo30b — 行内「启动」按钮（models:launch → services.launchModel 的 UI 半程）
describe('ModelsPage 启动按钮（todo30b models:launch）', () => {
  it('仅正常 GGUF llm 行渲染按钮；损坏/未识别行不渲染', async () => {
    await mount(makeFakeApi())
    const rows = container.querySelectorAll('tbody tr')
    expect(rows[0].querySelector('button.las-models-launch')).not.toBeNull()
    expect(rows[1].querySelector('button.las-models-launch')).toBeNull() // corrupted
    expect(rows[2].querySelector('button.las-models-launch')).toBeNull() // unknown format
  })

  it('点击「启动」→ invoke models:launch{modelId}；成功应答呈现运行徽标', async () => {
    const api = makeFakeApi()
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.las-models-launch')!.click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('models:launch', { modelId: 'qwen3-4b-instruct-Q4_K_M' })
    expect(container.querySelector('.las-models-launch-ok')?.textContent).toContain('运行中')
  })

  it('{ok:false,error} 应答 → 行内启动失败徽标（不崩、可再点）', async () => {
    const api = makeFakeApi({ launch: { ok: false, error: 'model corrupted: x' } })
    await mount(api)
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button.las-models-launch')!.click()
      await flush()
    })
    const badge = container.querySelector('.las-models-launch-err')
    expect(badge?.textContent).toContain('启动失败')
    expect(badge?.getAttribute('title')).toContain('model corrupted')
    const btn = container.querySelector<HTMLButtonElement>('button.las-models-launch')!
    expect(btn.disabled).toBe(false)
  })

  it('diffusion/ 前缀的 GGUF（生图权重）不给启动按钮', async () => {
    const diffusion: ModelRow = {
      name: 'sd1.5-Q4_0',
      file: 'diffusion/sd1.5-Q4_0.gguf',
      path: 'models/diffusion/sd1.5-Q4_0.gguf',
      size: 2_000_000_000,
      quant: 'Q4_0',
      arch: 'sd',
      format: 'gguf',
      mtimeMs: 1_700_000_000_000,
    }
    await mount(makeFakeApi({ list: { models: [diffusion] } }))
    expect(container.querySelector('button.las-models-launch')).toBeNull()
  })
})
