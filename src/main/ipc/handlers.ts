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
import type { ImageJob, ImageJobOptions, QueueEvent } from '../../image/queue'
import type { HfModelCard, SearchOptions } from '../../market/hf'
import { getConfig, setConfig, type AppConfig } from '../storage/config'
import type { Services } from '../services'
import { createDestructiveConfirmHandler, type DialogLike } from '../utils/dialogConfirm'
import { createDeleteWorkspaceHandler } from '../handlers/deleteWorkspace'
import { createOverwriteCoverageHandler } from '../handlers/overwriteCoverage'
import { createPublishReleaseHandler } from '../handlers/publishRelease'
import { createClearCacheHandler } from '../handlers/clearCache'
import type { ChatRelay } from './chatRelay'
import type { DownloadManager } from './downloadManager'
import { createSecretsHandlers, type SafeStorageLike } from './secrets'
import {
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
  imageGenerateSchema,
  imageQueueStatusSchema,
  modelsDownloadSchema,
  modelsSetDirSchema,
  searchRunSchema,
  validatePayload
} from './schemas'
import type { AllowedChannel, ImageQueueStatusEvent, IpcSendFn } from './whitelist'

export type HandlerContext = { send: IpcSendFn }
export type IpcHandler = (args: unknown[], ctx: HandlerContext) => Promise<unknown>
type HandlerMap = Record<AllowedChannel, IpcHandler>

/**
 * The subset of the service container the handlers touch. Method-level Picks
 * keep the type structural (no private members leak), so unit tests can pass
 * plain stub objects while the real Services instance satisfies it as-is.
 */
export type ServicesSurface = {
  registry: Pick<Services['registry'], 'getModels' | 'reloadModels'>
  imageQueue: Pick<Services['imageQueue'], 'enqueue' | 'getJob' | 'listJobs' | 'subscribe' | 'pending'>
  gallery: Pick<Services['gallery'], 'list' | 'save' | 'copy' | 'insert' | 'reuse'>
  search: Pick<Services['search'], 'search'>
  ensureSidecar: Services['ensureSidecar']
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

    // --- image queue -------------------------------------------------------------
    'image:generate': async (args) => {
      const parsed = validatePayload(imageGenerateSchema, first(args))
      if (!parsed.ok) return parsed
      const input = parsed.data
      const opts: ImageJobOptions = { prompt: input.prompt }
      if (input.negative_prompt !== undefined) opts.negative_prompt = input.negative_prompt
      if (input.width !== undefined) opts.width = input.width
      if (input.height !== undefined) opts.height = input.height
      if (input.steps !== undefined) opts.steps = input.steps
      if (input.cfg_scale !== undefined) opts.cfg_scale = input.cfg_scale
      if (input.seed !== undefined) opts.seed = input.seed
      if (input.model !== undefined) opts.model = input.model
      if (input.vramMB !== undefined) opts.vramMB = input.vramMB
      const jobId = services.imageQueue.enqueue(opts)
      const job = services.imageQueue.getJob(jobId)
      return { ok: true, statusCode: 202, jobId, warning: job?.warning, effectiveModel: job?.effectiveModel }
    },
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
    'secrets:decrypt': passthrough(secrets['secrets:decrypt'])
  }

  return handlers
}
