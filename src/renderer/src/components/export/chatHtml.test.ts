// @vitest-environment jsdom
/**
 * chatHtml.test.ts — todo42 导出 HTML 字符串金样 + 净化断言。
 * 金样口径（plan acceptance）：两条消息（用户带 fenced 代码、助手带 data-URL
 * 附图）→ 产物无 <script、无 javascript:、样式与图片全部内联、结构可读。
 */
import { describe, expect, it } from 'vitest'
import { buildChatHtml, isSafeExportImageDataUri } from './chatHtml'

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const TWO_MSG = {
  title: '会话: 导出 <测试>',
  messages: [
    {
      role: 'user' as const,
      content: '帮我看这段:\n\n```ts\nconst x: number = 41 + 1\n```',
      createdAt: 1700000000000,
    },
    {
      role: 'assistant' as const,
      content: '结果 42。[文档](https://example.com/doc) | 坏链 [x](javascript:alert(1))',
      images: [PNG_1PX],
      createdAt: 1700000060000,
    },
  ],
}

describe('buildChatHtml golden (todo42)', () => {
  const html = buildChatHtml(TWO_MSG)

  it('单文件自包含：doctype + lang + 内联 style + 内联 data-URL 图，零外链资源', () => {
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="zh-CN">')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('las-export-msg')
    expect(html).toContain(`src="${PNG_1PX}"`)
    // 无 <link>/远程 <script src> — 离线双击即读
    expect(html).not.toContain('<link')
    expect(html).not.toMatch(/<script\b/i)
  })

  it('markdown 管线保持：fenced 代码静态化 + 表格插件在位', () => {
    expect(html).toContain('<pre>')
    expect(html).toContain('language-ts')
    expect(html).toContain('const x: number = 41 + 1')
  })

  it('净化断言：javascript: href 被剥离，合法外链带 noopener', () => {
    expect(html).not.toContain('javascript:')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('href="https://example.com/doc"')
  })

  it('标题 HTML 实体化（React 转义第二道），角色/时间线结构在位', () => {
    expect(html).toContain('&lt;测试&gt;')
    expect(html).not.toContain('<h1>会话: 导出 <测试>')
    expect(html).toContain('data-role="user"')
    expect(html).toContain('data-role="assistant"')
    expect(html).toContain('<time')
  })

  it('空消息与非法 data-URL 图不渲染（svg/远程/http data:text/html 全拒）', () => {
    const dirty = buildChatHtml({
      title: 't',
      messages: [
        { role: 'user', content: '' },
        {
          role: 'assistant',
          content: 'ok',
          images: ['data:image/svg+xml;base64,PHN2Zz4=', 'https://evil/x.png', 'data:text/html;base64,xx', PNG_1PX],
        },
      ],
    })
    expect(dirty).not.toContain('svg')
    expect(dirty).not.toContain('evil')
    expect(dirty).toContain(`src="${PNG_1PX}"`)
    expect(isSafeExportImageDataUri(PNG_1PX)).toBe(true)
    expect(isSafeExportImageDataUri('data:image/svg+xml,%3Csvg%3E')).toBe(false)
  })

  it('raw HTML 注入不进标签（无 rehype-raw：raw 节点被整条丢弃）', () => {
    const evil = buildChatHtml({
      title: 'x',
      messages: [{ role: 'assistant', content: '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>' }],
    })
    expect(evil).not.toMatch(/<script\b/i)
    expect(evil).not.toContain('onerror')
    expect(evil).not.toContain('alert(')
  })
})
