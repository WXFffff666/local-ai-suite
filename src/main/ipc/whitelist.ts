/**
 * IPC channel whitelist — Electron security baseline (T3), extended by W1-8.
 *
 * Two independent allowlists share this file as their single source of truth:
 * - ALLOWED_CHANNELS: renderer -> main (invoke). Every entry MUST have a handler
 *   registered in src/main/ipc/handlers.ts (Record<AllowedChannel> is the
 *   compile-time exhaustiveness proof).
 * - ALLOWED_EVENT_CHANNELS: main -> renderer (webContents.send, subscribed via
 *   preload on/once/off). Event channels are listed here once; payloads are
 *   typed by EventPayloads.
 *
 * agent:event / agent:term are pre-listed per plan (todo23/28 own their emit
 * sites); agent:* INVOKE channels are registered by todo23/24 themselves —
 * they are deliberately NOT part of ALLOWED_CHANNELS here.
 *
 * Sidecars are bound to 127.0.0.1 (see src/main/index.ts).
 */

export const ALLOWED_CHANNELS = [
  'health:pulse',
  'models:list',
  'models:download',
  'chat:send',
  'chat:abort',
  'image:generate',
  'image:queue:status',
  'gallery:list',
  'gallery:save',
  'gallery:copy',
  'gallery:insert',
  'gallery:reuse',
  'search:run',
  'hf:search',
  'conversations:list',
  'conversations:create',
  'conversations:rename',
  'conversations:delete',
  'conversations:appendMessage',
  'conversations:listMessages',
  'dialog:confirmDestructive',
  'workspace:delete',
  'coverage:overwrite',
  'release:publish',
  'cache:clear',
  'secrets:encrypt',
  'secrets:decrypt'
] as const

export type AllowedChannel = (typeof ALLOWED_CHANNELS)[number]

const ALLOWED_SET: ReadonlySet<string> = new Set<string>(ALLOWED_CHANNELS)

/**
 * Returns true iff the channel is in the invoke whitelist.
 */
export function isAllowedChannel(channel: string): boolean {
  return ALLOWED_SET.has(channel)
}

/**
 * Asserts channel is allowed; throws with a clear message otherwise.
 * Used by ipcMain.handle wrappers and by preload's invoke guard.
 */
export function assertAllowedChannel(channel: string): asserts channel is AllowedChannel {
  if (!isAllowedChannel(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`)
  }
}

// ---------------------------------------------------------------------------
// Event channels (main -> renderer). Gated separately from invoke channels;
// preload exposes on/once/off ONLY for these.
// ---------------------------------------------------------------------------

export const ALLOWED_EVENT_CHANNELS = [
  'chat:delta',
  'chat:done',
  'chat:error',
  'download:progress',
  'image:queue:status',
  'app:notification',
  'agent:event',
  'agent:term'
] as const

export type AllowedEventChannel = (typeof ALLOWED_EVENT_CHANNELS)[number]

const EVENT_ALLOWED_SET: ReadonlySet<string> = new Set<string>(ALLOWED_EVENT_CHANNELS)

export function isAllowedEventChannel(channel: string): boolean {
  return EVENT_ALLOWED_SET.has(channel)
}

export function assertAllowedEventChannel(channel: string): asserts channel is AllowedEventChannel {
  if (!isAllowedEventChannel(channel)) {
    throw new Error(`IPC event channel not allowed: ${channel}`)
  }
}

// ---------------------------------------------------------------------------
// Event payload contracts (exact shapes — consumed by todo9/11/12/14/17/23/28)
// ---------------------------------------------------------------------------

/** chat:send relay stream chunk (one assistant-text fragment). */
export type ChatDeltaEvent = { id: string; delta: string }
/** Stream finished normally, or was cancelled via chat:abort (aborted: true). */
export type ChatDoneEvent = { id: string; model?: string; aborted?: boolean }
export type ChatErrorEvent = { id: string; message: string }

export type DownloadState = 'downloading' | 'done' | 'error'
/**
 * models:download progress. total === 0 while the final size is unknown
 * (hf-cli/aria2 expose no byte total up front); on 'done', total === received.
 * todo14 renders progress bars off {id, received, total} per plan; state/error
 * are additive fields this channel already carries.
 */
export type DownloadProgressEvent = {
  id: string
  repoId: string
  received: number
  total: number
  state: DownloadState
  error?: string
}

export type ImageQueueEventType = 'queued' | 'progress' | 'retry' | 'done' | 'failed' | 'cancelled'
export type ImageQueueJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
/** Mirrors src/image/queue.ts QueueEvent (data field intentionally dropped). */
export type ImageQueueStatusEvent = {
  type: ImageQueueEventType
  jobId: string
  progress: number
  status: ImageQueueJobStatus
  message?: string
  attempt?: number
}

export type AppNotificationEvent = {
  level: 'info' | 'warning' | 'error'
  title: string
  message: string
  /** persistent toasts never auto-dismiss (e.g. 11434 conflict, todo10). */
  persistent?: boolean
  /** machine-readable code for UI branching, e.g. 'api-port-conflict'. */
  code?: string
}

/** Reserved: agent runner events (todo23) / xterm chunks (todo28). */
export type AgentEventEvent = Record<string, unknown>
export type AgentTermEvent = { id: string; chunk: string }

/** Main-side send surface handed to handlers (bound to the sending frame). */
export type IpcSendFn = (channel: AllowedEventChannel, payload: unknown) => void

export type EventPayloads = {
  'chat:delta': ChatDeltaEvent
  'chat:done': ChatDoneEvent
  'chat:error': ChatErrorEvent
  'download:progress': DownloadProgressEvent
  'image:queue:status': ImageQueueStatusEvent
  'app:notification': AppNotificationEvent
  'agent:event': AgentEventEvent
  'agent:term': AgentTermEvent
}
