/**
 * chatHtml.ts — todo42 会话导出单文件 HTML（渲染层组装，纯函数零 IO）。
 *
 * 净化策略（deviation：项目未装 DOMPurify 且禁 pnpm add — todo15 的净化事实源
 * 本就是 react-markdown + rehype-sanitize(defaultSchema)）：
 *  1) markdown 一律走与在线聊天同一管线 —— raw HTML 不进 hast（无 rehype-raw），
 *     href/src 协议白名单由 defaultSchema 把关，onXSS 属性被剥离；
 *  2) renderToStaticMarkup 的 React 转义是第二道（文本/属性全量实体化）；
 *  3) 贴图 data-URL 重新过 todo21 的 IMAGE_DATA_URI 语法门（非法即整张丢弃），
 *     附件 <img> 由本模块自渲染（defaultSchema 不放行 data: src，不能指望
 *     markdown 通路）。
 * 产物为自包含单文件：内联 <style> + 内联 data-URL 图，无外链、无脚本 —
 * 离线双击即读（plan：不做分享上传）。
 */
import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

export type ExportMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: readonly string[]
  createdAt?: number
}

export type ExportChatInput = {
  title: string
  messages: readonly ExportMessage[]
}

const REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkBreaks]
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [[rehypeSanitize, defaultSchema]]

/** 与 src/main/ipc/schemas.ts IMAGE_DATA_URI_RE 同一语法门（4 raster mime ≤ 无字节校验仅语法）。 */
const EXPORT_IMAGE_DATA_URI_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/

export function isSafeExportImageDataUri(url: string): boolean {
  return EXPORT_IMAGE_DATA_URI_RE.test(url)
}

/** 导出视图的链接一律新窗口 + noopener（与 MarkdownMessage 的在线策略一致）。 */
const EXPORT_COMPONENTS: Components = {
  a: ({ href, children, ...rest }) =>
    h('a', { ...rest, href, target: '_blank', rel: 'noopener noreferrer' }, children),
}

/** 静态导出不做 shiki：fenced 代码保持 <pre><code class="language-x">（CSS 上色）。 */
function ExportMarkdown({ content }: { content: string }): React.JSX.Element {
  return h(
    ReactMarkdown,
    { remarkPlugins: REMARK_PLUGINS, rehypePlugins: REHYPE_PLUGINS, components: EXPORT_COMPONENTS },
    content,
  )
}

const EXPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px; background: #f5f5f4; color: #1c1917;
  font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
main { max-width: 820px; margin: 0 auto; }
header.las-export-head { max-width: 820px; margin: 0 auto 24px; }
header.las-export-head h1 { font-size: 22px; margin: 0 0 4px; word-break: break-all; }
header.las-export-head p { margin: 0; color: #78716c; font-size: 12px; }
.las-export-msg { background: #fff; border: 1px solid #e7e5e4; border-radius: 10px;
  padding: 14px 18px; margin-bottom: 14px; break-inside: avoid; }
.las-export-msg[data-role="user"] { border-left: 4px solid #0ea5e9; }
.las-export-msg[data-role="assistant"] { border-left: 4px solid #8b5cf6; }
.las-export-role { font-size: 11px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: #78716c; margin-bottom: 6px; }
.las-export-msg time { display: block; margin-top: 8px; font-size: 11px; color: #a8a29e; }
.las-export-images { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
.las-export-images img { max-width: 320px; max-height: 320px; border-radius: 8px; border: 1px solid #e7e5e4; }
pre { background: #0c0a09; color: #fafaf9; padding: 12px 14px; border-radius: 8px;
  overflow-x: auto; font-size: 13px; }
code { font-family: "Cascadia Code", Consolas, "JetBrains Mono", monospace; }
:not(pre) > code { background: #ede9e6; color: #b45309; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #d6d3d1; padding: 4px 10px; }
blockquote { margin: 8px 0; padding: 2px 14px; border-left: 3px solid #d6d3d1; color: #57534e; }
a { color: #0369a1; }
`.trim()

const ROLE_LABELS: Record<ExportMessage['role'], string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
}

function messageNode(m: ExportMessage, i: number): React.JSX.Element | null {
  const safeImages = (m.images ?? []).filter(isSafeExportImageDataUri)
  if (m.content.length === 0 && safeImages.length === 0) return null
  const children: ReactNode[] = [h('div', { className: 'las-export-role', key: 'r' }, ROLE_LABELS[m.role])]
  if (safeImages.length > 0) {
    children.push(
      h(
        'div',
        { className: 'las-export-images', key: 'imgs' },
        safeImages.map((src, j) => h('img', { key: `${i}:${j}`, src, alt: `附图 ${j + 1}` })),
      ),
    )
  }
  if (m.content.length > 0) {
    children.push(h(ExportMarkdown, { key: 'md', content: m.content }))
  }
  if (typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)) {
    children.push(h('time', { key: 't', dateTime: new Date(m.createdAt).toISOString() }, new Date(m.createdAt).toLocaleString('zh-CN')))
  }
  return h('section', { className: 'las-export-msg', 'data-role': m.role, key: `m${i}` }, ...children)
}

/** 组装自包含单文件导出 HTML（同步、无网络、无脚本）。 */
export function buildChatHtml(input: ExportChatInput): string {
  // 空消息（占位/被中止的空转）由 messageNode 自行渲染为 null — 计数按可见口径。
  const messages = input.messages
  const visibleCount = messages.filter(
    (m) => m.content.length > 0 || (m.images ?? []).some(isSafeExportImageDataUri),
  ).length
  const doc = h(
    'html',
    { lang: 'zh-CN' },
    h(
      'head',
      null,
      h('meta', { charSet: 'utf-8' }),
      h('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
      h('title', null, input.title || '会话导出'),
      h('style', { dangerouslySetInnerHTML: { __html: EXPORT_CSS } }),
    ),
    h(
      'body',
      null,
      h(
        'header',
        { className: 'las-export-head' },
        h('h1', null, input.title || '会话导出'),
        h('p', null, `共 ${visibleCount} 条消息 · 由 Local AI Suite 导出 · ${new Date().toLocaleString('zh-CN')}`),
      ),
      h('main', null, ...messages.map(messageNode)),
    ),
  )
  return `<!DOCTYPE html>\n${renderToStaticMarkup(doc)}`
}
