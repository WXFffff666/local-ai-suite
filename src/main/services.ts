/**
 * Main-process service container (todo7) - lazy singleton wiring every capability module.
 *
 * Invariants enforced here:
 * - Zero import-time side effects. The singleton is built on the first
 *   {@link getServices} call, which src/main/index.ts performs after app.whenReady.
 * - Startup spawns nothing: the llama/ollama/sd managers are created AND spawned
 *   only when {@link Services.ensureSidecar} is first asked for that name.
 * - Every owned resource registers its own stop hook with ./shutdown (LIFO,
 *   3s-bounded): manager.stop(), registry.close(), image-job cancellation,
 *   and a final sidecars.json handshake write (the hook registered here runs
 *   last because it is registered first).
 * - sidecars.json is written from live getStatus() ports, so dynamically
 *   reallocated ports (W0-2 preflight) are what consumers discover.
 * - No electron top-level import: userDataDir/modelsDir defaults mirror
 *   ./storage/config.ts (dynamic require, cwd fallback under tests).
 */

import { join } from 'path'
import { registerShutdownHook } from './shutdown'
import { getConfig } from './storage/config'
import { writeSidecarsJson, type SidecarEntry } from '../core/handshake'
import { SidecarManager, type SidecarManagerOptions } from '../core/SidecarManager'
import type { ISearchAdapter, SidecarEventListener, SidecarStatus } from '../core/types'
import { buildLlamaArgs, createLlamaSidecar, LLAMA_PORT } from '../sidecars/llama'
import { createOllamaSidecar, OLLAMA_PORT } from '../sidecars/ollama'
import { buildSdArgs, createSdSidecar, SD_PORT } from '../sidecars/sd'
import { ModelRegistry, type RegistryOptions } from '../models/registry'
import { ImageQueue } from '../image/queue'
import { createSdJobHandler, pickDiffusionModel } from '../image/executor'
import { Gallery } from '../gallery/gallery'
import { SearchOrchestrator, type OrchestratorOptions } from '../search/orchestrator'
import { SearxngAdapter } from '../search/searxng'
import { createCloudAdapters, type CreateCloudAdaptersOptions } from '../search/cloud'
import { loadEngineManifest, type ManifestLoad } from '../engines/manifest'
import {
  createResolver,
  manifestDeps,
  type EngineResolver,
  type ResolvedEngine,
} from '../engines/resolver'

export const SIDECAR_NAMES = ['llama', 'ollama', 'sd'] as const
export type SidecarName = (typeof SIDECAR_NAMES)[number]

/**
 * todo21 last hop: model + paired projector injected into the llama sidecar.
 * Routed through buildLlamaArgs ({modelPath, mmprojPath} → --model/--mmproj).
 * todo39 adds the two capability flags (embeddings/rerank); launchModel
 * derives them from the registry entry (embedding GGUFs live under
 * models/embedding/** or carry embed/rerank name tokens — README layout).
 */
export type LlamaLaunchOptions = {
  modelPath?: string
  mmprojPath?: string
  /** --embeddings: serve /v1/embeddings from this instance (RAG internal arm). */
  embeddings?: boolean
  /** --rerank: serve /v1/rerank (llama.cpp default is OFF — flag required). */
  rerank?: boolean
}

/** Registry-entry -> llama-server capability flags (todo39 launch glue). */
export function llamaServeFlags(entry: Pick<import('../models/registry').ModelEntry, 'name' | 'file'>): {
  embeddings?: boolean
  rerank?: boolean
} {
  // 'embedding/<dir>' (README layout) or an 'embed'/'rerank' name token, each
  // matched at a word boundary so qwen3-4b / llama3 never trip the detector.
  const hay = `${entry.file} ${entry.name}`.toLowerCase()
  if (/\brerank/.test(hay)) return { rerank: true }
  if (/(^|[\/\s._-])embed(ding|ings|s|ed)?([\/\s._-]|$)/.test(hay)) return { embeddings: true }
  return {}
}

/** sd 侧车启动参数（阶段0 生图接线）：模型路径切换时同端口重建 argv 并重启子进程。 */
export type SdLaunchOptions = {
  modelPath?: string
}

