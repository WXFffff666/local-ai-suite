/**
 * service.ts — WhisperService: owns the whisper-server SidecarManager
 * (todo36). Deliberately NOT in src/main/services.ts: that container is the
 * llama/ollama/sd lane (SidecarName union) and the engines resolver only knows
 * EngineBinary = llama|ollama|sd — whisper is a manifest-only optional engine
 * (manifest.ts MANIFEST_ENGINES comment: "todo36 consumes it"). This module is
 * the consumer: same SidecarManager lifecycle machinery (spawn / port
 * preflight / 5s pulse / backoff), same bin-precedence shape
 * (WHISPER_BIN env > manifest-pinned bundled exe), serial request queue.
 *
 * Lazy contract: NOTHING spawns until the first transcribe(); getStatus() is
 * side-effect free (e2e zero-external + chat mount depend on that).
 */

import { readFile } from 'fs/promises'
import { createHash } from 'crypto'

import { SidecarManager } from '../core/SidecarManager'
import type { SidecarManagerOptions, SidecarStatus } from '../core/types'
import { loadEngineManifest } from '../engines/manifest'
import { registerShutdownHook } from '../main/shutdown'
import {
  buildWhisperArgs,
  getHealthUrl,
  resolveWhisperEngine,
  transcribeWav,
  whisperError,
  WHISPER_NAME,
  WHISPER_PORT,
  type FetchLike,
  type TranscribeRequest,
  type WhisperEngineResolution,
} from './whisper'

export type WhisperServiceDeps = {
  env?: Record<string, string | undefined>
  resourcesPath?: string
  cwd?: string
  logDir?: string
  /** manifest load seam (tests); default = loadEngineManifest() */
  manifestLoad?: ReturnType<typeof loadEngineManifest> | null
  /** SidecarManager DI (spawner/fetcher/probePort in tests). */
  managerOptions?: Omit<SidecarManagerOptions, 'logDir'>
  fetchImpl?: FetchLike
  /** ms between /health polls after start; 503 (loading model) stays "alive". */
  healthPollMs?: number
  /** total /health wait budget (model load is slow on big ggml models). */
  healthWaitMs?: number
  /** inference wall-clock cap per request (long recordings). */
  transcribeTimeoutMs?: number
}

