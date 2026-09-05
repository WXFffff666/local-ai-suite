/**
 * types.ts — chat 领域数据形状（todo11 拆分自 store.ts）
 * plan Must-NOT：不改 store 数据形状 —— ChatMessage.reasoning 是
 * Thinking / reasoning_content 透传兼容契约的载体，事件流由 IPC 到达后
 * 仍以这些形状渲染（见 Chat.tsx / Thinking.tsx）。
 */
import type { RagCitation } from '../main/ipc/whitelist'

export type Role = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: Role
  content: string
  reasoning?: string
  createdAt: number
  pending?: boolean
  error?: string
  /**
   * todo21 (ADDITIVE — frozen-shape rule relaxed by the plan's VLM lane):
   * base64 data-URLs attached to this message. Only the four raster mimes
   * the zod gate accepts ever land here; renderers must refuse anything else.
   */
  images?: string[]
  /**
   * todo39 (ADDITIVE — RAG v1 lane): [n] citation cards for a knowledge-base
   * grounded turn, carried on the USER message that triggered retrieval.
   * Optional; when absent the bubble renders byte-identical to pre-39
   * (pinned by Chat.characterization.test). Never persisted to chat.db
   * (ephemeral session view; the sidebar only stores role/content).
   */
  citations?: RagCitation[]
  /**
   * todo39 (ADDITIVE): retrieved-knowledge preamble injected into the WIRE
   * content of this user turn (toWireContent), never displayed or persisted.
   */
  ragContext?: string
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
  /**
   * 阶段1：画图工具开关 — true 时本轮注入 [[IMG:…]] 标记 system 提示，
   * done 后 store 解析标记自动走本地生图并把图片回填会话。
   */
  imageTool?: boolean
}