export type ServicesOptions = {
  /** dir holding sidecars.json; default app.getPath('userData'), fallback <cwd>/userData */
  userDataDir?: string
  /** models root watched by the registry; default getConfig().modelsDir */
  modelsDir?: string
  /** gallery base dir (Gallery appends gallery/); default <cwd> */
  galleryBaseDir?: string
  /** sidecar log dir; default the factories' <cwd>/logs */
  logDir?: string
  llamaPort?: number
  ollamaPort?: number
  sdPort?: number
  /** DI forwarded to every SidecarManager (spawner/fetcher/probePort/fsDeps/...). */
  sidecarOptions?: Omit<SidecarManagerOptions, 'logDir'>
  /** DI forwarded to ModelRegistry (watcherFactory in tests). */
  registryOptions?: RegistryOptions
  /** full override of the search source list (tested composition seam). */
  searchAdapters?: Pick<ISearchAdapter, 'search'>[]
  cloudAdapterOptions?: CreateCloudAdaptersOptions
  orchestratorOptions?: OrchestratorOptions
  /** sink for isolated failures (handshake writes, search sources); default console.warn */
  warn?: (message: string, error: unknown) => void
  /** DI seam: engine manifest load (todo30). Default reads extraResources/build/. */
  engineManifestLoad?: ManifestLoad
  /** DI seam: whole resolver override (tests); null = resolver consultation OFF. */
  engineResolver?: EngineResolver | null
}

type ResolvedOptions = ServicesOptions &
  Required<Pick<ServicesOptions, 'userDataDir' | 'llamaPort' | 'ollamaPort' | 'sdPort'>>

function resolveUserDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath: (name: string) => string } }
    const userData = electron?.app?.getPath?.('userData')
    if (userData) return userData
  } catch {
    // electron unavailable (vitest) - fall through to the cwd fallback
  }
  return join(process.cwd(), 'userData')
}

/** Reads AppConfig only for the defaults the caller did not inject. */
function resolveOptions(opts: ServicesOptions): ResolvedOptions {
  const needsConfig =
    opts.modelsDir === undefined || opts.llamaPort === undefined || opts.ollamaPort === undefined
  const cfg = needsConfig ? getConfig() : undefined
  return {
    ...opts,
    userDataDir: opts.userDataDir ?? resolveUserDataDir(),
    modelsDir: opts.modelsDir ?? cfg?.modelsDir,
    // AppConfig has no sdPort — 11436 is the sd factory constant itself.
    llamaPort: opts.llamaPort ?? cfg?.llamaPort ?? LLAMA_PORT,
    ollamaPort: opts.ollamaPort ?? cfg?.ollamaPort ?? OLLAMA_PORT,
    sdPort: opts.sdPort ?? SD_PORT,
  }
}

export class Services {
  readonly userDataDir: string
  private readonly warn: (message: string, error: unknown) => void
  private readonly managers = new Map<SidecarName, SidecarManager>()
  private readonly starting = new Map<SidecarName, Promise<SidecarStatus>>()
  private readonly bufferedListeners = new Map<SidecarName, Set<SidecarEventListener>>()
  private registryInstance: ModelRegistry | null = null
  private imageQueueInstance: ImageQueue | null = null
  private galleryInstance: Gallery | null = null
  private searchInstance: SearchOrchestrator | null = null
  /** Lazily built detection-first engine resolver (todo30). */
  private engineResolverInstance: EngineResolver | null = null
  /** Last-asked llama model+projector; consumed at (re)spawn (todo21 last hop). */
  private llamaLaunch: LlamaLaunchOptions = {}
  /** Last-asked sd diffusion model; consumed at (re)spawn (阶段0 生图接线). */
  private sdLaunch: SdLaunchOptions = {}
  /** Resolver outcomes by consulted engine name (availability for UI). */
  private readonly engineSources = new Map<SidecarName, ResolvedEngine>()

  /**
   * The engine resolver, built once from the distribution manifest. Exposed so
   * the settings UI (lane-30b) can render the availability matrix and the GPU
   * download flow can consume `manifestDeps`. `opts.engineResolver` overrides
   * (tests); explicit `null` disables consultation (env-only legacy behavior).
   */
  get engineResolver(): EngineResolver | null {
    if (this.opts.engineResolver !== undefined) return this.opts.engineResolver
    if (this.engineResolverInstance === null) {
      const load = this.opts.engineManifestLoad ?? loadEngineManifest()
      if (load.status === 'absent') {
        // plan r2: dev-missing manifest degrades to warn + pass, never bricks engines.
        for (const warning of load.warnings) this.warn(warning, undefined)
      } else if (load.status === 'invalid') {
        this.warn(`engine manifest invalid at ${load.path}: ${load.errors.join('; ')}`, undefined)
      }
      this.engineResolverInstance = createResolver(manifestDeps(load, this.userDataDir))
    }
    return this.engineResolverInstance
  }

