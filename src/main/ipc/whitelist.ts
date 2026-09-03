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
 * agent:* invoke channels (start/status/cancel) landed with todo23; the
 * agent:event payload is the todo23 AgentEvent union (src/agent/runner/types
 * — the single source both sides compile against). agent:term stays reserved
 * for todo28's xterm output.
 *
 * Sidecars are bound to 127.0.0.1 (see src/main/index.ts).
 */

import type { AgentEvent, AgentSessionStatus } from '../../agent/runner/types'

export const ALLOWED_CHANNELS = [
  'health:pulse',
  'models:list',
  'models:download',
  'models:setDir',
  // todo19: LoRA picker — list diffusion LoRA files + safetensors header meta
  'models:loraScan',
  'models:loraMeta',
  'download:cancel',
  'config:get',
  'config:set',
  'chat:send',
  'chat:abort',
  // todo23: agent tool-calling loop (permission decision channels ride with
  // todo25; agent:term event stays reserved for todo28's xterm output)
  'agent:start',
  'agent:status',
  'agent:cancel',
  // todo25: permission approval dialog respond channel (main->renderer prompt
  // rides the 'permission:request' event below; grants persist via the
  // PermissionEngine through todo29's wiring, never through this file)
  'permission:respond',
  'image:generate',
  'image:queue:status',
  'image:saveTempImage',
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
  'agent:term',
  // todo25: main -> renderer permission approval prompt
  'permission:request'
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
// chat message content wire contract (todo21 VLM — shared renderer↔main truth)
// ---------------------------------------------------------------------------

/** Plain text segment of a multimodal message. */
export type ChatTextPart = { type: 'text'; text: string }
/**
 * Image segment. ONLY base64 data-URLs are legal on the wire
 * (data:image/(png|jpeg|jpg|webp|gif);base64,...) — remote URLs are rejected
 * by the zod gate in schemas.ts and never rendered. Validated server-side;
 * the types here state the intent.
 */
export type ChatImageUrlPart = { type: 'image_url'; image_url: { url: string } }
export type ChatContentPart = ChatTextPart | ChatImageUrlPart
/** OpenAI-compatible content: plain string or ordered text/image parts. */
export type ChatMessageContent = string | ChatContentPart[]

// ---------------------------------------------------------------------------
// Event payload contracts (exact shapes — consumed by todo9/11/12/14/17/23/28)
// ---------------------------------------------------------------------------

/**
 * chat:send relay stream chunk (one assistant fragment).
 * `reasoning` carries thinking/reasoning_content deltas (todo11b parity);
 * it is OMITTED (not empty-string) when absent, so content-only deltas
 * stay byte-identical to the pre-11b wire shape (back-compat contract).
 */
export type ChatDeltaEvent = { id: string; delta: string; reasoning?: string }
/** Stream finished normally, or was cancelled via chat:abort (aborted: true). */
export type ChatDoneEvent = { id: string; model?: string; aborted?: boolean }
export type ChatErrorEvent = { id: string; message: string }

export type DownloadState = 'downloading' | 'done' | 'error' | 'cancelled'
/**
 * models:download progress. total === 0 while the final size is unknown
 * (hf-cli/aria2 expose no byte total up front); on 'done', total === received.
 * 'cancelled' is the terminal state of download:cancel (todo14b) — the child
 * process was tree-killed and no further events fire for that id.
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

/** todo23: runner event union (see src/agent/runner/types.ts — exhaustive match there). */
export type AgentEventEvent = AgentEvent
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
  'permission:request': PermissionRequestEvent
}

// ---------------------------------------------------------------------------
// Agent invoke reply contracts (todo23). Declared alongside the event payload
// they pair with so todo29 renders from one file. Start rejections are
// runner-level decisions (sessions.ts); validation rejections ride the
// standard 400-shape from schemas.ts.
// ---------------------------------------------------------------------------

export type AgentStartReply =
  | { ok: true; sessionId: string; started: true }
  | { ok: false; error: 'session-already-running' | 'model-not-selected' | 'base-url-not-local' | 'invalid-base-url' }
