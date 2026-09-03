// @vitest-environment jsdom
/**
 * MarkdownMessage.test.tsx — todo15 markdown fixture 渲染
 * 覆盖：GFM 表格/删除线、remark-breaks 单换行→<br>、内联代码、
 * 围栏代码块 → CodeBlock（语言徽标 + 复制按钮 + 高亮 HTML 注入路径）。
 * shiki 在本文件被 mock（异步高亮的注入逻辑），真实 shiki 见 CodeBlock.test.tsx。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MarkdownMessage from './MarkdownMessage'

vi.mock('./shiki-highlighter', () => ({
  highlightToHtml: vi.fn(async (code: string, info: string | undefined) =>
    info && /ts|typescript/.test(info)
      ? `<pre class="shiki"><code>[[H:${code.trim()}]]</code></pre>`
      : null,
  ),
}))

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function flush(): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 0))
}

function render(content: string, streaming = false): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MarkdownMessage content={content} streaming={streaming} />)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('GFM + breaks', () => {
  it('管道表格渲染为 <table> 含表头单元格', () => {
    render('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(container.querySelector('table')).not.toBeNull()
    expect(container.querySelectorAll('th').length).toBe(2)
    expect(container.querySelectorAll('td').length).toBe(2)
  })

  it('~~删除线~~ 渲染 <del>，任务清单渲染 checkbox input', () => {
    render('~~gone~~\n\n- [x] done item')
    expect(container.querySelector('del')?.textContent).toBe('gone')
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()
  })

  it('单换行 → <br>（remark-breaks）', () => {
    render('line one\nline two')
    expect(container.querySelector('br')).not.toBeNull()
    expect(container.textContent).toContain('line one')
  })

  it('内联代码保留 <code>，不误入 CodeBlock', () => {
    render('use `pnpm test` here')
    expect(container.querySelector('code')?.textContent).toBe('pnpm test')
    expect(container.querySelector('.las-codeblock')).toBeNull()
  })
})

describe('围栏代码块（fixture 含代码块与复制按钮 — 验收标准）', () => {
  const TS_FENCE = '```ts\nconst x: number = 1\n```'

  it('渲染语言徽标 + 复制按钮，先出纯文本 <pre> 后异步换入高亮 HTML', async () => {
    render(TS_FENCE)
    const block = container.querySelector('.las-codeblock')
    expect(block).not.toBeNull()
    expect(block?.getAttribute('data-lang')).toBe('ts')
    const copyBtn = block?.querySelector<HTMLButtonElement>('button[aria-label="copy to clipboard"]')
    expect(copyBtn).not.toBeNull()
    expect(block?.textContent).toContain('const x: number = 1')
    await act(async () => {
      await flush()
    })
    expect(container.querySelector('.las-codeblock-body pre.shiki')).not.toBeNull()
    expect(container.textContent).toContain('[[H:const x: number = 1]]')
  })

  it('未知语言保持纯文本降级，不抛错', async () => {
    render('```notalanguage\nfoo bar\n```')
    await act(async () => {
      await flush()
    })
    expect(container.querySelector('.las-codeblock-plain code')?.textContent).toBe('foo bar')
    expect(container.querySelector('.las-codeblock-body')).toBeNull()
  })

  it('streaming=true 期间完全不调用 highlightToHtml（防闪烁契约）', async () => {
    render(TS_FENCE, true)
    await act(async () => {
      await flush()
    })
    const { highlightToHtml } = await import('./shiki-highlighter')
    expect(highlightToHtml).not.toHaveBeenCalled()
    expect(container.querySelector('.las-codeblock-plain')).not.toBeNull()
  })
})