  constructor(private readonly opts: ResolvedOptions) {
    this.userDataDir = opts.userDataDir
    this.warn =
      opts.warn ??
      ((message: string, error: unknown): void => {
        console.warn(`[services] ${message}`, error)
      })
    // Registered FIRST so it runs LAST in LIFO: the final roster reflects every
    // stop hook already applied (stopped managers drop out of the roster).
    registerShutdownHook(() => {
      this.refreshHandshake()
    })
  }

  // --- model registry (chokidar watch starts with the instance) --------------

  get registry(): ModelRegistry {
    if (this.registryInstance === null) {
      const registry = new ModelRegistry(
        this.opts.modelsDir ?? join(process.cwd(), 'models'),
        this.opts.registryOptions ?? {},
      )
      this.registryInstance = registry
      registerShutdownHook(() => registry.close())
      void registry.startWatch()
    }
    return this.registryInstance
  }

  get imageQueue(): ImageQueue {
    if (this.imageQueueInstance === null) {
      const queue = new ImageQueue({ concurrency: 1, defaultMaxRetries: 2, defaultBackoffMs: 400 })
      // 阶段0 生图接线：注入真实 sd 执行器（此前为 queue.ts 默认 mock，
      // UI 生图永远得到非 PNG 结果）。执行器按 job.model 从注册表解析
      // models/diffusion/** 模型，ensureSidecar('sd') 拉起侧车后 POST /generate。
      queue.setHandler(
        createSdJobHandler({
          resolveModel: (requested) => pickDiffusionModel(this.registry.getModels(), requested),
          ensureSd: async (o) => {
            const status = await this.ensureSidecar('sd', o.modelPath === undefined ? {} : { modelPath: o.modelPath })
            return { port: status.port }
          },
        }),
      )
      this.imageQueueInstance = queue
      registerShutdownHook(() => {
        for (const job of queue.listJobs()) {
          if (job.status === 'queued' || job.status === 'running') queue.cancel(job.id)
        }
      })
    }
    return this.imageQueueInstance
  }

  get gallery(): Gallery {
    this.galleryInstance ??= new Gallery(this.opts.galleryBaseDir)
    return this.galleryInstance
  }

  /** SearXNG (offline default) first, then configured cloud adapters. */
  get search(): SearchOrchestrator {
    if (this.searchInstance === null) {
      const sources =
        this.opts.searchAdapters ??
        ([
          new SearxngAdapter(),
          ...createCloudAdapters({ hideUnconfigured: true, ...this.opts.cloudAdapterOptions }),
        ] as Pick<ISearchAdapter, 'search'>[])
      const composite: Pick<ISearchAdapter, 'search'> = {
        search: async (query, searchOpts) => {
          for (const source of sources) {
            try {
              const items = await source.search?.(query, searchOpts)
              if (items && items.length > 0) return items
            } catch (error) {
              this.warn(`search source failed: ${error instanceof Error ? error.message : String(error)}`, error)
            }
          }
          return []
        },
      }
      this.searchInstance = new SearchOrchestrator(composite, this.opts.orchestratorOptions ?? {})
    }
    return this.searchInstance
  }

  // --- sidecars: lazy per name, spawn only on first ensure --------------------

  getSidecar(name: SidecarName): SidecarManager | undefined {
    return this.managers.get(name)
  }

  sidecarStatuses(): SidecarStatus[] {
    return [...this.managers.values()].map((manager) => manager.getStatus())
  }

  /** Latest engine-resolution outcomes per consulted sidecar (UI: lane-30b). */
  getEngineResolutions(): ResolvedEngine[] {
    return [...this.engineSources.values()]
  }

