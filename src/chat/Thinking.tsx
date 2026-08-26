/**
 * Thinking.tsx — Wave4 T15
 * 推理模型思考区折叠流式渲染 + thinking 通道 + reasoning_effort 透传
 * - 折叠: 受控/非受控 collapsed + defaultCollapsed + onCollapsedChange
 * - 流式: isStreaming 时增量渲染 content + 闪烁光标 + aria-live
 * - thinking 通道: reasoning / reasoning_content 统一透传
 * - reasoning_effort 透传: 归一化、白名单透传到请求体，不污染其它字段
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'

// ---------------------------------------------------------------------------
// reasoning_effort 透传
// ---------------------------------------------------------------------------
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'minimal' | 'none' | (string & {})

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'minimal',
  'none',
] as const

const ALLOWED_SET = new Set<string>(REASONING_EFFORT_VALUES as unknown as string[])

/**
 * 归一化 reasoning_effort：trim + 小写，空值返回 undefined，白名单外原样透传（兼容自定义强度）
 */
export function normalizeReasoningEffort(v: unknown): ReasoningEffort | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  const lower = s.toLowerCase()
  // 白名单内归一为小写，白名单外保留原始（去空格后）透传，便于兼容服务端自定义值
  if (ALLOWED_SET.has(lower)) return lower as ReasoningEffort
  return s as ReasoningEffort
}

/**
 * 透传 reasoning_effort 到请求体：不改原对象，undefined/空串则不写入
 * 兼容 OpenAI 风格：payload.reasoning_effort
 */
export function withReasoningEffort<
  T extends Record<string, unknown>,
>(payload: T, effort: unknown): T & { reasoning_effort?: ReasoningEffort } {
  const n = normalizeReasoningEffort(effort)
  if (n == null) {
    // 显式移除透传字段，避免旧值残留
    const { reasoning_effort: _omit, ...rest } = payload as Record<string, unknown>
    return rest as T & { reasoning_effort?: ReasoningEffort }
  }
  return { ...(payload as object), reasoning_effort: n } as T & { reasoning_effort: ReasoningEffort }
}

/**
 * 构建携带 thinking 通道 + reasoning_effort 的 chat completions 请求体
 * 透传字段仅 reasoning_effort，不注入其它副作用字段
 */
export function buildThinkingRequest(
  base: Record<string, unknown>,
  opts: { reasoningEffort?: unknown; includeReasoning?: boolean } = {},
): Record<string, unknown> {
  let out: Record<string, unknown> = { ...base }
  out = withReasoningEffort(out, opts.reasoningEffort)
  // 可选：标记需要 thinking 通道（不同后端字段不同，这里透传为透传，不强制改写 model 行为）
  if (opts.includeReasoning === false) {
    // 不需要时不追加任何 reasoning 字段，保持透传纯净
  }
  return out
}

// ---------------------------------------------------------------------------
// 纯函数：供测试与组件复用，避免 hooks 只能在组件内调用
// ---------------------------------------------------------------------------
export function getDisplayCollapsed(opts: { isStreaming: boolean; collapsed: boolean }): boolean {
  return opts.isStreaming ? false : opts.collapsed
}

export function shouldHideThinking(opts: {
  content: string
  isStreaming: boolean
  hideWhenEmpty: boolean
}): boolean {
  const empty = !opts.content || !opts.content.trim()
  return Boolean(opts.hideWhenEmpty && empty && !opts.isStreaming)
}

export function resolveInitialCollapsed(opts: {
  isStreaming: boolean
  defaultCollapsed?: boolean
}): boolean {
  if (opts.defaultCollapsed !== undefined) return opts.defaultCollapsed
  if (opts.isStreaming) return false
  return false
}

// ---------------------------------------------------------------------------
// Thinking 折叠流式组件
// ---------------------------------------------------------------------------
export interface ThinkingProps {
  /** 思考区内容（流式增量由父组件通过 content 递增传入） */
  content: string
  /** 是否正在流式输出 */
  isStreaming?: boolean
  /** 推理强度，原样透传到请求（同时以 data-reasoning-effort 暴露） */
  reasoningEffort?: ReasoningEffort
  /** 非受控初始折叠态，默认：有内容时展开，流式时强制展开 */
  defaultCollapsed?: boolean
  /** 受控折叠态 */
  collapsed?: boolean
  /** 折叠态变化回调（受控/非受控均触发） */
  onCollapsedChange?: (collapsed: boolean) => void
  /** 标题 */
  title?: string
  className?: string
  /** 流式光标字符，默认 ▍ */
  cursorChar?: string
  /** 为空时是否隐藏整个区块，默认 false（显示空态） */
  hideWhenEmpty?: boolean
}

