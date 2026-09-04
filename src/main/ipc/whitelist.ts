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
import type { SidecarStatus } from '../../core/types'

export const ALLOWED_CHANNELS = [
  'health:pulse',
  'models:list',
  'models:download',
  'models:setDir',
  // todo19: LoRA picker — list diffusion LoRA files + safetensors header meta
  'models:loraScan',
  'models:loraMeta',
  // todo30b: registry-driven llama relaunch (services.launchModel — the 21→30
  // wired hop; modelId comes from models:list, mmproj pairing is registry-side)
  'models:launch',
  'download:cancel',
  'config:get',
  'config:set',
  'chat:send',
  'chat:abort',
  // todo42: 会话导出单文件 HTML。渲染层用 todo15 同一 sanitize 管线
  // (react-markdown + rehype-sanitize) 静态化出 html 字符串后送主进程落盘；
  // 主进程只负责文件名净化 + save dialog + 写文件（纯本地，无分享上传）。
  'chat:exportHtml',
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
  // todo39: RAG v1 hybrid retrieval (FTS5 BM25 × sqlite-vec → RRF fusion,
  // optional llama.cpp /v1/rerank精排). status is probe-only (no ingest),
  // ingest reads a main-resolved file/dir, query returns fused [n] citations.
  'rag:status',
  'rag:ingest',
  'rag:query',
  // todo30b: detection-first engine matrix + GPU pack download (progress
  // streams on the 'engines:progress' event; quarantine is a terminal state)
  'engines:status',
  'engines:gpuDownload',
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
  'secrets:decrypt',
  // todo32: staged auto-update (electron-updater). check = kick a
  // 'checking'→… run (outcome streams on 'update:state'); downloadAndInstall
  // is phase-routed main-side: available→download, downloaded→quitAndInstall.
  // The renderer NEVER receives a raw updater handle — install only via this
  // explicit user gesture (no forced update, plan Must-NOT).
  'update:check',
  'update:downloadAndInstall',
  // todo36: push-to-talk speech input (whisper.cpp server sidecar). getStatus
  // is spawn-free; only transcribe() may start the sidecar. No event channel —
  // the recorder state machine is renderer-local, transcription is one
  // request/response.
  'speech:getStatus',
  'speech:setPrefs',
  'speech:pickModel',
  'speech:saveWav',
  'speech:transcribe',
  // todo37: local OCR (PaddleOCR-json pipe-mode sidecar, on-demand engine
  // pack into userData/engines). status is spawn-free AND download-free;
  // install is an explicit user gesture (ack only, outcome streams on
  // 'ocr:progress'); recognize takes a chat dataURL or a galleryId — never a
  // renderer-supplied filesystem path.
  'ocr:status',
  'ocr:install',
  'ocr:recognize',
  // todo40: MCP stdio client manager (settings CRUD + lazy server lifecycle +
  // tools discovery/debug call). Tool EXECUTION for the agent rides the gated
  // registry, not these channels; mcp:callTool is the Settings test/debug
  // button and passes through the SAME permission gate.
  'mcp:listServers',
  'mcp:upsertServer',
  'mcp:removeServer',
  'mcp:setEnabled',
  'mcp:listTools',
  'mcp:callTool',
  // todo38: screenshot ask-overlay (global hotkey → region select → VLM chat).
  // frame:get is a PULL (deterministic — no did-finish-load/subscribe race);
  // select carries the canvas-cropped PNG dataURL; cancel is Esc / tiny-rect.
  // '__test.triggerHotkey' is the r2 test hook: the handler itself answers
  // {ok:false,error:'disabled'} whenever app.isPackaged (src/main/index.ts
  // gate) — globalShortcut presses cannot be synthesized from Playwright, so
  // e2e calls the hotkey action directly through this channel.
  'overlay:frame:get',
  'overlay:select',
  'overlay:cancel',
  // todo41: quick-ask mini chat window (global Ctrl+Shift+Space). ask rides the
  // SAME zod chatSendSchema + ChatRelay upstream as chat:send (the relay is the
  // shared ask function); its stream events are remapped to quickask:* so the
  // mini window never interleaves with the main window's chat:delta listeners.
  // hide/prefill:get are mini-window-verbs guarded by the controller sender id.
  'quickask:ask',
  'quickask:hide',
  'quickask:prefill:get',
  '__test.triggerHotkey'
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
  'permission:request',
  // todo30b: GPU pack download progress (main -> renderer)
  'engines:progress',
  // todo32: electron-updater state machine fanout (see UpdateStateEvent below)
  'update:state',
  // todo37: OCR engine pack install progress (terminal states done/quarantined/error)
  'ocr:progress',
  // todo40: MCP server lifecycle transitions (every state change of any server)
  'mcp:status',
  // todo38: the region-crop result seeds a VLM turn in the MAIN window chat
  // (App shell subscribes, navigates to #/chat and feeds the store send path).
  'ask:seed',
  // todo41: quick-ask mini window stream (chatRelay channel-remap, see below)
  // + the clipboard prefill push (main clipboard.readText() at show time).
  'quickask:delta',
  'quickask:done',
  'quickask:error',
  'quickask:prefill',
  // todo42: las:// 深链派发（second-instance / 首实例启动 argv 两处入口，
  // 主进程解析后只发封闭 action；渲染层 App 壳导航 hash 路由）。
  'app:deeplink'
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
  'engines:progress': EnginesProgressEvent
  'update:state': UpdateStateEvent
  'ocr:progress': OcrProgressEvent
  'mcp:status': McpStatusEvent
  'ask:seed': AskSeedEvent
  // todo41: the mini window's stream is the SAME Chat*Event payloads (the relay
  // emit is channel-remapped), and prefill carries the clipboard text verbatim.
  'quickask:delta': ChatDeltaEvent
  'quickask:done': ChatDoneEvent
  'quickask:error': ChatErrorEvent
  'quickask:prefill': QuickAskPrefillEvent
  'app:deeplink': AppDeepLinkEvent
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

// ---------------------------------------------------------------------------
// Engine status / GPU pack wire contracts (todo30b). Self-contained mirrors
// of src/engines/** (outside tsconfig.web's include set — same pattern as the
// permission wire above). handlers.ts carries the compile-time assignability
// proofs against the real resolver/gpuPack/manifest types.
// ---------------------------------------------------------------------------

/** Mirror of resolver EngineBinary (the availability matrix rows). */
export const ENGINE_WIRE_NAMES = ['llama', 'ollama', 'sd'] as const
export type EngineWireName = (typeof ENGINE_WIRE_NAMES)[number]

/** Mirror of manifest ManifestEngineKey (GPU packs exist only for these). */
export const GPU_PACK_ENGINE_WIRE_KEYS = ['llama', 'sd', 'whisper'] as const
export type GpuPackEngineWireKey = (typeof GPU_PACK_ENGINE_WIRE_KEYS)[number]

/** Mirror of resolver EngineSource plus the 'none' miss state. */
export type EngineWireSource = 'system' | 'bundled-cpu' | 'gpu-pack' | 'none'

/** Mirror of resolver SkipNote (cascade rejection, UI diagnostics). */
export type EngineSkipNoteWire = { source: Exclude<EngineWireSource, 'none'>; reason: string }

/** Mirror of resolver ResolvedEngine (hit and miss arms share the shape). */
export type EngineStatusEntry = {
  name: EngineWireName
  source: EngineWireSource
  bin: string | null
  version?: string
  skipped: EngineSkipNoteWire[]
}

/** Mirror of gpuPack NvidiaInfo (detectNvidia() summary). */
export type NvidiaSummaryWire = {
  available: boolean
  name?: string
  driverVersion?: string
  memoryMB?: number
  reason?: string
}

/**
 * Engine manifest digest for the UI: present=false covers both dev-absent and
 * invalid manifests (the download flow rejects both identically — resolver
 * policy lives in engines/**, not here). variants lists the downloadable GPU
 * pack variants per manifest engine key.
 */
export type EnginesManifestSummary = {
  present: boolean
  generatedAt: string | null
  variants: Partial<Record<GpuPackEngineWireKey, string[]>>
}

/** 'engines:status' reply ({}, availability matrix + nvidia + manifest). */
export type EnginesStatusReply =
  | {
      ok: true
      /** host OS platform (process.platform) — matrix platform column. */
      platform: string
      resolutions: EngineStatusEntry[]
      nvidia: NvidiaSummaryWire | null
      manifest: EnginesManifestSummary | null
    }
  | { ok: false; error: string }

/**
 * 'engines:progress' payload. Non-terminal states mirror gpuPack PackProgress
 * stages; terminal states: 'done' (activated), 'quarantined' (sha256 mismatch
 * — pack moved aside, resolver keeps the CPU binary), 'error' (download or
 * unexpected failure). 'note' carries the fallback/reason text.
 */
export type EngineProgressState = 'downloading' | 'verifying' | 'activating' | 'done' | 'quarantined' | 'error'
export type EnginesProgressEvent = {
  engine: GpuPackEngineWireKey
  variant: string
  received: number
  /** 0 while the final size is unknown (no Content-Length). */
  total: number
  state: EngineProgressState
  note?: string
}

/** 'engines:gpuDownload' reply — start-ack only; outcome streams via events. */
export type EnginesGpuDownloadReply =
  | { ok: true }
  | { ok: false; error: 'manifest-missing' | 'already-downloading' | 'unknown-variant' }

// ---------------------------------------------------------------------------
// Auto-update wire contracts (todo32). The electron-updater module lives ONLY
// in src/main/updater.ts; the renderer sees this closed union. The state
// machine is exactly the phases below — an unknown phase is a compile error on
// both sides, never a runtime surprise.
//
// 'error'.signatureUnavailable: the graceful "仅提示新版本" mode of the plan.
// On Windows the downloaded NSIS installer is code-signature-verified against
// the installed app's publisherName (electron-updater
// windowsExecutableCodeSignatureVerifier.ts + NsisUpdater verifySignature —
// real thrown strings, v6.8.9 source, cited in updater.ts). Unsigned dev /
// self-built packages trip that check, so we flag it and the banner swaps the
// install affordances for a manual release-page link.
// ---------------------------------------------------------------------------

export type UpdateStateEvent =
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; version: string }
  | { phase: 'progress'; percent: number; received: number; total: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string; signatureUnavailable?: boolean }

