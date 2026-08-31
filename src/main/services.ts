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
import { createLlamaSidecar, LLAMA_PORT } from '../sidecars/llama'
import { createOllamaSidecar, OLLAMA_PORT } from '../sidecars/ollama'
import { createSdSidecar, SD_PORT } from '../sidecars/sd'
import { ModelRegistry, type RegistryOptions } from '../models/registry'
import { ImageQueue } from '../image/queue'
import { Gallery } from '../gallery/gallery'
import { SearchOrchestrator, type OrchestratorOptions } from '../search/orchestrator'
import { SearxngAdapter } from '../search/searxng'
import { createCloudAdapters, type CreateCloudAdaptersOptions } from '../search/cloud'

export const SIDECAR_NAMES = ['llama', 'ollama', 'sd'] as const
export type SidecarName = (typeof SIDECAR_NAMES)[number]

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

  async ensureSidecar(name: SidecarName): Promise<SidecarStatus> {
    const inFlight = this.starting.get(name)
    if (inFlight) return inFlight
    const start = this.spawnSidecar(name)
    this.starting.set(name, start)
    return start
  }

  private async spawnSidecar(name: SidecarName): Promise<SidecarStatus> {
    try {
      const manager = this.managers.get(name) ?? this.createManager(name)
      await manager.start()
      this.refreshHandshake()
      return manager.getStatus()
    } finally {
      this.starting.delete(name)
    }
  }

  private createManager(name: SidecarName): SidecarManager {
    const { sidecarOptions = {}, logDir } = this.opts
    const shared = { ...(logDir === undefined ? {} : { logDir }), managerOptions: sidecarOptions }
    let manager: SidecarManager
    switch (name) {
      case 'llama':
        manager = createLlamaSidecar({ port: this.opts.llamaPort, ...shared })
        break
      case 'ollama':
        manager = createOllamaSidecar({
          port: this.opts.ollamaPort,
          ...(this.opts.modelsDir === undefined ? {} : { modelsDir: this.opts.modelsDir }),
          ...shared,
        })
        break
      case 'sd':
        manager = createSdSidecar({ port: this.opts.sdPort, ...shared })
        break
      default: {
        const unreachable: never = name
        throw new Error(`unknown sidecar: ${String(unreachable)}`)
      }
    }
    this.managers.set(name, manager)
    registerShutdownHook(() => manager.stop())
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