export type WhisperServiceStatus = {
  engine: WhisperEngineResolution
  running: boolean
  port: number
  state: SidecarStatus['state']
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class WhisperService {
  private manager: SidecarManager | null = null
  private shaCheckedFor: string | null = null
  /** serializes /inference (server holds a model mutex anyway) + start race. */
  private tail: Promise<unknown> = Promise.resolve()
  private readonly deps: WhisperServiceDeps

  constructor(deps: WhisperServiceDeps = {}) {
    this.deps = deps
  }

  /** Side-effect free: resolves the engine, reports manager state if started. */
  status(): WhisperServiceStatus {
    const engine = this.resolveEngine()
    const manager = this.manager
    if (manager === null) {
      return { engine, running: false, port: WHISPER_PORT, state: 'stopped' }
    }
    const s = manager.getStatus()
    return { engine, running: s.running, port: s.port, state: s.state }
  }

  stop(): void {
    this.manager?.stop()
  }

  /** Queue a transcription; rejects with typed codes the IPC layer maps. */
  transcribe(req: TranscribeRequest & { modelPath: string }): Promise<string> {
    const run = this.tail.then(() => this.transcribeNow(req))
    // keep the chain alive regardless of the outcome (SdQueue pattern)
    this.tail = run.catch(() => undefined)
    return run
  }

  // --- internals -------------------------------------------------------------

  private resolveEngine(): WhisperEngineResolution {
    const load = this.deps.manifestLoad ?? loadEngineManifest()
    const spec = load.status === 'ok' ? load.manifest.engines[WHISPER_NAME] : undefined
    return resolveWhisperEngine({
      ...(this.deps.env === undefined ? {} : { env: this.deps.env }),
      ...(this.deps.resourcesPath === undefined ? {} : { resourcesPath: this.deps.resourcesPath }),
      cwd: this.deps.cwd ?? process.cwd(),
      bundled: spec ? { file: spec.cpu.file, sha256: spec.cpu.sha256 } : null,
    })
  }

  private async shaOk(path: string, expected: string): Promise<boolean> {
    const buf = await readFile(path)
    return createHash('sha256').update(buf).digest('hex') === expected
  }

  private getManager(engine: WhisperEngineResolution, modelPath: string): SidecarManager {
    if (engine.bin === null) throw whisperError('whisper engine binary not found')
    if (this.manager === null) {
      const bin = engine.bin
      const config = {
        name: WHISPER_NAME,
        bin,
        args: buildWhisperArgs({ modelPath, port: WHISPER_PORT }),
        port: WHISPER_PORT,
        healthUrl: getHealthUrl(WHISPER_PORT),
      }
      this.manager = new SidecarManager(config, {
        ...(this.deps.logDir === undefined ? {} : { logDir: this.deps.logDir }),
        ...(this.deps.managerOptions ?? {}),
        // 503 = model still loading: the child is ALIVE — never restart on it.
        fetcher: this.deps.managerOptions?.fetcher ?? ((url: string) => this.healthAlive(url)),
      })
      registerShutdownHook(() => this.manager?.stop())
    } else if (JSON.stringify(this.manager.config.args) !== JSON.stringify(buildWhisperArgs({ modelPath, port: this.manager.config.port }))) {
      // model switched since last spawn: swap argv, restart the child.
      this.manager.config.args = buildWhisperArgs({ modelPath, port: this.manager.config.port })
      if (this.manager.isRunning()) {
        this.manager.stop()
      }
    }
    return this.manager
  }

  /** raw /health status (0 = unreachable). */
  private async healthStatus(url: string): Promise<number> {
    try {
      const doFetch = this.deps.fetchImpl ?? (fetch as unknown as FetchLike)
      const res = await doFetch(url)
      return res.status
    } catch {
      return 0
    }
  }

  /**
   * Pulse liveness: 200 ready OR 503 model-loading — the child is alive in
   * both cases; only unreachable counts toward the restart threshold.
   */
  private async healthAlive(url: string): Promise<boolean> {
    const s = await this.healthStatus(url)
    return s === 200 || s === 503
  }

  private async ensureHealthy(manager: SidecarManager): Promise<void> {
    const pollMs = this.deps.healthPollMs ?? 500
    const budget = this.deps.healthWaitMs ?? 120_000
    const deadline = Date.now() + budget
    for (;;) {
      // readiness gate: 200 only (503 = still loading, keep waiting)
      if ((await this.healthStatus(manager.config.healthUrl)) === 200) return
      if (Date.now() >= deadline) {
        throw whisperError(`whisper server not healthy within ${budget}ms`)
      }
      await sleep(pollMs)
    }
  }

  private async transcribeNow(req: TranscribeRequest & { modelPath: string }): Promise<string> {
    if (!req.modelPath) throw whisperError('whisper model not configured')
    const engine = this.resolveEngine()
    if (engine.bin === null) throw whisperError('whisper engine binary not found — check Settings → Speech')
    if (engine.source === 'bundled' && engine.expectedSha256 && this.shaCheckedFor !== engine.bin) {
      if (!(await this.shaOk(engine.bin, engine.expectedSha256))) {
        throw whisperError(`bundled whisper engine failed sha256 verification (${engine.bin})`)
      }
      this.shaCheckedFor = engine.bin
    }
    const manager = this.getManager(engine, req.modelPath)
    await manager.start()
    await this.ensureHealthy(manager)
    const timeoutMs = this.deps.transcribeTimeoutMs ?? 300_000
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      return await transcribeWav(manager.getStatus().port, req, {
        ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
        signal: ctrl.signal,
      })
    } catch (error) {
      if (ctrl.signal.aborted) throw whisperError(`whisper transcription timed out after ${timeoutMs}ms`)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

let instance: WhisperService | null = null

/** Process singleton (main side). Lazy: construction spawns nothing. */
export function getWhisperService(deps?: WhisperServiceDeps): WhisperService {
  instance ??= new WhisperService(deps ?? {})
  return instance
}

/** Test seam. */
export function resetWhisperService(): void {
  instance?.stop()
  instance = null
}
