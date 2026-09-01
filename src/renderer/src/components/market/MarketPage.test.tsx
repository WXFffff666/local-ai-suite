// @vitest-environment jsdom
/**
 * MarketPage.test.tsx — todo14 市场页组件测试
 * 约定沿用 App.test.tsx：per-file jsdom + react act + createRoot + fake window.api。
 * 覆盖：hf:search 结果渲染 / 下载发起→progress 事件序列→进度条→done /
 *       不定长（total=0）shimmer 类 / error 状态呈现消息 / ack 拒绝消息呈现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MarketPage from '../../pages/MarketPage'
import type { DownloadProgressEvent } from '../../../../main/ipc/whitelist'
import type { MarketModelCard } from './types'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

function setFakeApi(api: unknown): void {
  ;(window as unknown as { api: unknown }).api = api
}

const CARD: MarketModelCard = {
  repoId: 'Qwen/Qwen2.5-7B-Instruct-GGUF',
  name: 'Qwen2.5-7B-Instruct GGUF',
  author: 'Qwen',
  quant: 'Q4_K_M',
  filename: 'qwen2.5-7b-instruct-q4_k_m.gguf',
  sizeLabel: '4.7GB',
  gguf: true,
  description: 'Popular 7B instruct model, GGUF quantizations.',
  tags: ['gguf', 'qwen'],
  likes: 1234,
}

type FakeApi = {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  /** 触发已注册的 download:progress 监听（main→renderer 事件注入点） */
  emit: (e: DownloadProgressEvent) => void
}

function makeFakeApi(searchReply: unknown): FakeApi {
  const listeners: Array<(e: DownloadProgressEvent) => void> = []
  const api: FakeApi = {
    invoke: vi.fn(async (channel: string) => {
      if (channel === 'hf:search') return searchReply
      if (channel === 'models:download') {
        return { ok: true, id: 'dl-test-1', repoId: CARD.repoId, state: 'downloading' as const }
      }
      throw new Error(`unexpected channel: ${channel}`)
    }),
    on: vi.fn((_channel: string, cb: (e: DownloadProgressEvent) => void) => {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    }),
    emit: (e) => {
      for (const cb of listeners.slice()) cb(e)
    },
  }
  return api
}

let container: HTMLDivElement
let root: Root

/** invoke 是 async mock → 微任务链 + setState 提交，给一个宏任务 flush 窗口 */
function flush(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0))
}

async function mount(api: FakeApi): Promise<void> {
  setFakeApi(api)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const tree: ReactNode = <MarketPage />
  await act(async () => {
    root.render(tree)
    await flush() // 首屏 hf:search
  })
}

function unmount(): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

function downloadButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button.las-market-card-download')
  if (!btn) throw new Error('download button not found')
  return btn
}

function jobRow(): HTMLElement {
  const row = container.querySelector<HTMLElement>('.las-market-job')
  if (!row) throw new Error('job row not found')
  return row
}

beforeEach(() => {
  window.location.hash = ''
  setFakeApi(undefined)
})

afterEach(() => {
  unmount()
  setFakeApi(undefined)
  vi.restoreAllMocks()
})

describe('MarketPage 搜索', () => {
  it('首屏以默认筛选调用 hf:search 并渲染结果卡（name/author/quant/sizeLabel/likes/HF 链接）', async () => {
    const api = makeFakeApi({ ok: true, cards: [CARD] })
    await mount(api)

    expect(api.invoke).toHaveBeenCalledWith('hf:search', { ggufOnly: true })
    const card = container.querySelector<HTMLElement>(
      '[data-repo-id="Qwen/Qwen2.5-7B-Instruct-GGUF"]',
    )
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Qwen2.5-7B-Instruct GGUF')
    expect(card!.textContent).toContain('Qwen')
    expect(card!.textContent).toContain('Q4_K_M')
    expect(card!.textContent).toContain('4.7GB')
    expect(card!.textContent).toContain('1234')
    const link = card!.querySelector<HTMLAnchorElement>('a.las-market-card-link')
    expect(link?.getAttribute('href')).toBe('https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF')
  })

  it('提交搜索表单 → query 透传 hf:search（空量化省略键）', async () => {
    const api = makeFakeApi({ ok: true, cards: [] })
    await mount(api)
    api.invoke.mockClear()

    const input = container.querySelector<HTMLInputElement>('input[type="search"]')
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="量化筛选"]')
    expect(input).not.toBeNull()
    expect(select).not.toBeNull()
    await act(async () => {
      // 受控组件：走原生 value setter + input 事件，等价用户键入
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, 'deepseek')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container.querySelector<HTMLFormElement>('form[role="search"]')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('hf:search', { query: 'deepseek', ggufOnly: true })
    expect(container.textContent).toContain('没有符合条件的模型')
  })

  it('hf:search 返回校验拒绝 → 错误串诚实呈现', async () => {
    const api = makeFakeApi({
      ok: false,
      error: 'invalid-payload',
      issues: [{ path: 'limit', message: 'Too big: expected number to be <=100' }],
    })
    await mount(api)
    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('hf:search 被拒绝')
    expect(alert?.textContent).toContain('limit')
  })
})