/** 'update:check' / 'update:downloadAndInstall' acks — outcome streams via events. */
export type UpdateCheckReply = { ok: true } | { ok: false; error: 'updater-error' | 'invalid-state' }
export type UpdateDownloadInstallReply =
  | { ok: true; action: 'downloading' | 'installing' }
  | { ok: false; error: 'updater-error' | 'invalid-state' }

/** 'models:launch' reply — services.launchModel outcome, errors never cross as throws. */
export type ModelsLaunchReply = { ok: true; status: SidecarStatus } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Speech (todo36) wire contracts. Whisper model/engine states are closed
// unions — the settings UI branches on them, an unknown code must be a
// compile error, never a runtime surprise.
// ---------------------------------------------------------------------------

/** Engine binary resolution state (mirrors src/speech/whisper.ts tiers). */
export type SpeechEngineSource = 'env' | 'bundled' | 'none'
export type SpeechEngineWire = { bin: string | null; source: SpeechEngineSource }

/** speech:getStatus / speech:setPrefs reply. */
export type SpeechStatusReply =
  | {
      ok: true
      enabled: boolean
      modelPath: string
      /** model file present+confined AND engine resolved — mic usable. */
      modelReady: boolean
      engine: SpeechEngineWire
      /** whisper-server sidecar currently running (spawn happens on first transcribe). */
      running: boolean
    }
  | {
      ok: false
      error:
        | 'not-absolute'
        | 'bad-extension'
        | 'file-not-found'
        | 'path-outside-allowed'
    }

