/**
 * Real IPC handlers (plan W1-8) — replaces the index.ts stubs.
 *
 * buildIpcHandlers returns an exhaustive Record<AllowedChannel, IpcHandler>:
 * adding a channel to the whitelist without a handler here is a COMPILE error,
 * which is the plan's "Record<AllowedChannel> 编译期单一事实源" guarantee.
 *
 * Every new/changed handler validates its payload via zod (Appendix C: todo8
 * owns IPC input validation) and returns the stable 400-shape
 * { ok:false, error:'invalid-payload', issues } instead of throwing across the
 * boundary. The pre-existing destructive channels keep their own validated
 * factories (showDestructiveConfirm + assertValidOptions — unchanged contract).
 * Channels pre-listed for todo17 (conversations:*) report
 * { ok:false, error:'not-ready' } until the real store is injected.
 */

import { statSync } from 'fs'
import { isAbsolute } from 'path'
import { SIDECAR_HOST } from '../../core/types'
import type { ModelEntry } from '../../models/registry'
import type { CopyPayload, GalleryItem, InsertPayload, ReuseParams, SaveOptions } from '../../gallery/gallery'
import type { OrchestratorResult } from '../../search/orchestrator'
import type { ImageJob, QueueEvent } from '../../image/queue'
import type { HfModelCard, SearchOptions } from '../../market/hf'
import { detectNvidia, downloadPack } from '../../engines/gpuPack'
import { loadEngineManifest } from '../../engines/manifest'
import { createEnginesHandlers, type EnginesDeps } from '../handlers/enginesIpc'
import { getConfig, setConfig, type AppConfig } from '../storage/config'
import type { Services } from '../services'
import { createDestructiveConfirmHandler, type DialogLike } from '../utils/dialogConfirm'
import { createDeleteWorkspaceHandler } from '../handlers/deleteWorkspace'
import { createImageGenerateHandler, createSaveTempImageHandler } from '../handlers/imageOps'
import { createOverwriteCoverageHandler } from '../handlers/overwriteCoverage'
import { createPublishReleaseHandler } from '../handlers/publishRelease'
import { createClearCacheHandler } from '../handlers/clearCache'
import { readLoraMetaFile, toLoraFiles } from './loraFs'
import type { ChatRelay } from './chatRelay'
import type { DownloadManager } from './downloadManager'
import { createSecretsHandlers, type SafeStorageLike } from './secrets'
import type { AgentSessions } from '../../agent/runner/sessions'
import type { AgentEvent } from '../../agent/runner/types'
import type { PermissionBridge } from './permissionBridge'
import {
  agentCancelSchema,
  agentStartSchema,
  agentStatusSchema,
  chatAbortSchema,
  chatSendSchema,
  configGetSchema,
  configSetSchema,
  conversationsAppendMessageSchema,
  conversationsCreateSchema,
  conversationsDeleteSchema,
  conversationsListMessagesSchema,
  conversationsRenameSchema,
  downloadCancelSchema,
  galleryIdSchema,
  gallerySaveSchema,
  hfSearchSchema,
  imageQueueStatusSchema,
  modelsDownloadSchema,
  modelsLoraMetaSchema,
  modelsLoraScanSchema,
  modelsSetDirSchema,
  permissionRespondSchema,
  searchRunSchema,
  updateCheckSchema,
  updateDownloadInstallSchema,
  validatePayload
} from './schemas'
import type {
  AgentCancelReply,
  AgentStartReply,
  AllowedChannel,
  AgentStatusReply,
  ImageQueueStatusEvent,
  IpcSendFn,
  LoraMetaReply,
  LoraScanReply,
  PermissionRespondReply,
  UpdateCheckReply,
  UpdateDownloadInstallReply
} from './whitelist'
// type-only: updater.ts imports electron-updater at runtime; the value graph
// must NEVER leak into this module (handlers.test.ts runs without it — the
// electron-mock pitfall in learnings.md applies to electron-updater too).
import type { Updater } from '../updater'

export type HandlerContext = { send: IpcSendFn }
export type IpcHandler = (args: unknown[], ctx: HandlerContext) => Promise<unknown>
type HandlerMap = Record<AllowedChannel, IpcHandler>

/**
 * The subset of the service container the handlers touch. Method-level Picks
 * keep the type structural (no private members leak), so unit tests can pass
 * plain stub objects while the real Services instance satisfies it as-is.
 */
