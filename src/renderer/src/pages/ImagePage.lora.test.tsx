// @vitest-environment jsdom
/**
 * ImagePage.lora.test.tsx — todo19 集成面：LoRA 选择 → image:generate 载荷
 * loras 精确（QA happy：选 2 个 → 两标签）；未选 → 载荷无 loras 键（保住
 * todo20 的严格形状测试）；done → gallery:save 快照 extra.loras。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ImagePage } from './ImagePage'
import type { LoraFile } from '../components/lora/loraShared'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'

const LORAS: LoraFile[] = [
  { name: 'marblesh', file: 'diffusion/lora/marblesh.safetensors', path: 'D:\\models\\diffusion\\lora\\marblesh.safetensors', sizeLabel: '142.3 MB', format: 'safetensors' },
  { name: 'gray', file: 'diffusion/lora/gray.safetensors', path: 'D:\\models\\diffusion\\lora\\gray.safetensors', sizeLabel: '98.0 MB', format: 'safetensors' },
]

function makeFakeApi() {
  const invoke = vi.fn(async (channel: string, payload?: unknown): Promise<unknown> => {
    if (channel === 'models:loraScan') return { ok: true, files: LORAS }
    if (channel === 'models:loraMeta') return { ok: true, meta: { ss_network_dim: 16 } }
    if (channel === 'image:generate') return { ok: true, statusCode: 202, jobId: 'job-1' }
    if (channel === 'image:queue:status') return { ok: true, job: { status: 'done', result: { b64: TINY_PNG_B64 } } }
    if (channel === 'gallery:save') return { ok: true, item: { id: 'g1' } }
    void payload
    throw new Error(`unexpected channel: ${channel}`)
  })
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const on = vi.fn((channel: string, listener: (p: unknown) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(listener)
    return () => listeners.get(channel)?.delete(listener)
  })
  const emit = (channel: string, payload: unknown): void => {
    for (const l of listeners.get(channel) ?? []) l(payload)
  }
  return { api: { invoke, on }, invoke, emit }
}

let container: HTMLDivElement
let root: Root

async function mount(fake: ReturnType<typeof makeFakeApi>): Promise<void> {
  ;(window as unknown as { api: unknown }).api = fake.api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<ImagePage />)
    await Promise.resolve()
  })
  // 二次 flush 保证 loraScan 应答落地（unhandled microtask 已在 act 内消费）
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = undefined
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  ;(window as unknown as { api: unknown }).api = undefined
  vi.restoreAllMocks()
})

describe('ImagePage — LoRA 提交通路', () => {
  it('mount 触发 models:loraScan 并渲染选择器列表', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    expect(fake.invoke).toHaveBeenCalledWith('models:loraScan', {})
    expect(container.querySelector('[data-testid="lora-item-marblesh"]')).not.toBeNull()
  })

  it('选 2 个 LoRA 提交 → image:generate 的 loras 载荷精确为两条 {name,scale}', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    const checkbox = container.querySelector<HTMLInputElement>('[data-testid="lora-item-marblesh"] input[type="checkbox"]')!
    await act(async () => {
      checkbox.click()
      await Promise.resolve()
    })
    await act(async () => {
      const slider = container.querySelector<HTMLInputElement>('[data-testid="lora-scale-marblesh"]')!
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(slider, '0.85')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const second = container.querySelector<HTMLInputElement>('[data-testid="lora-item-gray"] input[type="checkbox"]')!
    await act(async () => {
      second.click()
      await Promise.resolve()
    })
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'a lovely cat')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    const call = fake.invoke.mock.calls.find((c) => c[0] === 'image:generate')
    expect(call).toBeDefined()
    expect((call![1] as { loras: unknown }).loras).toEqual([
      { name: 'marblesh', scale: 0.85 },
      { name: 'gray', scale: 0.75 },
    ])
  })

  it('未选 LoRA → image:generate 载荷不含 loras 键（todo20 严格形状不破）', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'plain')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    const call = fake.invoke.mock.calls.find((c) => c[0] === 'image:generate')
    expect(call).toBeDefined()
    expect(call![1]).not.toHaveProperty('loras')
  })

  it('带 LoRA 生成 done → gallery:save 快照 extra.loras 落盘', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    const checkbox = container.querySelector<HTMLInputElement>('[data-testid="lora-item-marblesh"] input[type="checkbox"]')!
    await act(async () => {
      checkbox.click()
      await Promise.resolve()
    })
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, 'tagged')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector('form.las-img-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await act(async () => {
      fake.emit('image:queue:status', { type: 'done', jobId: 'job-1', progress: 100, status: 'done' })
      await Promise.resolve()
    })
    expect(fake.invoke).toHaveBeenCalledWith(
      'gallery:save',
      expect.objectContaining({ extra: { loras: [{ name: 'marblesh', scale: 0.75 }] } }),
    )
  })
})
