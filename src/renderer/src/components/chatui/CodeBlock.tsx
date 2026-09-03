/**
 * CodeBlock.tsx — todo15 代码块：shiki 高亮 + 复制按钮 + 流式降级
 * 流式期间 highlight=false：纯 <pre> 直出（零重高亮，防闪烁）；
 * 完成后异步 highlightToHtml() → 命中则注入 shiki HTML（自身已做实体转义），
 * 失败/未知语言 → 保持纯文本。语言缓存于 shiki-highlighter 单例。
 */
import { memo, useEffect, useState } from 'react'
import { highlightToHtml } from './shiki-highlighter'
import { CopyButton } from './CopyButton'

export type CodeBlockProps = {
  code: string
  /** markdown fence info-string（可为别名或未知 → 降级纯文本） */
  lang?: string
  /** false = 流式中：跳过 shiki，纯文本渲染 */
  highlight: boolean
}

export const CodeBlock = memo(function CodeBlock({ code, lang, highlight }: CodeBlockProps): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!highlight) {
      setHtml(null)
      return
    }
    let alive = true
    void highlightToHtml(code, lang).then((next) => {
      if (alive) setHtml(next)
    })
    return () => {
      alive = false
    }
  }, [code, lang, highlight])

  return (
    <div className="las-codeblock" data-lang={lang ?? 'text'} data-streaming={highlight ? undefined : 'true'}>
      <div className="las-codeblock-head">
        <span className="las-codeblock-lang">{lang ?? 'text'}</span>
        <CopyButton text={code} />
      </div>
      {html !== null ? (
        <div className="las-codeblock-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="las-codeblock-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})

export default CodeBlock