/** speech:pickModel reply — null path = user cancelled the dialog. */
export type SpeechPickModelReply =
  | { ok: true; path: string | null }
  | {
      ok: false
      error: 'dialog-unavailable' | 'not-absolute' | 'bad-extension' | 'file-not-found' | 'path-outside-allowed'
    }

/** speech:saveWav reply (userData/tmp WAV drop, saveTempImage pattern). */
export type SpeechSaveWavReply = { ok: true; path: string } | { ok: false; error: 'invalid-payload' | 'dataurl-too-large' }

/** speech:transcribe reply. */
export type SpeechTranscribeReply =
  | { ok: true; text: string }
  | {
      ok: false
      error:
        | 'invalid-payload'
        | 'model-not-configured'
        | 'engine-missing'
        | 'audio-path-outside-allowed'
        | 'audio-not-found'
        | 'transcribe-failed'
      /** server/manager error text for UI diagnostics (never trusted). */
      detail?: string
    }

// ---------------------------------------------------------------------------
// OCR (todo37) wire contracts. PaddleOCR-json pipe-mode sidecar; the engine
// pack is a pinned on-demand download into userData/engines (src/ocr/pins.ts
// — deliberately NOT in the engines manifest union, see pins.ts header).
// ---------------------------------------------------------------------------

