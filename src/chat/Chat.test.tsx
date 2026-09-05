// @vitest-environment jsdom
/**
 * Chat.test.tsx — todo21 composer 贴图流（jsdom + createRoot，模式同 ChatPage.test）
 * 覆盖：vision 探测（models:list projectorPath）→ attach 启用/禁用 + tooltip、
 * 文件选择 → 缩略图 → Send 的 chat:send 载荷含 image_url dataURI、>2 张截断。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { VISION_DISABLED_TOOLTIP } from './vision'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let Chat: typeof import('./Chat').Chat

type InvokeCall = [string, unknown]

function setFakeApi(models: unknown[]): { calls: InvokeCall[] } {
  const calls: InvokeCall[] = []
  const api = {
    invoke: vi.fn(async (channel: string, payload: unknown) => {
      calls.push([channel, payload])
      if (channel === 'models:list') return { models }
      if (channel === 'chat:send') return { ok: true, id: (payload as { id: string }).id, streaming: true }
      return { ok: true }
    }),
    on: vi.fn(() => () => undefined),
  }
  ;(window as unknown as { api: unknown }).api = api
  return { calls }
}

const vlModels = [{ name: 'qwen2.5-vl', format: 'gguf', file: 'llm/vl.gguf', path: '/models/llm/vl.gguf', projectorPath: '/models/llm/mmproj-vl.gguf' }]

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<Chat presets={[]} />)
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

beforeEach(async () => {
  vi.resetModules()
  const mod = await import('./Chat')
  Chat = mod.Chat
})

afterEach(() => {
  unmount()
  ;(window as unknown as { api: unknown }).api = undefined
  vi.restoreAllMocks()
})

function pngFile(name = 'a.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], name, { type: 'image/png' })
}

async function attachViaFileInput(files: File[], expectTotal = 1): Promise<void> {
  const input = container.querySelector('[data-testid="image-file-input"]') as HTMLInputElement
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    // FileReader.onload 的落点在负载高时不止一个 tick：轮询到缩略图数量到齐（上限 ~1s）
    for (let i = 0; i < 50; i += 1) {
      if (container.querySelectorAll('[data-testid="attach-strip"] img').length >= expectTotal) break
      await new Promise((r) => setTimeout(r, 20))
    }
  })
  expect(container.querySelectorAll('[data-testid="attach-strip"] img')).toHaveLength(expectTotal)
}

describe('Chat composer — todo21 vision attach', () => {
  it('注册表有配对投影的 gguf → attach 可用；选图后出现缩略图，Send 载荷含 image_url dataURI', async () => {
    const fake = setFakeApi(vlModels)
    await mount()

    const attachBtn = container.querySelector('[data-testid="attach-image-button"]') as HTMLButtonElement
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    }) // 等 vision 探测 resolve
    expect(attachBtn.disabled).toBe(false)
    expect(attachBtn.getAttribute('title')).not.toBe(VISION_DISABLED_TOOLTIP)

    await attachViaFileInput([pngFile()])
    const strip = container.querySelector('[data-testid="attach-strip"]')
    const thumbImg = strip?.querySelector('img')
    expect(thumbImg?.getAttribute('src')?.startsWith('data:image/png;base64,')).toBe(true)

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '看看这张图')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Send')!
    await act(async () => {
      sendBtn.click()
      await Promise.resolve()
    })

    const sendCall = fake.calls.find(([c]) => c === 'chat:send')
    expect(sendCall).toBeDefined()
    const payload = sendCall![1] as { messages: Array<{ role: string; content: unknown }> }
    expect(payload.messages.at(-1)!.content).toEqual([
      { type: 'text', text: '看看这张图' },
      { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ])
    // 发送后缩略图清空
    expect(container.querySelector('[data-testid="attach-strip"]')).toBeNull()
  })

  it('llama 模型无 projectorPath → attach 禁用 + tooltip「该模型无视觉投影文件」（QA-fail 场景）', async () => {
    setFakeApi([{ name: 'qwen3', format: 'gguf', file: 'llm/t.gguf', path: '/models/llm/t.gguf' }])
    await mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const attachBtn = container.querySelector('[data-testid="attach-image-button"]') as HTMLButtonElement
    expect(attachBtn.disabled).toBe(true)
    expect(attachBtn.getAttribute('title')).toBe(VISION_DISABLED_TOOLTIP)
  })

  it('最多 2 张：第三次选择被 cap 截断，缩略图不超 2', async () => {
    setFakeApi(vlModels)
    await mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await attachViaFileInput([pngFile('a.png'), pngFile('b.png')], 2)
    await attachViaFileInput([pngFile('c.png')], 2)
    expect(container.querySelectorAll('[data-testid="attach-strip"] img')).toHaveLength(2)
    // 满 2 张后 attach 按钮禁用
    const attachBtn = container.querySelector('[data-testid="attach-image-button"]') as HTMLButtonElement
    expect(attachBtn.disabled).toBe(true)
  })

  it('缩略图 × 可移除单张', async () => {
    setFakeApi(vlModels)
    await mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await attachViaFileInput([pngFile('a.png'), pngFile('b.png')], 2)
    expect(container.querySelectorAll('[data-testid="attach-strip"] img')).toHaveLength(2)
    const removeBtn = container.querySelector('[aria-label="remove-image-1"]') as HTMLButtonElement
    act(() => {
      removeBtn.click()
    })
    expect(container.querySelectorAll('[data-testid="attach-strip"] img')).toHaveLength(1)
  })
})