export function Thinking({
  content,
  isStreaming = false,
  reasoningEffort,
  defaultCollapsed,
  collapsed: collapsedProp,
  onCollapsedChange,
  title = '思考过程',
  className,
  cursorChar = '▍',
  hideWhenEmpty = false,
}: ThinkingProps): React.JSX.Element | null {
  const normalizedEffort = useMemo(() => normalizeReasoningEffort(reasoningEffort), [reasoningEffort])

  const isControlled = collapsedProp !== undefined

  // 默认策略：流式中默认展开；否则按 defaultCollapsed，否则有内容展开/空内容折叠
  const initialCollapsed = useMemo(
    () => resolveInitialCollapsed({ isStreaming, defaultCollapsed }),
    [defaultCollapsed, isStreaming],
  )

  const [innerCollapsed, setInnerCollapsed] = useState<boolean>(initialCollapsed)

  // defaultCollapsed / 流式变化时同步非受控状态（流式开始自动展开）
  useEffect(() => {
    if (!isControlled && isStreaming) setInnerCollapsed(false)
  }, [isStreaming, isControlled])

  const collapsed = isControlled ? (collapsedProp as boolean) : innerCollapsed

  const toggle = useCallback(() => {
    const next = !collapsed
    if (!isControlled) setInnerCollapsed(next)
    onCollapsedChange?.(next)
  }, [collapsed, isControlled, onCollapsedChange])

  const empty = !content || !content.trim()
  if (hideWhenEmpty && empty && !isStreaming) return null

  const displayCollapsed = isStreaming ? false : collapsed

  return (
    <div
      className={className}
      data-testid="thinking-root"
      data-reasoning-effort={normalizedEffort ?? undefined}
      data-streaming={isStreaming ? 'true' : 'false'}
      data-collapsed={displayCollapsed ? 'true' : 'false'}
      style={{
        border: '1px solid #2a2a2a',
        borderRadius: 8,
        background: '#141414',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!displayCollapsed}
        aria-controls="thinking-content"
        data-testid="thinking-toggle"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 10px',
          background: '#1a1a1a',
          border: 'none',
          borderBottom: displayCollapsed ? 'none' : '1px solid #2a2a2a',
          color: '#b8c0cc',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              transform: displayCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 120ms ease',
              fontSize: 10,
            }}
          >
            ▼
          </span>
          <span>{title}</span>
          {normalizedEffort ? (
            <span
              data-testid="thinking-effort-badge"
              style={{
                fontSize: 10,
                fontWeight: 400,
                color: '#8aa0b8',
                background: '#0f1e2a',
                border: '1px solid #1e3a5a',
                padding: '1px 6px',
                borderRadius: 999,
              }}
            >
              {normalizedEffort}
            </span>
          ) : null}
          {isStreaming ? (
            <span style={{ fontSize: 10, color: '#6aa6ff', fontWeight: 400 }}>· 思考中…</span>
          ) : null}
        </span>
        <span style={{ fontSize: 11, color: '#888', fontWeight: 400 }}>
          {displayCollapsed ? '展开' : '折叠'}
        </span>
      </button>

      {!displayCollapsed ? (
        <div
          id="thinking-content"
          data-testid="thinking-content"
          aria-live={isStreaming ? 'polite' : undefined}
          aria-busy={isStreaming ? true : undefined}
          style={{
            padding: '10px 12px',
            color: '#9ab',
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 280,
            overflowY: 'auto',
            borderLeft: '2px solid #334',
            margin: '8px 10px 10px',
            background: '#0f0f0f',
            borderRadius: 6,
          }}
        >
          {empty && !isStreaming ? (
            <span style={{ color: '#666' }}>暂无思考内容</span>
          ) : (
            <>
              <span>{content}</span>
              {isStreaming ? (
                <span
                  data-testid="thinking-cursor"
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    marginLeft: 2,
                    color: '#6aa6ff',
                    animation: 'thinking-blink 1s step-end infinite',
                  }}
                >
                  {cursorChar}
                </span>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* 内联关键帧，避免额外 CSS 文件 */}
      <style>{`@keyframes thinking-blink{50%{opacity:0}}`}</style>
    </div>
  )
}

export default Thinking