describe('MarketPage 下载与进度', () => {
  it('点下载 → models:download{repoId,filename}；progress 序列驱动进度条：不定长→百分比→done', async () => {
    const api = makeFakeApi({ ok: true, cards: [CARD] })
    await mount(api)

    await act(async () => {
      downloadButton().click()
      await flush()
    })
    expect(api.invoke).toHaveBeenCalledWith('models:download', {
      repoId: CARD.repoId,
      filename: CARD.filename,
    })

    // 事件序列（downloadManager 契约：初始 downloading received=0 total=0，轮询推进，终态 done）
    await act(async () => {
      api.emit({
        id: 'dl-test-1',
        repoId: CARD.repoId,
        received: 0,
        total: 0,
        state: 'downloading',
      })
    })
    let row = jobRow()
    let bar = row.querySelector<HTMLElement>('.las-market-job-bar')!
    expect(bar.className).toContain('las-market-job-bar-indeterminate') // total=0 → shimmer
    expect(row.textContent).toContain('总大小未知')

    await act(async () => {
      api.emit({
        id: 'dl-test-1',
        repoId: CARD.repoId,
        received: 2576980377,
        total: 5033164220,
        state: 'downloading',
      })
    })
    row = jobRow()
    bar = row.querySelector<HTMLElement>('.las-market-job-bar')!
    expect(bar.className).not.toContain('las-market-job-bar-indeterminate')
    const fill = bar.querySelector<HTMLElement>('.las-market-job-bar-fill')!
    expect(fill.style.width).toBe('51%')
    expect(row.textContent).toContain('2.4 GB / 4.7 GB')

    await act(async () => {
      api.emit({
        id: 'dl-test-1',
        repoId: CARD.repoId,
        received: 5033164220,
        total: 5033164220,
        state: 'done',
      })
    })
    row = jobRow()
    expect(row.getAttribute('data-state')).toBe('done')
    expect(row.textContent).toContain('完成')
    expect(row.textContent).toContain('已接收 4.7 GB')
    // 完成后卡片按钮恢复可用（不再 active）
    expect(downloadButton().disabled).toBe(false)
  })

  it('error 事件 → 任务行呈现错误消息', async () => {
    const api = makeFakeApi({ ok: true, cards: [CARD] })
    await mount(api)
    await act(async () => {
      downloadButton().click()
      await flush()
    })
    await act(async () => {
      api.emit({
        id: 'dl-test-1',
        repoId: CARD.repoId,
        received: 0,
        total: 0,
        state: 'error',
        error: 'huggingface-cli exited with code 1',
      })
    })
    const row = jobRow()
    expect(row.getAttribute('data-state')).toBe('error')
    expect(row.querySelector<HTMLElement>('.las-market-job-error')?.textContent).toContain(
      'huggingface-cli exited with code 1',
    )
  })

  it('models:download 校验拒绝 → 页面级错误条呈现且不建任务行', async () => {
    const api = makeFakeApi({ ok: true, cards: [CARD] })
    api.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'hf:search') return { ok: true, cards: [CARD] }
      return {
        ok: false,
        error: 'invalid-payload',
        issues: [{ path: 'repoId', message: 'Invalid repoId format' }],
      }
    })
    await mount(api)
    await act(async () => {
      downloadButton().click()
      await flush()
    })
    const alerts = container.querySelectorAll<HTMLElement>('[role="alert"]')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].textContent).toContain('models:download 被拒绝')
    expect(container.querySelector('.las-market-job')).toBeNull()
  })

  it('取消按钮存在但 disabled（后端 download:cancel 通道缺失 — todo14 偏差记录）', async () => {
    const api = makeFakeApi({ ok: true, cards: [CARD] })
    await mount(api)
    await act(async () => {
      downloadButton().click()
      await flush()
    })
    await act(async () => {
      api.emit({
        id: 'dl-test-1',
        repoId: CARD.repoId,
        received: 0,
        total: 0,
        state: 'downloading',
      })
    })
    const cancel = jobRow().querySelector<HTMLButtonElement>(
      'button.las-market-job-cancel',
    )!
    expect(cancel.disabled).toBe(true)
    expect(cancel.title).toContain('download:cancel')
  })
})
