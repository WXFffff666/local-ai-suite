/**
 * ipc.ts — chat 的渲染层 IPC 契约面（todo11 拆分自 store.ts）
 * 单一职责：描述 window.api 上 chat:send / chat:abort + 事件的最小结构视图，
 * 以及非 Electron 环境（vitest node、纯浏览器）下的可用性守卫。
 * 载荷/事件类型本体来自 src/main/ipc/whitelist.ts（EventPayloads 契约）。
 */
import type { ChatContentPart, ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent, ChatMessageContent } from '../main/ipc/whitelist'
import type { ChatMessage, Role } from './types'

export type ChatSendPayload = {
  id: string
  model: string
  /** todo21: plain string or OpenAI-compatible text/image_url parts (data-URL only). */
  messages: Array<{ role: Role; content: ChatMessageContent }>
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
}

/**
 * todo21: project a stored message onto the wire content shape.
 * Messages without images keep the byte-identical plain-string form;
 * images become trailing image_url parts, text (when present) a leading
 * text part. Attacker-supplied remote URLs cannot occur: ChatMessage.images
 * is only ever fed by the composer's local data-URL intake.
 * todo39 (ADDITIVE): a knowledge-grounded user turn carries `ragContext` —
 * the retrieved-chunk preamble goes to the MODEL only (display and chat.db
 * keep the raw `content`). Without ragContext every projection is
 * byte-identical to pre-39 (Chat.characterization + store suites pin it).
 */
export function toWireContent(m: ChatMessage): ChatMessageContent {
  const text = m.ragContext && m.ragContext.length > 0 ? `${m.ragContext}\n\n${m.content}` : m.content
  const images = m.images ?? []
  if (images.length === 0) return text
  const parts: ChatContentPart[] = []
  if (text.length > 0) parts.push({ type: 'text', text })
  for (const url of images) parts.push({ type: 'image_url', image_url: { url } })
  return parts
}

export type ChatSendAck =
  | { ok: true; id: string; streaming: true }
  | { ok?: false; error?: string; issues?: unknown }

/** Minimal structural view of the preload WindowApi the chat store needs. */
export type ChatIpcApi = {
  invoke(channel: 'chat:send', payload: ChatSendPayload): Promise<unknown>
  invoke(channel: 'chat:abort', payload: { id: string }): Promise<unknown>
  on(channel: 'chat:delta', listener: (e: ChatDeltaEvent) => void): () => void
  on(channel: 'chat:done', listener: (e: ChatDoneEvent) => void): () => void
  on(channel: 'chat:error', listener: (e: ChatErrorEvent) => void): () => void
}

/** Resolve window.api when present; null outside the Electron shell. */
export function getChatIpcApi(): ChatIpcApi | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: Partial<ChatIpcApi> }).api
  if (api && typeof api.invoke === 'function' && typeof api.on === 'function') return api as ChatIpcApi
  return null
}

export const IPC_UNAVAILABLE_MESSAGE = 'IPC 不可用：聊天需要 Electron 主进程转发（非桌面环境时降级为只读）'

/** Default upstream model tag; relay/resolver decides the real engine. */
export const DEFAULT_CHAT_MODEL = 'local'
