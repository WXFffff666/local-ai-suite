/**
 * SidecarManager — spawn / health pulse 5s / fail-3-restart with capped
 * exponential backoff / logs/sidecar-*.log / pre-spawn port preflight (W0-2).
 * Reusable by T8-T10 (llama/ollama), T16 (searxng), T20 (sd.cpp) and T29 diagnostics.
 *
 * Design constraints:
 * - All sidecars MUST bind 127.0.0.1 (assertValidSidecarConfig on construction).
 * - Health pulse default 5s, maxFailures default 3 (spec).
 * - Restart backoff 500ms·2^(n-1), MAX_RESTARTS=5; on exhaustion the manager
 *   enters the terminal 'failed' state, stops auto-restarting, and emits the
 *   'failed' lifecycle event (onSidecarEvent). Only a new instance recovers.
 * - start() preflights its port (resolveSpawnPort): occupied non-11434 ports
 *   are reallocated in 20000-30000 and carried through config. 11434 is the
 *   fixed public API port and is NEVER reallocated.
 * - Logs to logs/sidecar-<name>.log via SidecarLogger (5 MiB -> .1 rotation).
 * - Inject-friendly: spawner / fetcher / probePort / fsDeps overridable for Vitest.
 */

import { spawn as cpSpawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import {
  probePortFree,
  resolveSpawnPort,
  DYNAMIC_PORT_MAX,
  DYNAMIC_PORT_MIN,
  FIXED_API_PORT,
} from './ports'
import { HEALTH_INTERVAL_MS, MAX_FAILURES, SidecarHealthMonitor } from './sidecarHealth'
import { LOG_MAX_BYTES, SidecarLogger } from './sidecarLogs'
import {
  assertValidSidecarConfig,
  SIDECAR_HOST,
  type ISidecar,
  type PortProbe,
  type SidecarEventListener,
  type SidecarEventType,
  type SidecarManagerOptions,
  type SidecarState,
  type SidecarStatus,
} from './types'

export { HEALTH_INTERVAL_MS, LOG_MAX_BYTES, MAX_FAILURES, SIDECAR_HOST }
export type { PortProbe, SidecarEventListener, SidecarEventType, SidecarManagerOptions }

export const MAX_RESTARTS = 5
export const RESTART_BASE_MS = 500

function unrefTimer(timer: NodeJS.Timeout): void {
  const maybe = timer as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

export class SidecarManager {
  /** Mutable: port preflight may reallocate the port (see resolvePort). */
  config: ISidecar
  private readonly maxRestarts: number
  private readonly restartBaseMs: number
  private readonly dynamicPortRange: readonly [min: number, max: number]
  private readonly spawner: SidecarManagerOptions['spawner']
  private readonly probePort: PortProbe
  private readonly logger: SidecarLogger
  private readonly monitor: SidecarHealthMonitor
  private readonly listeners = new Set<SidecarEventListener>()

  private proc: ChildProcess | null = null
  private restarts = 0
  private backoffTimer: NodeJS.Timeout | null = null
  private state: SidecarState = 'stopped'
  /**
   * Generation counter: stop()/restart() bump it so an in-flight start() that
   * is suspended on the async port preflight cannot resurrect a child the
   * caller has since stopped.
   */
  private opId = 0

  constructor(config: ISidecar, opts: SidecarManagerOptions = {}) {
    assertValidSidecarConfig(config)
    this.config = { ...config }
    this.maxRestarts = opts.maxRestarts ?? MAX_RESTARTS
    this.restartBaseMs = opts.restartBaseMs ?? RESTART_BASE_MS
    this.dynamicPortRange = opts.dynamicPortRange ?? [DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX]
    this.spawner = opts.spawner
    this.probePort = opts.probePort ?? probePortFree
    this.logger = new SidecarLogger({
      name: this.config.name,
      logDir: opts.logDir ?? path.join(process.cwd(), 'logs'),
      maxBytes: opts.logMaxBytes ?? LOG_MAX_BYTES,
      fsDeps: opts.fsDeps ?? {
        createWriteStream: fs.createWriteStream,
        statSync: fs.statSync,
        renameSync: fs.renameSync,
        mkdirSync: fs.mkdirSync,
        existsSync: fs.existsSync,
      },
    })
    this.monitor = new SidecarHealthMonitor({
      intervalMs: opts.healthIntervalMs ?? HEALTH_INTERVAL_MS,
      maxFailures: opts.maxFailures ?? MAX_FAILURES,
      logger: this.logger,
      fetcher: opts.fetcher,
      isRunning: () => this.isRunning(),
      healthUrl: () => this.config.healthUrl,
      onThreshold: () => this.restart(),
    })
  }

  get logPath(): string {
    return this.logger.filePath
  }

  getStatus(): SidecarStatus {
    return {
      name: this.config.name,
      running: this.isRunning(),
      pid: this.proc?.pid,
      port: this.config.port,
      healthUrl: this.config.healthUrl,
      failures: this.monitor.failures,
      restarts: this.restarts,
      state: this.state,
    }
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null
  }

  /** Subscribe to lifecycle events ('restarting' | 'failed'). Returns an unsubscribe fn. */
  onSidecarEvent(listener: SidecarEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async start(): Promise<void> {
    if (this.isRunning()) return
    if (this.state === 'failed') {
      this.logger.write('[start] ignored — failed terminal state', 'warn')
      return
    }
    const op = this.opId
    this.logger.open()
    await this.resolvePort()
    if (op !== this.opId) {
      this.logger.write('[start] superseded by stop()/restart() — spawn skipped')
      this.logger.close()
      return
    }
    if (this.isRunning()) return
    const spawnFn = (this.spawner ?? cpSpawn) as unknown as typeof cpSpawn
    this.proc = spawnFn(this.config.bin, this.config.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }) as unknown as ChildProcess
    this.wireChild(this.proc)

    this.logger.write(`[start] ${this.config.bin} ${this.config.args.join(' ')} pid=${this.proc.pid ?? '?'} port=${this.config.port}`)
    this.monitor.failures = 0
    this.state = 'running'
    this.monitor.startPulse()
  }

  stop(): void {
    this.opId += 1
    this.cancelBackoff()
    this.monitor.stopPulse()
    this.killChild()
    this.logger.write('[stop] sidecar stopped')
    this.logger.close()
    if (this.state !== 'failed') this.state = 'stopped'
  }

  restart(): void {
    this.opId += 1
    this.cancelBackoff()
    if (this.state === 'failed') {
      this.logger.write('[restart] ignored — failed terminal state', 'warn')
      return
    }
    this.monitor.stopPulse()
    this.killChild()
    if (this.restarts >= this.maxRestarts) {
      this.state = 'failed'
      this.logger.write(`[restart] budget exhausted (${this.restarts}/${this.maxRestarts}) — terminal 'failed', auto-restart stopped`, 'error')
      this.logger.close()
      this.emitEvent('failed')
      return
    }
    this.restarts += 1
    const delayMs = this.restartBaseMs * 2 ** (this.restarts - 1)
    this.monitor.failures = 0
    this.state = 'backoff'
    this.logger.write(`[restart] #${this.restarts}/${this.maxRestarts} scheduled in ${delayMs}ms`, 'warn')
    this.logger.close()
    this.emitEvent('restarting')
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      void this.start().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.open()
        this.logger.write(`[restart] start rejected after backoff: ${msg} — terminal 'failed'`, 'error')
        this.logger.close()
        this.state = 'failed'
        this.emitEvent('failed')
      })
    }, delayMs)
    unrefTimer(this.backoffTimer)
  }

  /**
   * Single health probe with ownership gate — see SidecarHealthMonitor.
   * At maxFailures the threshold triggers restart() (backoff-capped).
   */
  healthCheck(): Promise<boolean> {
    return this.monitor.check()
  }

  /** Check log size and rotate if over limit. Public for tests. */
  checkLogRotation(): void {
    this.logger.rotateIfNeeded()
  }

  /**
   * Resolves once the sidecar's log stream has flushed and released its fd.
   * Shutdown hooks await this before removing the log dir so the append
   * handle can't race an rm -rmdir (Windows CI ENOTEMPTY).
   */
  logsIdle(): Promise<void> {
    return this.logger.whenIdle()
  }

  /**
   * Pre-spawn port preflight: keep the configured port when free; never touch
   * 11434; otherwise reallocate from the dynamic range and carry the resolved
   * port through config (port + healthUrl + '--port'-style args tokens).
   */
  private async resolvePort(): Promise<void> {
    const result = await resolveSpawnPort(this.config, this.probePort, this.dynamicPortRange)
    this.config = result.config
    switch (result.action) {
      case 'free':
        break
      case 'kept-fixed-conflict':
        this.logger.write(`[port] ${FIXED_API_PORT} occupied — fixed API port kept, not reallocated (conflict ownership is the caller's)`, 'warn')
        break
      case 'reallocated':
        this.logger.write(`[port] ${result.from} occupied → reallocated dynamic port ${result.to}`, 'warn')
        break
    }
  }

  private wireChild(child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on('data', (d: Buffer) => this.logger.write(`[stdout] ${d.toString()}`))
    }
    if (child.stderr) {
      child.stderr.on('data', (d: Buffer) => this.logger.write(`[stderr] ${d.toString()}`))
    }
    child.on('error', (err: Error) => {
      this.logger.write(`[error] spawn error: ${err.message}`, 'error')
    })
    child.on('exit', (code: number | null, sig: string | null) => {
      // Only react to UNEXPECTED exits of the CURRENT child (not our own stop()/restart()).
      if (this.proc !== child) return
      this.logger.write(`[exit] code=${code} signal=${sig}`, 'warn')
      // Ownership fix: our own child is gone — count a failure IMMEDIATELY so the
      // health pulse can't be fooled by a FOREIGN process that happens to answer
      // on the same port (e.g. user's standalone Ollama on 11434 / EADDRINUSE case).
      // Restart still goes through the normal failure-threshold path.
      this.proc = null
      this.monitor.failures += 1
    })
  }

  private cancelBackoff(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
  }

  private killChild(): void {
    if (!this.proc) return
    try {
      if (!this.proc.killed) this.proc.kill()
    } catch {
      // ignore
    }
    this.proc = null
  }

  private emitEvent(event: SidecarEventType): void {
    const status = this.getStatus()
    for (const listener of [...this.listeners]) {
      try {
        listener(event, status)
      } catch {
        // a broken listener must never break the sidecar lifecycle
      }
    }
  }

}