export type ServicesSurface = {
  /** todo19: modelsDir (public readonly on ModelRegistry) confines the loraMeta path. */
  registry: Pick<Services['registry'], 'getModels' | 'reloadModels' | 'modelsDir'>
  imageQueue: Pick<Services['imageQueue'], 'enqueue' | 'getJob' | 'listJobs' | 'subscribe' | 'pending'>
  gallery: Pick<Services['gallery'], 'list' | 'save' | 'copy' | 'insert' | 'reuse'>
  search: Pick<Services['search'], 'search'>
  ensureSidecar: Services['ensureSidecar']
  /** todo20: image:saveTempImage writes under <userDataDir>/tmp (real Services exposes this). */
  userDataDir: Services['userDataDir']
  /**
   * todo30b (lane 30 finalizer): the real Services already exposes all three;
   * this is a structural Pick extension only — no services.ts/index.ts edit
   * was needed (index passes the whole container instance to buildIpcHandlers).
   */
  engineResolver: Services['engineResolver']
  getEngineResolutions: Services['getEngineResolutions']
  launchModel: Services['launchModel']
}

export type HfSearchFn = (opts: SearchOptions) => Promise<HfModelCard[]>

/** todo17 supplies the real implementation; absent ⇒ honest not-ready. */
export type ConversationsProvider = {
  list: () => Promise<unknown>
  create: (title?: string) => Promise<unknown>
  rename: (id: string, title: string) => Promise<unknown>
  delete: (id: string) => Promise<unknown>
  appendMessage: (chatId: string, role: string, content: string) => Promise<unknown>
  listMessages: (chatId: string) => Promise<unknown>
}

export type HandlerDeps = {
  services: ServicesSurface
  /** structural: tests substitute fakes without touching private state. */
  relay: Pick<ChatRelay, 'start' | 'abort'>
  downloads: Pick<DownloadManager, 'start' | 'cancel'>
  hfSearch: HfSearchFn
  dialog: DialogLike
  safeStorage: SafeStorageLike
  conversations?: () => ConversationsProvider | null
  /**
   * todo23: agent session registry behind the agent:* channels. Absent until
   * the container wires it (same honest not-ready pattern as conversations
   * before todo17); todo29 injects it in main/index.ts alongside the tools
   * registry (todo27/28).
   */
  agent?: () => Pick<AgentSessions, 'start' | 'cancel' | 'status'> | null
  /**
   * todo25: permission approval bridge behind 'permission:respond'. Same
   * honest not-ready pattern as `agent` — todo29 constructs the bridge in
   * main/index.ts (send bound to the focused window, onGrant wired to
   * PermissionEngine.addRule) and hands the executor half to todo27/28's
   * tool host. Only `respond` crosses the IPC boundary here.
   */
  permission?: () => Pick<PermissionBridge, 'respond'> | null
  /**
   * todo30b: engines module surface behind engines:* (detectNvidia /
   * loadEngineManifest / downloadPack). Defaults are the real engines
   * functions; tests inject fakes through this seam (same convention as
   * hfSearch/dialog/safeStorage — no vi.mock needed). The availability
   * matrix and the launch hop ride the services container directly.
   */
   engines?: EnginesDeps
   /**
    * todo32: auto-updater surface behind update:check / update:downloadAndInstall.
    * Same lazy-seam convention as `agent`/`permission` (index.ts constructs the
    * updater once and hands a getter; tests inject fakes here). Absent ⇒ the
    * honest not-ready shape. Updater outcome itself streams on 'update:state';
    * these replies are acks only.
    */
   updater?: () => Updater | null
  /** destructive-action backends (same no-op wiring index.ts had pre-W1). */
  onDeleteWorkspace?: (id: string) => Promise<void>
  onOverwriteCoverage?: (opts: unknown) => Promise<void>
  onPublishRelease?: (opts: unknown) => Promise<void>
  onClearCache?: (opts: { scope?: string; cacheDir?: string }) => Promise<void>
}

const NOT_READY = { ok: false, error: 'not-ready' } as const

function first(args: unknown[], fallback: unknown = undefined): unknown {
  return args.length > 0 ? args[0] : fallback
}

/** QueueEvent -> image:queue:status payload (data field intentionally dropped). */
export function toImageQueueStatusEvent(ev: QueueEvent): ImageQueueStatusEvent {
  const event: ImageQueueStatusEvent = { type: ev.type, jobId: ev.jobId, progress: ev.progress, status: ev.status }
  if (ev.message !== undefined) event.message = ev.message
  if (ev.attempt !== undefined) event.attempt = ev.attempt
  return event
}

