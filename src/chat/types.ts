/**
 * types.ts — chat 领域数据形状（todo11 拆分自 store.ts）
 * plan Must-NOT：不改 store 数据形状 —— ChatMessage.reasoning 是
 * Thinking / reasoning_content 透传兼容契约的载体，事件流由 IPC 到达后
 * 仍以这些形状渲染（见 Chat.tsx / Thinking.tsx）。
 */
export type Role = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: Role
  content: string
  reasoning?: string
  createdAt: number
  pending?: boolean
  error?: string
}

export type ChatSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

// ---------------------------------------------------------------------------
// Factories (data-shape owners live here; store consumes them)
// ---------------------------------------------------------------------------
export function genId(prefix = 'm'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newSession(title?: string): ChatSession {
  const now = Date.now()
  return {
    id: genId('s'),
    title: title?.trim() || 'New Chat',
    createdAt: now,
    updatedAt: now,
    messages: [],
  }
}

export function newAssistantPlaceholder(): ChatMessage {
  return {
    id: genId('a'),
    role: 'assistant',
    content: '',
    reasoning: '',
    createdAt: Date.now(),
    pending: true,
  }
}

/** Per-send sampling overrides forwarded verbatim to chat:send (undefined fields are omitted). */
export type ChatSendOptions = {
  model?: string
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
}
