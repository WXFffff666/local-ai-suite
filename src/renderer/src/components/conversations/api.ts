/**
 * api.ts — renderer IPC client for conversations:* channels (todo17).
 * Structural view only (same convention as src/chat/ipc.ts): window.api may be
 * absent (plain browser / vitest) → getApi() returns null and the sidebar
 * degrades honestly instead of throwing.
 */
import type { AllowedChannel } from '../../../../main/ipc/whitelist'

export type ConversationRole = 'user' | 'assistant' | 'system'

export type ConversationMeta = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export type StoredMessage = {
  id: string
  chatId: string
  role: ConversationRole
  content: string
  createdAt: number
}

export type InvokeFn = (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>

/** Resolve window.api.invoke when bridged; null outside the Electron shell. */
export function getApi(): InvokeFn | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: { invoke?: InvokeFn } }).api
  if (api && typeof api.invoke === 'function') return api.invoke.bind(api)
  return null
}

type Envelope = { ok?: boolean; error?: string; issues?: unknown }

function unwrap<T>(res: unknown, key: string): T {
  const env = (res ?? {}) as Envelope & Record<string, unknown>
  if (env.ok !== true) {
    const detail = Array.isArray(env.issues) && env.issues.length > 0 ? `: ${JSON.stringify(env.issues)}` : ''
    throw new Error(`${key} rejected by main: ${env.error ?? 'unknown-error'}${detail}`)
  }
  return env[key] as T
}

function requireArray<T>(value: unknown, key: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${key} returned a malformed payload`)
  return value as T[]
}

export async function listConversations(invoke: InvokeFn): Promise<ConversationMeta[]> {
  const items = unwrap<unknown>(await invoke('conversations:list', {}), 'conversations')
  return requireArray<ConversationMeta>(items, 'conversations:list')
}

export async function createConversation(invoke: InvokeFn, title?: string): Promise<ConversationMeta> {
  const body = title === undefined ? {} : { title }
  return unwrap<ConversationMeta>(await invoke('conversations:create', body), 'conversation')
}

export async function renameConversation(invoke: InvokeFn, id: string, title: string): Promise<ConversationMeta> {
  return unwrap<ConversationMeta>(await invoke('conversations:rename', { id, title }), 'conversation')
}

export async function deleteConversationRow(invoke: InvokeFn, id: string): Promise<boolean> {
  return unwrap<boolean>(await invoke('conversations:delete', { id }), 'deleted')
}

export async function listMessages(invoke: InvokeFn, chatId: string): Promise<StoredMessage[]> {
  const items = unwrap<unknown>(await invoke('conversations:listMessages', { chatId }), 'messages')
  return requireArray<StoredMessage>(items, 'conversations:listMessages')
}