/** Engine binary resolution state (mirrors src/ocr/service.ts tiers). */
export type OcrEngineSource = 'env' | 'pack' | 'none'
export type OcrEngineWire = { bin: string | null; source: OcrEngineSource; version: string | null }

/** ocr:status reply. supported=false ⇒ pinned win32-x64 asset can't run here. */
export type OcrStatusReply =
  | { ok: true; supported: boolean; engine: OcrEngineWire; running: boolean }
  | { ok: false; error: string }

/** 'ocr:progress' payload (install flow; terminal: done/quarantined/error). */
export type OcrProgressState = 'downloading' | 'verifying' | 'activating' | 'done' | 'quarantined' | 'error'
export type OcrProgressEvent = {
  state: OcrProgressState
  received: number
  /** 0 while the final size is unknown (no Content-Length). */
  total: number
  note?: string
}

/** ocr:install reply — start-ack only; outcome streams via 'ocr:progress'. */
export type OcrInstallReply =
  | { ok: true }
  | { ok: false; error: 'engine-unsupported-platform' | 'already-installed' | 'already-downloading' }

/** ocr:recognize reply. */
export type OcrRecognizeReply =
  | { ok: true; text: string }
  | {
      ok: false
      error:
        | 'invalid-payload'
        | 'image-too-large'
        | 'engine-unsupported-platform'
        | 'engine-missing'
        | 'engine-tampered'
        | 'gallery-item-not-found'
        | 'recognize-failed'
      /** engine error text for UI diagnostics (never trusted). */
      detail?: string
    }

// ---------------------------------------------------------------------------
// RAG hybrid retrieval (todo39) wire contracts. Self-contained mirror of
// src/rag/** (outside tsconfig.web's include set — permission/engines wire
// precedent): the renderer consumes ONLY these shapes; citations carry the
// FTS5 page/line anchor so a [n] chip can locate the original chunk.
// ---------------------------------------------------------------------------

/** embeddings 三态裁决 (r2-fix): ollama /api/embeddings | internal llama-server --embeddings | hash 占位降级. */
export const RAG_EMBEDDING_MODES = ['ollama', 'internal', 'hash'] as const
export type RagEmbeddingModeWire = (typeof RAG_EMBEDDING_MODES)[number]

/** One [n] citation card, best-first (fusion or rerank order). */
export type RagCitation = {
  /** 1-based [n] index (dense from 1 in the final order) */
  n: number
  chunkId: string
  /** source document path (identity in the library) */
  source: string
  /** 0-based chunk page within source */
  page: number
  /** 1-based line of the first matched term within the chunk */
  line: number
  /** 0-based char offset of the first matched term */
  charOffset: number
  /** display snippet window around the match */
  snippet: string
  /** RRF fused score (Σ 1/(60+rank)) */
  rrf: number
  /** lane -> 1-based rank provenance (bm25 / vector) */
  ranks: Record<string, number>
  bm25Score?: number
  /** present only when the rerank lane answered */
  rerankScore?: number
}

/** rerank lane state for the UI badge (attempted but unavailable ≠ error). */
export type RagRerankState = {
  attempted: boolean
  ok: boolean
  reason?: string
}

/** rag:status reply (mode + library size + FTS/rerank availability). */
export type RagStatusReply =
  | {
      ok: true
      mode: RagEmbeddingModeWire
      model?: string
      docs: string[]
      chunks: number
      ftsAvailable: boolean
      rerankEnabled: boolean
    }
  | { ok: false; error: string }

