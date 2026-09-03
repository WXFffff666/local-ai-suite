// @vitest-environment jsdom
/**
 * CodeBlock.test.tsx — todo15 真实 shiki 集成（离线 JS engine 路径）
 * 不 mock：证实 @shikijs/langs + github-dark + createJavaScriptRegexEngine
 * 在无 wasm / 无网络下产出 token 化 HTML；并锁定「代码文本被转义非执行」。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CodeBlock from './CodeBlock'
import { __resetHighlighterForTests } from './shiki-highlighter'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

/** 语法加载 + 着色为全异步链（dynamic import ×3 + grammar parse）。
 *  全量套件并发下耗时不定 → 轮询等目标 DOM 出现（25ms×80 上限），禁止裸 sleep 竞速。 */
async function waitUntil(poll: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !poll(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

function mount(code: string, lang: string | undefined, highlight: boolean): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<CodeBlock code={code} lang={lang} highlight={highlight} />)
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  __resetHighlighterForTests()
})

describe('shiki 高亮（真实引擎）', () => {
  it('typescript 代码 → 异步换入 .shiki <pre>，token 带内联颜色，复制按钮在位', async () => {
    mount('const x: number = 41 + 1', 'ts', true)
    expect(container.querySelector('.las-codeblock-plain')).not.toBeNull()
    await waitUntil(() => container.querySelector('.las-codeblock-body pre.shiki') !== null)
    const shikiPre = container.querySelector('.las-codeblock-body pre.shiki')
    expect(shikiPre).not.toBeNull()
    const spans = shikiPre!.querySelectorAll('span[style]')
    expect(spans.length).toBeGreaterThan(2)
    expect(container.textContent).toContain('41 + 1')
    expect(container.querySelector('button[aria-label="copy to clipboard"]')).not.toBeNull()
  })

  it('代码体内的 HTML payload 高亮后仍是转义文本（无 img 元素）', async () => {
    mount('const s = "<img src=x onerror=alert(1)>"', 'typescript', true)
    await waitUntil(() => container.querySelector('.las-codeblock-body') !== null)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('highlight=false（流式中）：保持纯文本，不触达高亮层', async () => {
    mount('partial code', 'ts', false)
    // 无异步高亮链可等 → 给足宏任务窗口后断言「始终没有」高亮层
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(container.querySelector('.las-codeblock-plain code')?.textContent).toBe('partial code')
    expect(container.querySelector('.las-codeblock-body')).toBeNull()
    expect(container.querySelector('.las-codeblock')?.getAttribute('data-streaming')).toBe('true')
  })
})