export function buildIpcHandlers(deps: HandlerDeps): HandlerMap {
  const { services } = deps
  const secrets = createSecretsHandlers(deps.safeStorage)
  const provider = (): ConversationsProvider | null => deps.conversations?.() ?? null
  const engines: EnginesDeps = deps.engines ?? { detectNvidia, loadEngineManifest, downloadPack }
  // todo30b: engines:status / engines:gpuDownload / models:launch implementation
  // lives in ../handlers/enginesIpc.ts (registration-only map, imageOps precedent).
  const engineHandlers = createEnginesHandlers(services, engines)

  const passthrough =
    (fn: (args: unknown[]) => Promise<unknown>): IpcHandler =>
    async (args) =>
      fn(args)

  const handlers: HandlerMap = {
    // --- health / models ------------------------------------------------------
    'health:pulse': async () => ({ ok: true, host: SIDECAR_HOST }),
    'models:list': async () => {
      const models: ModelEntry[] = services.registry.getModels()
      return { models }
    },
    'models:download': async (args) => {
      const parsed = validatePayload(modelsDownloadSchema, first(args))
      if (!parsed.ok) return parsed
      return deps.downloads.start(parsed.data)
    },
    // todo13: switch the models directory. The path must be absolute and an
    // existing directory. config.modelsDir is what Services rebuilds the
    // registry from at next boot; the live registry instance still watches the
    // OLD dir (services.ts owns it — out of this lane), so reloadModels()
    // refreshes the current scan and restartRequired stays honest in the reply.
    'models:setDir': async (args) => {
      const parsed = validatePayload(modelsSetDirSchema, first(args))
      if (!parsed.ok) return parsed
      const dir = parsed.data.path
      if (!isAbsolute(dir)) return { ok: false, error: 'path-not-absolute' }
      let isDirectory = false
      try {
        isDirectory = statSync(dir).isDirectory()
      } catch {
        isDirectory = false
      }
      if (!isDirectory) return { ok: false, error: 'dir-not-found' }
      const next = setConfig({ modelsDir: dir })
      const models: ModelEntry[] = services.registry.reloadModels()
      return { ok: true, modelsDir: next.modelsDir, models, restartRequired: true }
    },

    // todo19: LoRA picker channels. Scan is a pure projection of the registry
    // (chokidar watch keeps it fresh — no second fs walk). Meta reads touch the
    // fs directly but the renderer-supplied path is confined to modelsDir
    // inside readLoraMetaFile before any open (assertInsideModelsDir).
    'models:loraScan': async (args) => {
      const parsed = validatePayload(modelsLoraScanSchema, first(args, {}))
      if (!parsed.ok) return parsed
      const reply: LoraScanReply = { ok: true, files: toLoraFiles(services.registry.getModels()) }
      return reply
    },
    'models:loraMeta': async (args) => {
      const parsed = validatePayload(modelsLoraMetaSchema, first(args))
      if (!parsed.ok) return parsed
      const reply: LoraMetaReply = readLoraMetaFile(parsed.data.path, services.registry.modelsDir)
      return reply
    },

    // todo30b: registry-driven llama relaunch (the 21→30 wired hop). The
    // launch/error policy is services.launchModel; wiring in enginesIpc.ts.
    'models:launch': engineHandlers['models:launch'],

    // --- config (todo16: theme / locale / encrypted secret payloads) ------------
    'config:get': async (args) => {
      const parsed = validatePayload(configGetSchema, first(args, {}))
      if (!parsed.ok) return parsed
      return { ok: true, config: getConfig() }
    },
    'config:set': async (args) => {
      const parsed = validatePayload(configSetSchema, first(args))
      if (!parsed.ok) return parsed
      const { theme, locale, secrets } = parsed.data
      const partial: Partial<AppConfig> = {}
      if (theme !== undefined) partial.theme = theme
      if (locale !== undefined) partial.locale = locale
      if (secrets !== undefined) {
        // field-wise merge; zod already rejected non-enc payloads
        partial.secrets = { ...getConfig().secrets, ...secrets }
      }
      return { ok: true, config: setConfig(partial) }
    },

    // --- download control (todo14b) --------------------------------------------
    'download:cancel': async (args) => {
      const parsed = validatePayload(downloadCancelSchema, first(args))
      if (!parsed.ok) return parsed
      return deps.downloads.cancel(parsed.data.id)
    },

    // --- chat (events go to ctx.send = the SENDING frame only) -----------------
    'chat:send': async (args, ctx) => {
      const parsed = validatePayload(chatSendSchema, first(args))
      if (!parsed.ok) return parsed
      return deps.relay.start(parsed.data, ctx.send)
    },
    'chat:abort': async (args) => {
      const parsed = validatePayload(chatAbortSchema, first(args))
      if (!parsed.ok) return parsed
      return deps.relay.abort(parsed.data)
    },

    // --- agent (todo23) ----------------------------------------------------------
    // Thin registration only: validation + delegation. The tool-calling loop,
    // session state and abort cascade live in src/agent/runner/** (pure, unit-
    // tested there); agent:event flows to the STARTING frame's send fn, mirroring
    // the chat:send rule. NOT_READY until todo29 injects the sessions container.
    'agent:start': async (args, ctx) => {
      const parsed = validatePayload(agentStartSchema, first(args))
      if (!parsed.ok) return parsed
      const sessions = deps.agent?.()
      if (!sessions) return NOT_READY
      const emit = (event: AgentEvent): void => {
        ctx.send('agent:event', event)
      }
      const reply: AgentStartReply = sessions.start(parsed.data, emit)
      return reply
    },
    'agent:status': async (args) => {
      const parsed = validatePayload(agentStatusSchema, first(args))
      if (!parsed.ok) return parsed
      const sessions = deps.agent?.()
      if (!sessions) return NOT_READY
      const reply: AgentStatusReply = sessions.status(parsed.data.sessionId)
      return reply
    },
    'agent:cancel': async (args) => {
      const parsed = validatePayload(agentCancelSchema, first(args))
      if (!parsed.ok) return parsed
      const sessions = deps.agent?.()
      if (!sessions) return NOT_READY
      const reply: AgentCancelReply = sessions.cancel(parsed.data.sessionId)
      return reply
    },

    // --- permission approval (todo25) ------------------------------------------
    // Registration-only: the pending-request state machine (120s auto-deny,
    // abort->deny, once/session/always/deny) lives in permissionBridge.ts,
    // unit-tested there. This seam validates the wire shape and forwards the
    // decision; a stale/forged requestId is refused, never guessed at.
    'permission:respond': async (args) => {
      const parsed = validatePayload(permissionRespondSchema, first(args))
      if (!parsed.ok) return parsed
      const bridge = deps.permission?.()
      if (!bridge) return NOT_READY
      const settled = bridge.respond(parsed.data.requestId, parsed.data.choice)
      const reply: PermissionRespondReply = settled ? { ok: true } : { ok: false, error: 'unknown-request' }
      return reply
    },

    // --- image queue -------------------------------------------------------------
    // todo20: implementation lives in ../handlers/imageOps.ts (validation +
    // queue/file side effects); the map below stays registration-only.
    'image:generate': passthrough(createImageGenerateHandler({ imageQueue: services.imageQueue })),
    'image:queue:status': async (args) => {
      const parsed = validatePayload(imageQueueStatusSchema, first(args, {}))
      if (!parsed.ok) return parsed
      if (parsed.data.jobId !== undefined) {
        const job = services.imageQueue.getJob(parsed.data.jobId)
        return { ok: true, job: job ?? null }
      }
      const jobs: ImageJob[] = services.imageQueue.listJobs()
      return { ok: true, jobs, pending: services.imageQueue.pending }
    },

    /**
     * todo20 — renderer-synthesized PNG (drop / mask brush) → userData/tmp.
     * Implementation in ../handlers/imageOps::createSaveTempImageHandler.
     */
    'image:saveTempImage': passthrough(createSaveTempImageHandler({ userDataDir: services.userDataDir })),

    // --- gallery (five verbs) -------------------------------------------------
    'gallery:list': async () => {
      const items: GalleryItem[] = services.gallery.list()
      return { items }
    },
    'gallery:save': async (args) => {
      const parsed = validatePayload(gallerySaveSchema, first(args))
      if (!parsed.ok) return parsed
      const opts: Omit<SaveOptions, 'baseDir'> = parsed.data
      return { ok: true, item: services.gallery.save(opts) }
    },
    'gallery:copy': async (args) => {
      const parsed = validatePayload(galleryIdSchema, first(args))
      if (!parsed.ok) return parsed
      const payload: CopyPayload = services.gallery.copy(parsed.data.id)
      return { ok: true, payload }
    },
    'gallery:insert': async (args) => {
      const parsed = validatePayload(galleryIdSchema, first(args))
      if (!parsed.ok) return parsed
      const payload: InsertPayload = services.gallery.insert(parsed.data.id)
      return { ok: true, payload }
    },
    'gallery:reuse': async (args) => {
      const parsed = validatePayload(galleryIdSchema, first(args))
      if (!parsed.ok) return parsed
      const params: ReuseParams = services.gallery.reuse(parsed.data.id)
      return { ok: true, params }
    },

    // --- search / HF market ------------------------------------------------------
    'search:run': async (args) => {
      const parsed = validatePayload(searchRunSchema, first(args))
      if (!parsed.ok) return parsed
      const { query, count } = parsed.data
      const result: OrchestratorResult = await services.search.search(query, count === undefined ? {} : { count })
      return { ok: true, result }
    },
    'hf:search': async (args) => {
      const parsed = validatePayload(hfSearchSchema, first(args, {}))
      if (!parsed.ok) return parsed
      const cards = await deps.hfSearch(parsed.data)
      return { ok: true, cards }
    },

    // --- engines (todo30b) ------------------------------------------------------
    // Registration-only: the availability matrix, GPU pack single-flight download
    // and the model-launch hop are implemented in ../handlers/enginesIpc.ts
    // (createEnginesHandlers). The cascade / verification / activation policies
    // live in src/engines/** (unit-tested there); this map just wires channels.
    'engines:status': engineHandlers['engines:status'],
    'engines:gpuDownload': engineHandlers['engines:gpuDownload'],

    // --- conversations (channels pre-listed; real service = todo17) --------------
    'conversations:list': async () => {
      const store = provider()
      if (!store) return NOT_READY
      return { ok: true, conversations: await store.list() }
    },
    'conversations:create': async (args) => {
      const parsed = validatePayload(conversationsCreateSchema, first(args, {}))
      if (!parsed.ok) return parsed
      const store = provider()
      if (!store) return NOT_READY
      return { ok: true, conversation: await store.create(parsed.data.title) }
    },
    'conversations:rename': async (args) => {
      const parsed = validatePayload(conversationsRenameSchema, first(args))
      if (!parsed.ok) return parsed
      const store = provider()
      if (!store) return NOT_READY
      return { ok: true, conversation: await store.rename(parsed.data.id, parsed.data.title) }
    },
    'conversations:delete': async (args) => {
      const parsed = validatePayload(conversationsDeleteSchema, first(args))
      if (!parsed.ok) return parsed
      const store = provider()
      if (!store) return NOT_READY
      return { ok: true, deleted: await store.delete(parsed.data.id) }
    },
    'conversations:appendMessage': async (args) => {
      const parsed = validatePayload(conversationsAppendMessageSchema, first(args))
      if (!parsed.ok) return parsed
      const store = provider()
      if (!store) return NOT_READY
      return { ok: true, message: await store.appendMessage(parsed.data.chatId, parsed.data.role, parsed.data.content) }
    },
    'conversations:listMessages': async (args) => {
      const parsed = validatePayload(conversationsListMessagesSchema, first(args))
      if (!parsed.ok) return parsed
      const store = provider()
      if (!store) return NOT_READY
      return { ok: true, messages: await store.listMessages(parsed.data.chatId) }
    },

    // --- pre-W1 channels (factories unchanged, behaviour-preserving wiring) ------
    'dialog:confirmDestructive': passthrough(createDestructiveConfirmHandler(deps.dialog)),
    'workspace:delete': passthrough(
      createDeleteWorkspaceHandler(deps.dialog, deps.onDeleteWorkspace ?? (async () => undefined))
    ),
    'coverage:overwrite': passthrough(
      createOverwriteCoverageHandler(deps.dialog, deps.onOverwriteCoverage ?? (async () => undefined))
    ),
    'release:publish': passthrough(
      createPublishReleaseHandler(deps.dialog, deps.onPublishRelease ?? (async () => undefined))
    ),
    'cache:clear': passthrough(
      createClearCacheHandler(deps.dialog, deps.onClearCache ?? (async () => undefined))
    ),
    'secrets:encrypt': passthrough(secrets['secrets:encrypt']),
    'secrets:decrypt': passthrough(secrets['secrets:decrypt']),

    // --- auto-update (todo32) ---------------------------------------------------
    // Registration-only: state machine + signature-graceful classification live
    // in ../updater.ts. These handlers ack the gesture; every outcome streams on
    // the 'update:state' event (broadcast by index.ts, not ctx.send — the banner
    // is app-level chrome and any frame may see it).
    'update:check': async (args) => {
      const parsed = validatePayload(updateCheckSchema, first(args, {}))
      if (!parsed.ok) return parsed
      const updater = deps.updater?.()
      if (!updater) return NOT_READY
      const reply: UpdateCheckReply = updater.check()
      return reply
    },
    'update:downloadAndInstall': async (args) => {
      const parsed = validatePayload(updateDownloadInstallSchema, first(args, {}))
      if (!parsed.ok) return parsed
      const updater = deps.updater?.()
      if (!updater) return NOT_READY
      const reply: UpdateDownloadInstallReply = updater.downloadAndInstall()
      return reply
    }
  }

  return handlers
}
