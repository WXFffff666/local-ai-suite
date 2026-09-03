// @vitest-environment jsdom
/**
 * LoraPicker.test.tsx — todo19 组件测试（约定同 ImagePage.test：per-file jsdom
 * + createRoot + fake window.api）。覆盖计划验收：fixture lora 文件列出、
 * 滑杆变更生成 `<lora:x:0.75>` 系标签、meta 解析失败显示 unknown 但可选择、
 * 空目录/无 api 诚实降级、onChange 载荷精确。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LoraPicker } from './LoraPicker'
import type { LoraFile, LoraSelection } from './loraShared'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const MARBLESH: LoraFile = {
  name: 'marblesh',
  file: 'diffusion/lora/marblesh.safetensors',
  path: 'D:\\models\\diffusion\\lora\\marblesh.safetensors',
  sizeLabel: '142.3 MB',
  format: 'safetensors',
}
const ANIME: LoraFile = {
  name: 'anime-flat',
  file: 'diffusion/lora/anime-flat.safetensors',
  path: 'D:\\models\\diffusion\\lora\\anime-flat.safetensors',
  sizeLabel: '98.0 MB',
  format: 'safetensors',
}

function makeFakeApi(opts: { files?: LoraFile[]; metaFail?: boolean; scanFail?: boolean } = {}) {
  const files = opts.files ?? [MARBLESH, ANIME]
  const invoke = vi.fn(async (channel: string, payload?: unknown): Promise<unknown> => {
    if (channel === 'models:loraScan') {
      if (opts.scanFail) throw new Error('channel unavailable')
      return { ok: true, files }
    }
    if (channel === 'models:loraMeta') {
      if (opts.metaFail) return { ok: false, error: 'bad-header' }
      const p = payload as { path: string }
      if (p.path !== MARBLESH.path) return { ok: false, error: 'bad-header' }
      return { ok: true, meta: { ss_tag_string: 'marbled, art', ss_network_dim: 32 } }
    }
    throw new Error(`unexpected channel: ${channel}`)
  })
  return { api: { invoke }, invoke }
}

let lastOnChange: ((s: LoraSelection[]) => void) | undefined

function Harness(props: { onSeen: (sel: LoraSelection[]) => void }): ReactNode {
  const [sel, setSel] = useState<LoraSelection[]>([])
  lastOnChange = (next: LoraSelection[]): void => {
    setSel(next)
    props.onSeen(next)
  }
  return <LoraPicker value={sel} onChange={lastOnChange} />
}

let container: HTMLDivElement
let root: Root

async function mount(fake?: ReturnType<typeof makeFakeApi>): Promise<LoraSelection[][]> {
  ;(window as unknown as { api: unknown }).api = fake?.api
  lastOnChange = undefined
  const seen: LoraSelection[][] = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Harness onSeen={(s) => seen.push(s)} />)
    await Promise.resolve()
  })
  return seen
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
  ;(window as unknown as { api: unknown }).api = undefined
}

function q(sel: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(sel)
}

async function check(name: string, on = true): Promise<void> {
  const input = q(`[data-testid="lora-item-${name}"] input[type="checkbox"]`) as HTMLInputElement
  await act(async () => {
    if (input.checked !== on) input.click()
    await Promise.resolve()
  })
}

async function setScale(name: string, v: string): Promise<void> {
  const slider = q(`[data-testid="lora-scale-${name}"]`) as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(slider, v)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  unmount()
})

describe('LoraPicker — 扫描与选择', () => {
  it('scan 返回两个文件 → 列表渲染；勾选 → 默认 0.75 滑杆出现', async () => {
    const fake = makeFakeApi()
    await mount(fake)
    expect(fake.invoke).toHaveBeenCalledWith('models:loraScan', {})
    expect(q('[data-testid="lora-item-marblesh"]')).not.toBeNull()
    expect(q('[data-testid="lora-item-anime-flat"]')).not.toBeNull()
    expect(q('[data-testid="lora-scale-marblesh"]')).toBeNull()
    await check('marblesh')
    const slider = q('[data-testid="lora-scale-marblesh"]') as HTMLInputElement
    expect(slider.value).toBe('0.75')
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('1.5')
    expect(slider.step).toBe('0.05')
  })

  it('滑杆变更 → chips 与预览实时反映 `<lora:marblesh:0.85>`', async () => {
    await mount(makeFakeApi())
    await check('marblesh')
    await setScale('marblesh', '0.85')
    expect(q('[data-testid="lora-preview"]')!.textContent).toBe('<lora:marblesh:0.85> ')
    expect(q('[data-testid="lora-chips"]')!.textContent).toContain('<lora:marblesh:0.85>')
  })

  it('两个 LoRA 依次选择 → onChange 载荷精确（name+scale），预览含两标签', async () => {
    const seen = await mount(makeFakeApi())
    await check('marblesh')
    await setScale('marblesh', '1')
    await check('anime-flat')
    const last = seen[seen.length - 1]
    expect(last.map((s) => ({ name: s.file.name, scale: s.scale }))).toEqual([
      { name: 'marblesh', scale: 1 },
      { name: 'anime-flat', scale: 0.75 },
    ])
    expect(q('[data-testid="lora-preview"]')!.textContent).toBe('<lora:marblesh:1> <lora:anime-flat:0.75> ')
  })

  it('chip × 移除选择；取消勾选同步移除', async () => {
    const seen = await mount(makeFakeApi())
    await check('marblesh')
    const removeBtn = q('[data-testid="lora-chip-marblesh"] button')!
    await act(async () => {
      removeBtn.click()
      await Promise.resolve()
    })
    expect(seen[seen.length - 1]).toEqual([])
    await check('anime-flat')
    await check('anime-flat', false)
    expect(seen[seen.length - 1]).toEqual([])
    expect(q('[data-testid="lora-chips"]')).toBeNull()
  })
})

describe('LoraPicker — 元数据与降级', () => {
  it('勾选后拉 meta：成功显示 tags/dim；失败显示 unknown 但滑杆/选择仍可用（QA-fail）', async () => {
    await mount(makeFakeApi())
    await check('marblesh')
    await act(async () => {
      await Promise.resolve()
    })
    expect(q('[data-testid="lora-meta-marblesh"]')!.textContent).toContain('marbled, art')
    expect(q('[data-testid="lora-meta-marblesh"]')!.textContent).toContain('dim: 32')
    await check('anime-flat') // 该项 meta 走 metaFail 分支
    await act(async () => {
      await Promise.resolve()
    })
    const metaLine = q('[data-testid="lora-meta-anime-flat"]')!
    expect(metaLine.textContent).toContain('元数据未知')
    expect((q('[data-testid="lora-scale-anime-flat"]') as HTMLInputElement).disabled).toBe(false)
    expect(q('[data-testid="lora-chip-anime-flat"]')).not.toBeNull()
  })

  it('全部 meta 失败仍不影响提交选择', async () => {
    const seen = await mount(makeFakeApi({ metaFail: true }))
    await check('marblesh')
    await act(async () => {
      await Promise.resolve()
    })
    expect(q('[data-testid="lora-meta-marblesh"]')!.textContent).toContain('元数据未知')
    expect(seen[seen.length - 1].map((s) => s.file.name)).toEqual(['marblesh'])
  })

  it('scan 空 → 空态指引 diffusion/lora', async () => {
    await mount(makeFakeApi({ files: [] }))
    expect(q('[data-testid="lora-empty"]')!.textContent).toContain('diffusion/lora')
  })

  it('scan 抛错 → unavailable note（不阻塞生图表单）', async () => {
    await mount(makeFakeApi({ scanFail: true }))
    expect(q('[data-testid="lora-unavailable"]')).not.toBeNull()
    expect(q('[data-testid="lora-list"]')).toBeNull()
  })

  it('window.api 缺席 → 诚实降级 note，不崩', async () => {
    await mount(undefined)
    expect(q('[data-testid="lora-unavailable"]')!.textContent).toContain('window.api')
  })
})
