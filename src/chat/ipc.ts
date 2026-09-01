/**
 * ipc.ts — chat 的渲染层 IPC 契约面（todo11 拆分自 store.ts）
 * 单一职责：描述 window.api 上 chat:send / chat:abort + 事件的最小结构视图，
 * 以及非 Electron 环境（vitest node、纯浏览器）下的可用性守卫。
 * 载荷/事件类型本体来自 src/main/ipc/whitelist.ts（EventPayloads 契约）。
 */
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent } from '../main/ipc/whitelist'
import type { Role } from './types'

export type ChatSendPayload = {
  id: string
  model: string
  messages: Array<{ role: Role; content: string }>
  temperature?: number
  top_p?: number
  max_tokens?: number
  stop?: string | string[]
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
