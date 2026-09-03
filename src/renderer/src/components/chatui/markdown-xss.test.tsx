// @vitest-environment jsdom
/**
 * markdown-xss.test.tsx — todo15 XSS 回归（plan QA：failure=XSS payload 净化后无脚本执行）
 * 管线：react-markdown 默认不渲染 raw HTML（无 rehype-raw）+ rehype-sanitize defaultSchema
 * 双保险。断言只针对 DOM 可观察事实：元素不存在 / 危险属性被剥 / payload 文本被转义。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MarkdownMessage from './MarkdownMessage'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(content: string): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<MarkdownMessage content={content} />)
  })
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('todo15 XSS 回归（raw html 不开启 + rehype-sanitize）', () => {
  it('<img onerror> payload 不产生 img 元素，属性不外泄', () => {
    render('hello\n\n<img src=x onerror=alert(1)>\n\nworld')
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).not.toContain('onerror')
    expect(container.textContent).toContain('hello')
  })

  it('<script> 注入不产生 script 元素', () => {
    render('before\n<script>alert(document.domain)</script>\nafter')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('before')
  })

  it('javascript: 链接 href 被 sanitize 剥除', () => {
    render('[click me](javascript:alert(1))')
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a?.getAttribute('href') ?? '').not.toContain('javascript:')
  })

  it('iframe/svg onload 等危险节点全部出局', () => {
    render('<iframe src="https://evil.example"></iframe>\n\n<svg onload="alert(1)"><circle /></svg>')
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('circle')).toBeNull()
  })

  it('代码围栏内的 HTML payload 按字面文本呈现（转义非执行）', () => {
    render('```html\n<img src=x onerror=alert(1)>\n```')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