/** rag:ingest reply ({ path: file|dir }). docs lists ingested source paths. */
export type RagIngestReply =
  | { ok: true; docs: string[]; chunks: number; mode: RagEmbeddingModeWire }
  | { ok: false; error: 'path-not-absolute' | 'path-not-found' | 'unsupported-type' | 'file-too-large' | 'ingest-failed'; detail?: string }

/** rag:query reply — fused (or reranked) citations + degraded banner hints. */
export type RagQueryReply =
  | { ok: true; citations: RagCitation[]; mode: RagEmbeddingModeWire; rerank: RagRerankState }
  | { ok: false; error: string }

// ---------------------------------------------------------------------------
// MCP stdio client manager (todo40) wire contracts. Self-contained mirror of
// src/mcp/** (outside tsconfig.web's include set — permission/engines/rag wire
// precedent). mcp:status mirrors McpStatusEvent; the server view NEVER carries
// env VALUES (keys only — the child gets values from the main-process pool).
// ---------------------------------------------------------------------------

export const MCP_SERVER_STATES_WIRE = ['stopped', 'starting', 'running', 'backoff', 'failed'] as const
export type McpServerStateWire = (typeof MCP_SERVER_STATES_WIRE)[number]

export type McpServerView = {
  name: string
  command: string
  args: readonly string[]
  envKeys: readonly string[]
  enabled: boolean
  state: McpServerStateWire
  /** tools/list count after the first successful connect this process; null before */
  toolCount: number | null
  /** last spawn/protocol error (failed-state tooltip) */
  lastError: string | null
}

/** 'mcp:status' payload (main -> renderer, broadcast on every transition). */
export type McpStatusEvent = {
  name: string
  state: McpServerStateWire
  error?: string
}

/** Honest not-ready + gate denial ride the shared error arms of every mcp reply. */
export type McpRequestError =
  | 'not-ready'
  | 'invalid-payload'
  | 'server-not-found'
  | 'server-disabled'
  | 'server-failed'
  | 'server-start-failed'
  | 'sdk-unavailable'
  | 'tool-not-found'
  | 'call-failed'
  | 'permission-denied'

export type McpListServersReply = { ok: true; servers: McpServerView[] } | { ok: false; error: McpRequestError }

export type McpUpsertServerReply = { ok: true; server: McpServerView } | { ok: false; error: McpRequestError }
export type McpRemoveServerReply = { ok: true } | { ok: false; error: McpRequestError }
export type McpSetEnabledReply = { ok: true; server: McpServerView } | { ok: false; error: McpRequestError }

export type McpToolEntry = { name: string; description?: string }
export type McpListToolsReply = { ok: true; tools: McpToolEntry[] } | { ok: false; error: McpRequestError }

/** mcp:callTool debug reply — result is the raw tools/call payload (JSON-serializable). */
export type McpCallToolReply =
  | { ok: true; result: unknown }
  | { ok: false; error: McpRequestError; detail?: string }

// ---------------------------------------------------------------------------
// Screenshot ask-overlay (todo38) wire contracts. The overlay renderer pulls
// the pre-captured frame (one desktopCapturer grab in main, NEVER persisted to
// disk — privacy guard), rubber-bands a CSS-px rect, crops it on its own
// <canvas> and hands the PNG back; main then seeds an ask turn in the primary
// window chat via the 'ask:seed' event (todo21 image_url path downstream).
// ---------------------------------------------------------------------------

/** Display geometry handed to the overlay (CSS bounds are DIP; crop is physical). */
export type OverlayDisplayInfo = {
  /** CSS (DIP) width of the captured display = overlay window width */
  width: number
  /** CSS (DIP) height of the captured display */
  height: number
  /** devicePixelRatio of the captured display (1 / 1.25 / 1.5 …) */
  scale: number
  /** physical pixel width of the frame image (bounds.width * scale, rounded) */
  physicalWidth: number
  /** physical pixel height of the frame image */
  physicalHeight: number
}

/** Selected region in CSS px, origin = display top-left (overlay-local). */
export type OverlayCssRect = { x: number; y: number; width: number; height: number }

