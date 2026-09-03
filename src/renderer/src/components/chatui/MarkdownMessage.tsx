/**
 * MarkdownMessage.tsx — todo15 消息 markdown 渲染管线
 * react-markdown@10 + remark-gfm（表格/删除线/任务清单）+ remark-breaks（单换行→<br>）
 * + rehype-sanitize（defaultSchema 保守净化：拦 javascript:/onXSS 属性/任意 raw HTML）。
 * 未挂 rehype-raw —— 模型输出里的原生 HTML 根本不进入 hast，净化层是纵深第二道。
 * 围栏代码 → CodeBlock（shiki + 复制按钮）；流式期间 streaming=true → 不高亮不闪烁。
 * memo(按 content+streaming)：500 条长会话里只有增量中的最后一条重新解析。
 */
import { isValidElement, memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { CodeBlock } from './CodeBlock'

const REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [remarkGfm, remarkBreaks]
const REHYPE_PLUGINS: NonNullable<Options['rehypePlugins']> = [[rehypeSanitize, defaultSchema]]

/** 收集 <pre> 内 <code> 的 info-string 与纯文本内容 */
function fencedFromPreChildren(children: ReactNode): { lang?: string; code: string } | null {
  const list = Array.isArray(children) ? children : [children]
  const codeEl = list.find((c): c is React.ReactElement<{ className?: string; children?: ReactNode }> =>
    isValidElement<{ className?: string }>(c) && (c as { type: unknown }).type === 'code',
  )
  if (!codeEl) return null
  const match = /language-([\w+.#-]+)/.exec(codeEl.props.className ?? '')
  return {
    lang: match?.[1],
    code: nodeText(codeEl.props.children).replace(/\n$/, ''),
  }
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

function makeComponents(highlight: boolean): Components {
  return {
    pre: ({ children }) => {
      const fenced = fencedFromPreChildren(children)
      if (!fenced) return <pre>{children}</pre>
      return <CodeBlock code={fenced.code} lang={fenced.lang} highlight={highlight} />
    },
    a: ({ href, children, ...rest }) => (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  }
}

export type MarkdownMessageProps = {
  content: string
  /** 流式中：代码块跳过 shiki（完成后一次性高亮） */
  streaming?: boolean
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  streaming = false,
}: MarkdownMessageProps): React.JSX.Element | null {
  const components = useMemo(() => makeComponents(!streaming), [streaming])
  if (!content) return null
  return (
    <div className="las-md" data-streaming={streaming ? 'true' : undefined}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})

export default MarkdownMessage