export type AgentStatusReply = { ok: true; status: AgentSessionStatus | null }
export type AgentCancelReply = { ok: true; sessionId: string; cancelled: boolean }

// ---------------------------------------------------------------------------
// Permission approval wire contracts (todo25). Human-in-the-loop ONLY: this
// surface has no "approve-all" master switch (Appendix C LLM06 / OWASP
// no-YOLO posture — every ask is decided per-request, auto-deny on timeout).
// The action/assessment shapes are a SELF-CONTAINED mirror of
// src/agent/policy/types.ts (that directory is outside tsconfig.web's include
// set, so nothing here may import it; permissionBridge.ts carries the
// compile-time alignment proofs against the real policy types).
// ---------------------------------------------------------------------------

/** The four dialog outcomes. 'once' never persists; session/always do. */
export const PERMISSION_GRANT_CHOICES = ['once', 'session', 'always', 'deny'] as const
export type PermissionGrantChoice = (typeof PERMISSION_GRANT_CHOICES)[number]

/** Mirror of policy PermissionKind. */
export const PERMISSION_WIRE_KINDS = ['fs.read', 'fs.write', 'fs.shell', 'net', 'mcp'] as const
export type PermissionWireKind = (typeof PERMISSION_WIRE_KINDS)[number]

/** Mirror of policy PermissionTargetFields / PermissionAction. */
export type PermissionTargetFieldsWire = {
  cmd?: string
  path?: string
  host?: string
  server?: string
  tool?: string
}
export type PermissionActionWire = {
  type: PermissionWireKind
  target: string | PermissionTargetFieldsWire
}

/** Mirror of policy Assessment (winning rule display data). */
export type PermissionAssessmentWire = {
  decision: 'allow' | 'deny' | 'ask'
  rule: string | null
  ruleId: number | null
  scope: 'session' | 'always' | null
}

/** What the dialog previews per request kind: fs.write diff, shell cmd+cwd, net host/path. */
export type PermissionPreview =
  | { kind: 'diff'; path: string; oldText: string; newText: string; workspacePath?: string }
  | { kind: 'command'; cmd: string; cwd?: string; workspacePath?: string }
  | { kind: 'net'; host: string; path?: string }

/** 'permission:request' payload (main -> renderer; bridge-owned requestId). */
export type PermissionRequestEvent = {
  requestId: string
  action: PermissionActionWire
  assessment: PermissionAssessmentWire
  preview: PermissionPreview
  /** Auto-deny budget applied by the bridge; the renderer countdown is visual-only. */
  timeoutMs: number
  requestedAt: number
}

/** 'permission:respond' reply (validation failures ride the 400-shape instead). */
export type PermissionRespondReply = { ok: true } | { ok: false; error: 'unknown-request' }

// ---------------------------------------------------------------------------
// LoRA invoke reply contracts (todo19). Declared here — the one src/main file
// inside tsconfig.web's include set — so renderer and main share one source of
// truth for the wire shapes.
// ---------------------------------------------------------------------------

/** One scanned LoRA weight file (models:loraScan reply item). */
export type LoraFile = {
  /** file stem — the name used in `<lora:name:scale>` prompt tags */
  name: string
  /** path relative to modelsDir (POSIX separators) */
  file: string
  /** absolute path (models:loraMeta argument; re-confined server-side) */
  path: string
  /** human-readable size, e.g. '142.3 MB' */
  sizeLabel: string
  /** 'safetensors' | 'gguf' — header meta parsing only applies to safetensors */
  format: 'safetensors' | 'gguf'
}

/** Filtered safetensors __metadata__ keys (ss_* / *lora*), string|number values. */
export type LoraMeta = Record<string, string | number>

export type LoraScanReply = { ok: true; files: LoraFile[] } | { ok: false; error: string }

export type LoraMetaError =
  | 'path-outside-models-dir'
  | 'file-not-found'
  | 'header-too-large'
  | 'bad-header'
  | 'meta-unsupported'

export type LoraMetaReply = { ok: true; meta: LoraMeta } | { ok: false; error: LoraMetaError }