/** 'overlay:frame:get' reply — {ok:false,error:'no-frame'} when no capture is live. */
export type OverlayFrameReply =
  | { ok: true; dataURL: string; display: OverlayDisplayInfo }
  | { ok: false; error: 'no-frame' }

/** 'overlay:select' / 'overlay:cancel' / '__test.triggerHotkey' acks. */
export type OverlaySelectReply =
  | { ok: true }
  /** invalid-payload mirrors the validatePayload 400-shape (issues ride with it). */
  | { ok: false; error: 'invalid-payload'; issues?: unknown }
  | { ok: false; error: 'no-overlay' | 'busy' }
export type OverlayCancelReply = { ok: true } | { ok: false; error: 'no-overlay' }
export type TestTriggerHotkeyReply =
  | { ok: true }
  // 'create-failed' is the todo41 quickask arm (window construction failure).
  | { ok: false; error: 'disabled' | 'busy' | 'capture-failed' | 'create-failed' }

/** 'ask:seed' payload (main -> primary window renderer; todo38). */
export type AskSeedEvent = {
  /** cropped region PNG data-URL (validated ≤4MiB decoded by the chat:send gate) */
  image: string
  /** chosen prompt chip: 解释这张图 / 提取文字 / 翻译 */
  prompt: string
}

// ---------------------------------------------------------------------------
// Quick-ask mini window (todo41) wire contracts. 'quickask:ask' payloads are
// the chatSendSchema shape verbatim (shared upstream = ChatRelay.start); the
// stream events are the Chat*Event payloads re-labeled to quickask:* so the
// mini window's listeners can never cross-talk with the main window's chat
// store. Session is EPHEMERAL: nothing here touches conversations:* channels
// (chat.db never sees a quickask turn) and history lives only in the renderer
// (capped at QUICKASK_HISTORY_CAP messages, hide = memory, not destroy).
// ---------------------------------------------------------------------------

/** 'quickask:prefill' payload — clipboard text captured at window-show time.
 *  Main gates it (non-empty, ≤ QUICKASK_CLIPBOARD_MAX_CHARS); absent/oversized
 *  clipboard sends nothing. */
export type QuickAskPrefillEvent = { text: string }

/** 'quickask:hide' ack (renderer Esc / blur-grace expiry → controller.hide). */
export type QuickAskHideReply = { ok: true } | { ok: false; error: 'no-window' }

/** 'quickask:prefill:get' ack — pull twin of the 'quickask:prefill' push
 *  (renderer mounts before the first push can land; the pull is deterministic). */
export type QuickAskPrefillReply =
  | { ok: true; prefill: string | null }
  | { ok: false; error: 'no-window' }

/** 'quickask:ask' ack — the relay start ack rides the chat:send contract. */
export type QuickAskAskReply = { ok: true; id: string; streaming: true }

/** '__test.triggerHotkey' now pins TWO names (todo38 screenshot + todo41
 *  quickask); reply union shared — TestTriggerHotkeyReply above covers both. */
export const TEST_HOTKEY_NAMES = ['screenshot', 'quickask'] as const

// ---------------------------------------------------------------------------
// Export & system integration (todo42) wire contracts.
// ---------------------------------------------------------------------------

/**
 * chat:exportHtml reply. The html is renderer-composed (todo15 sanitize
 * pipeline, static markup); main sanitizes the FILENAME (destructive edge:
 * strip <>:"/\|?* + control chars, cap 120, fallback 'chat'), opens the save
 * dialog at the downloads dir and writes UTF-8. 'cancelled' = user dismissed
 * the dialog — a benign outcome, not an error toast.
 */
export type ChatExportHtmlReply =
  | { ok: true; path: string }
  | { ok: false; error: 'invalid-payload'; issues?: unknown }
  | { ok: false; error: 'cancelled' | 'write-failed' | 'not-ready'; detail?: string }

/** las:// actions — the closed dispatch table (export/deeplink.ts parses into it). */
export const DEEP_LINK_ACTIONS = ['new-chat', 'models'] as const
export type DeepLinkAction = (typeof DEEP_LINK_ACTIONS)[number]

/** 'app:deeplink' payload (main -> renderer; action already validated). */
export type AppDeepLinkEvent = { action: DeepLinkAction }
