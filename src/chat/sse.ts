/**
 * sse.ts — legacy 兼容的纯 SSE 行解析（todo11 拆分自 store.ts）
 * 渲染层流式已改走主进程 relay 的 chat:delta 字符串事件；本文件保留
 * delta.content / reasoning_content 透传解析，作为 store 数据形状
 * （ChatMessage.reasoning）兼容契约的单一实现，供测试与后续复用。
 */
export type SseDelta = {
  content?: string
  reasoning?: string
  done?: boolean
  stop?: boolean
  raw?: unknown
}

/**
 * Parse single SSE line `data: {...}` or `data: [DONE]`.
 * Extracts delta.content + delta.reasoning_content (or delta.reasoning) for 透传.
 * Returns null for non-data / empty / [DONE] / unparsable.
 */
export function parseSseLine(line: string): SseDelta | null {
  const t = line.trim()
  if (!t) return null
  if (!t.startsWith('data:')) return null
  const data = t.slice(5).trim()
  if (!data || data === '[DONE]') return { done: true }
  try {
    const obj = JSON.parse(data) as Record<string, unknown>
    // stop sentinel without content
    if (obj['stop'] === true) return { stop: true, done: true, raw: obj }
    // OpenAI chat.completion.chunk: choices[0].delta.content / reasoning_content / finish_reason
    const choices = obj['choices'] as Array<Record<string, unknown>> | undefined
    if (Array.isArray(choices) && choices[0]) {
      const ch = choices[0] as Record<string, unknown>
      if (ch['finish_reason']) return { done: true, raw: obj }
      const delta = (ch['delta'] ?? ch['message']) as Record<string, unknown> | undefined
      if (delta) {
        const c = typeof delta['content'] === 'string' ? (delta['content'] as string) : undefined
        const r =
          typeof delta['reasoning_content'] === 'string'
            ? (delta['reasoning_content'] as string)
            : typeof delta['reasoning'] === 'string'
              ? (delta['reasoning'] as string)
              : undefined
        if (c !== undefined || r !== undefined) return { content: c, reasoning: r, raw: obj }
        if (delta['stop'] === true) return { done: true, raw: obj }
      }
      // Some providers put content at choices[0].text
      if (typeof ch['text'] === 'string') return { content: ch['text'] as string, raw: obj }
      return null
    }
    // llama.cpp style: {content, stop} or {delta:{content}}
    if (typeof obj['content'] === 'string') {
      return { content: obj['content'] as string, done: Boolean(obj['stop']), raw: obj }
    }
    const delta = obj['delta'] as Record<string, unknown> | undefined
    if (delta && typeof delta['content'] === 'string') {
      const r =
        typeof delta['reasoning_content'] === 'string'
          ? (delta['reasoning_content'] as string)
          : typeof delta['reasoning'] === 'string'
            ? (delta['reasoning'] as string)
            : typeof obj['reasoning_content'] === 'string'
              ? (obj['reasoning_content'] as string)
              : undefined
      return { content: delta['content'] as string, reasoning: r, done: Boolean(obj['stop'] ?? delta['stop']), raw: obj }
    }
    // direct reasoning_content at top level
    if (typeof obj['reasoning_content'] === 'string' || typeof obj['reasoning'] === 'string') {
      return {
        reasoning: (obj['reasoning_content'] as string) ?? (obj['reasoning'] as string),
        raw: obj,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Split buffered SSE text into lines and parse deltas.
 */
export function parseSseBuffer(buf: string): { deltas: SseDelta[]; remainder: string } {
  const parts = buf.split('\n')
  const remainder = parts.pop() ?? ''
  const deltas: SseDelta[] = []
  for (const line of parts) {
    const d = parseSseLine(line)
    if (d) deltas.push(d)
  }
  return { deltas, remainder }
}