  /**
   * Ensure a sidecar runs. Launch options: 'llama' carries model+projector
   * (todo21); 'sd' carries the diffusion modelPath (阶段0 生图接线). Re-asking
   * with a different model while running swaps argv and restarts the child
   * (same manager, port kept).
   */
  async ensureSidecar(
    name: SidecarName,
    launch?: LlamaLaunchOptions | SdLaunchOptions,
  ): Promise<SidecarStatus> {
    if (launch !== undefined) {
      if (name === 'llama') {
        this.llamaLaunch = launch
        const manager = this.managers.get(name)
        if (manager !== undefined) {
          const inFlight = this.starting.get(name)
          if (inFlight) await inFlight
          return this.applyLlamaArgs(manager)
        }
      } else if (name === 'sd') {
        this.sdLaunch = launch as SdLaunchOptions
        const manager = this.managers.get(name)
        if (manager !== undefined) {
          const inFlight = this.starting.get(name)
          if (inFlight) await inFlight
          return this.applySdArgs(manager)
        }
      } else {
        throw new Error('launch options are only supported for the llama/sd sidecar')
      }
    }
    const inFlight = this.starting.get(name)
    if (inFlight) return inFlight
    const start = this.spawnSidecar(name)
    this.starting.set(name, start)
    return start
  }

  /** Load a registered model into the llama sidecar (internal API, channels come in lane-30b). */
  async launchModel(modelId: string): Promise<SidecarStatus> {
    const entry =
      this.registry.getModels().find((m) => m.name === modelId) ??
      this.registry.reloadModels().find((m) => m.name === modelId)
    if (entry === undefined) throw new Error(`model not found: ${modelId}`)
    if (entry.corrupted === true) throw new Error(`model corrupted: ${modelId} (${entry.error ?? 'probe failed'})`)
    if (entry.format !== 'gguf') throw new Error(`model not launchable by llama engine: ${modelId} (${entry.format})`)
    return this.ensureSidecar('llama', {
      modelPath: entry.path,
      ...(entry.projectorPath === undefined ? {} : { mmprojPath: entry.projectorPath }),
      ...llamaServeFlags(entry),
    })
  }

  /** Rebuild llama argv on the live manager; restart the child when it changed. */
  private applyLlamaArgs(manager: SidecarManager): SidecarStatus {
    const args = buildLlamaArgs({ ...this.llamaLaunch, port: manager.config.port })
    const changed = JSON.stringify(args) !== JSON.stringify(manager.config.args)
    if (changed) {
      manager.config.args = args
      if (manager.isRunning()) {
        manager.stop()
        void manager.start().catch((error: unknown) => {
          this.warn(`llama restart after model switch failed: ${error instanceof Error ? error.message : String(error)}`, error)
        })
      }
    }
    return manager.getStatus()
  }

  /** sd 侧车镜像 applyLlamaArgs：模型切换 → 重建 argv → 原端口重启（阶段0）。 */
  private applySdArgs(manager: SidecarManager): SidecarStatus {
    const args = buildSdArgs({ modelPath: this.sdLaunch.modelPath, port: manager.config.port })
    const changed = JSON.stringify(args) !== JSON.stringify(manager.config.args)
    if (changed) {
      manager.config.args = args
      if (manager.isRunning()) {
        manager.stop()
        void manager.start().catch((error: unknown) => {
          this.warn(`sd restart after model switch failed: ${error instanceof Error ? error.message : String(error)}`, error)
        })
      }
    }
    return manager.getStatus()
  }

  private async spawnSidecar(name: SidecarName): Promise<SidecarStatus> {
    try {
      const manager = this.managers.get(name) ?? (await this.createManager(name))
      await manager.start()
      this.refreshHandshake()
      return manager.getStatus()
    } finally {
      this.starting.delete(name)
    }
  }

  /**
   * Bin precedence (todo30): explicit <X>_BIN env wins (factory path preserved
   * verbatim); otherwise the detection-first resolver cascade
   * system PATH -> extraResources CPU -> active GPU pack; 'none' keeps the
   * factory default (bare command name).
   */
  private envBinVar(name: SidecarName): 'LLAMA_BIN' | 'OLLAMA_BIN' | 'SD_BIN' {
    return name === 'llama' ? 'LLAMA_BIN' : name === 'ollama' ? 'OLLAMA_BIN' : 'SD_BIN'
  }

  private async sidecarBin(name: SidecarName): Promise<string | undefined> {
    const envVal = process.env[this.envBinVar(name)]
    if (envVal !== undefined && envVal.trim() !== '') return undefined // factory keeps the env override
    const resolver = this.engineResolver
    if (resolver === null) return undefined
    const resolved = await resolver.resolve(name)
    this.engineSources.set(name, resolved)
    return resolved.bin ?? undefined
  }

  private async createManager(name: SidecarName): Promise<SidecarManager> {
    const { sidecarOptions = {}, logDir } = this.opts
    const shared = { ...(logDir === undefined ? {} : { logDir }), managerOptions: sidecarOptions }
    const bin = await this.sidecarBin(name)
    let manager: SidecarManager
    switch (name) {
      case 'llama':
        manager = createLlamaSidecar({
          port: this.opts.llamaPort,
          ...(bin === undefined ? {} : { bin }),
          ...(this.llamaLaunch.modelPath === undefined ? {} : { modelPath: this.llamaLaunch.modelPath }),
          ...(this.llamaLaunch.mmprojPath === undefined ? {} : { mmprojPath: this.llamaLaunch.mmprojPath }),
          ...(this.llamaLaunch.embeddings === undefined ? {} : { embeddings: this.llamaLaunch.embeddings }),
          ...(this.llamaLaunch.rerank === undefined ? {} : { rerank: this.llamaLaunch.rerank }),
          ...shared,
        })
        break
      case 'ollama':
        manager = createOllamaSidecar({
          port: this.opts.ollamaPort,
          ...(bin === undefined ? {} : { bin }),
          ...(this.opts.modelsDir === undefined ? {} : { modelsDir: this.opts.modelsDir }),
          ...shared,
        })
        break
      case 'sd':
        manager = createSdSidecar({
          port: this.opts.sdPort,
          ...(bin === undefined ? {} : { bin }),
          ...(this.sdLaunch.modelPath === undefined ? {} : { modelPath: this.sdLaunch.modelPath }),
          ...shared,
        })
        break
      default: {
        const unreachable: never = name
        throw new Error(`unknown sidecar: ${String(unreachable)}`)
      }
    }
    this.managers.set(name, manager)
    // stop() closes the log append stream (end → async flush → 'close' releases
    // the fd). Await logsIdle so shutdownServices() does not resolve while the
    // sidecar-<name>.log handle is still open — otherwise a caller removing the
    // log dir (test teardown) races ENOTEMPTY on Windows CI runners.
    registerShutdownHook(async () => {
      manager.stop()
      await manager.logsIdle()
    })
    // one dispatcher per manager reading the live listener set: subscriptions
    // made before creation (buffered) and afterwards share the same path
    manager.onSidecarEvent((event, status) => {
      for (const listener of [...(this.bufferedListeners.get(name) ?? [])]) listener(event, status)
    })
    // keep the advisory roster fresh across restarts/failures
    manager.onSidecarEvent(() => {
      this.refreshHandshake()
    })
    return manager
  }

  /** Subscribe before or after the manager exists - buffered until creation. */
  onSidecarEvent(name: SidecarName, listener: SidecarEventListener): () => void {
    const set = this.bufferedListeners.get(name) ?? new Set<SidecarEventListener>()
    this.bufferedListeners.set(name, set)
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  // --- handshake (advisory roster in <userData>/sidecars.json) ----------------

  refreshHandshake(): SidecarEntry[] {
    const entries: SidecarEntry[] = []
    for (const manager of this.managers.values()) {
      const status = manager.getStatus()
      if (status.running && status.pid !== undefined) {
        entries.push({ name: status.name, port: status.port, pid: status.pid })
      }
    }
    try {
      writeSidecarsJson(this.userDataDir, entries)
    } catch (error) {
      // the handshake is advisory - a failed write must never crash the main process
      this.warn(`sidecars.json write failed: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    return entries
  }
}

let instance: Services | null = null

/** Lazy singleton: created on first access (after app.whenReady via initServices). */
export function getServices(options?: ServicesOptions): Services {
  instance ??= new Services(resolveOptions(options ?? {}))
  return instance
}

/**
 * Non-blocking startup wiring (index.ts, after whenReady): creates the
 * singleton, starts the model watch, publishes the initial (empty) roster.
 * Spawns no sidecar. Rejects only on a hard container failure so the caller
 * can log via the main logger.
 */
export async function initServices(options: ServicesOptions = {}): Promise<Services> {
  const services = getServices(options)
  void services.registry
  services.refreshHandshake()
  return services
}

/** Test-only singleton reset (mirrors resetShutdownState). */
export function resetServices(): void {
  instance = null
}
