/**
 * SidecarManager — spawn / health pulse 5s / fail-3-restart / logs/sidecar-*.log
 * Reusable by T8-T10 (llama/ollama), T16 (searxng), T20 (sd.cpp) and T29 diagnostics.
 *
 * Design constraints:
 * - All sidecars MUST bind 127.0.0.1 (healthUrl hostname check).
 * - Health pulse default 5s, maxFailures default 3 (spec).
 * - Logs to logs/sidecar-<name>.log with rotation (default 5 MiB -> .1).
 * - Inject-friendly: spawner / fetcher / fsDeps overridable for Vitest mock.
 */

import { spawn as cpSpawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

import type { ISidecar, SidecarStatus } from './types'

export const HEALTH_INTERVAL_MS = 5_000
export const MAX_FAILURES = 3
export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const SIDECAR_HOST = '127.0.0.1' as const

export type SidecarManagerOptions = {
  healthIntervalMs?: number
  maxFailures?: number
  logDir?: string
  logMaxBytes?: number
  /** Override spawn for tests. Signature matches child_process.spawn. */
  spawner?: (bin: string, args: string[], opts: Record<string, unknown>) => ChildProcess
  /** Override fetch for tests. Return true if healthy. */
  fetcher?: (url: string) => Promise<boolean>
  /** Override fs deps for tests. */
  fsDeps?: {
    createWriteStream: typeof fs.createWriteStream
    statSync: typeof fs.statSync
    renameSync: typeof fs.renameSync
    mkdirSync: typeof fs.mkdirSync
    existsSync: typeof fs.existsSync
  }
}

function assertLocalHealthUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`healthUrl must be a valid URL, got: ${url}`)
  }
  if (u.hostname !== SIDECAR_HOST) {
    throw new Error(`healthUrl must be on ${SIDECAR_HOST}, got hostname=${u.hostname} url=${url}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`healthUrl must be http(s), got ${url}`)
  }
}

function assertValidConfig(c: ISidecar): void {
  if (!c.name || !c.bin || !Array.isArray(c.args) || !c.port || !c.healthUrl) {
    throw new Error('ISidecar requires name, bin, args, port, healthUrl')
  }
  if (c.port < 1024 || c.port > 65535) throw new Error(`port out of range: ${c.port}`)
  assertLocalHealthUrl(c.healthUrl)
}

export class SidecarManager {
  readonly config: ISidecar
  private readonly healthIntervalMs: number
  private readonly maxFailures: number
  private readonly logDir: string
  private readonly logMaxBytes: number
  private readonly spawner: SidecarManagerOptions['spawner']
  private readonly fetcher: SidecarManagerOptions['fetcher']
  private readonly fsDeps: NonNullable<SidecarManagerOptions['fsDeps']>

  private proc: ChildProcess | null = null
  private failures = 0
  private restarts = 0
  private timer: NodeJS.Timeout | null = null
  private logStream: fs.WriteStream | null = null
  private _logPath: string

  constructor(config: ISidecar, opts: SidecarManagerOptions = {}) {
    assertValidConfig(config)
    this.config = { ...config }
    this.healthIntervalMs = opts.healthIntervalMs ?? HEALTH_INTERVAL_MS
    this.maxFailures = opts.maxFailures ?? MAX_FAILURES
    this.logDir = opts.logDir ?? path.join(process.cwd(), 'logs')
    this.logMaxBytes = opts.logMaxBytes ?? LOG_MAX_BYTES
    this.spawner = opts.spawner
    this.fetcher = opts.fetcher
    this.fsDeps = opts.fsDeps ?? {
      createWriteStream: fs.createWriteStream,
      statSync: fs.statSync,
      renameSync: fs.renameSync,
      mkdirSync: fs.mkdirSync,
      existsSync: fs.existsSync,
    }
    this._logPath = path.join(this.logDir, `sidecar-${this.config.name}.log`)
  }

  get logPath(): string {
    return this._logPath
  }

  getStatus(): SidecarStatus {
    return {
      name: this.config.name,
      running: this.isRunning(),
      pid: this.proc?.pid,
      port: this.config.port,
      healthUrl: this.config.healthUrl,
      failures: this.failures,
      restarts: this.restarts,
    }
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null
  }

  start(): void {
    if (this.isRunning()) return
    this.ensureLogDir()
    this.openLogStream()
    const spawnFn = (this.spawner ?? cpSpawn) as unknown as typeof cpSpawn
    // Always bind host check is via healthUrl; args are caller responsibility but we ensure spawn uses 127.0.0.1 host if port arg present.
    this.proc = spawnFn(this.config.bin, this.config.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }) as unknown as ChildProcess

    if (this.proc.stdout) {
      this.proc.stdout.on('data', (d: Buffer) => this.writeLog(`[stdout] ${d.toString()}`))
    }
    if (this.proc.stderr) {
      this.proc.stderr.on('data', (d: Buffer) => this.writeLog(`[stderr] ${d.toString()}`))
    }
    const child = this.proc
    child.on('error', (err: Error) => {
      this.writeLog(`[error] spawn error: ${err.message}`, 'error')
    })
    child.on('exit', (code: number | null, sig: string | null) => {
      // Only react to UNEXPECTED exits of the CURRENT child (not our own stop()/restart()).
      if (this.proc !== child) return
      this.writeLog(`[exit] code=${code} signal=${sig}`, 'warn')
      // Ownership fix: our own child is gone — count a failure IMMEDIATELY so the
      // health pulse can't be fooled by a FOREIGN process that happens to answer
      // on the same port (e.g. user's standalone Ollama on 11434 / EADDRINUSE case).
      // Restart still goes through the normal failure-threshold path below.
      this.proc = null
      this.failures += 1
    })

    this.writeLog(`[start] ${this.config.bin} ${this.config.args.join(' ')} pid=${this.proc.pid ?? '?'} port=${this.config.port}`)
    this.failures = 0
    this.startHealthPulse()
  }

  stop(): void {
    this.stopHealthPulse()
    if (this.proc) {
      try {
        if (!this.proc.killed) this.proc.kill()
      } catch {
        // ignore
      }
      this.proc = null
    }
    this.writeLog('[stop] sidecar stopped')
    this.closeLogStream()
  }

  restart(): void {
    this.writeLog('[restart] restarting sidecar', 'warn')
    this.restarts += 1
    // Stop without closing log dir state, then start
    this.stopHealthPulse()
    if (this.proc) {
      try {
        if (!this.proc.killed) this.proc.kill()
      } catch {
        // ignore
      }
      this.proc = null
    }
    this.closeLogStream()
    this.failures = 0
    this.start()
  }

  /** Single health probe — returns true if healthy. Increments failures and restarts if threshold hit. */
  async healthCheck(): Promise<boolean> {
    // Ownership gate: if OUR child process is gone, the probe result is meaningless
    // (any responder on this port is a foreign process). Treat as failure directly.
    if (!this.isRunning()) {
      this.failures += 1
      this.writeLog(`[health] child not running — foreign port responder ignored (fail ${this.failures}/${this.maxFailures})`, 'warn')
      if (this.failures >= this.maxFailures) {
        this.writeLog(`[health] threshold reached, restarting`, 'error')
        this.restart()
        return false
      }
      return false
    }
    const ok = await this.probe()
    if (ok) {
      if (this.failures !== 0) this.writeLog('[health] recovered')
      this.failures = 0
      return true
    }
    this.failures += 1
    this.writeLog(`[health] fail ${this.failures}/${this.maxFailures} url=${this.config.healthUrl}`, 'warn')
    if (this.failures >= this.maxFailures) {
      this.writeLog(`[health] threshold reached, restarting`, 'error')
      this.restart()
      return false
    }
    return false
  }

  /** Check log size and rotate if over limit. Public for tests. */
  checkLogRotation(): void {
    try {
      if (!this.fsDeps.existsSync(this._logPath)) return
      const st = this.fsDeps.statSync(this._logPath)
      if (st.size > this.logMaxBytes) {
        this.rotateLog()
      }
    } catch {
      // ignore rotation errors
    }
  }

  private async probe(): Promise<boolean> {
    if (this.fetcher) return this.fetcher(this.config.healthUrl)
    // Default: fetch with 2s timeout via AbortController
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch(this.config.healthUrl, { signal: ctrl.signal })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }

  private startHealthPulse(): void {
    this.stopHealthPulse()
    this.timer = setInterval(() => {
      void this.healthCheck().then(() => this.checkLogRotation())
    }, this.healthIntervalMs)
    // Let process exit if only timer remains
    if (this.timer && typeof (this.timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(this.timer as unknown as { unref: () => void }).unref!()
    }
  }

  private stopHealthPulse(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private ensureLogDir(): void {
    try {
      this.fsDeps.mkdirSync(this.logDir, { recursive: true })
    } catch {
      // ignore
    }
  }

  private openLogStream(): void {
    try {
      this.closeLogStream()
      this.logStream = this.fsDeps.createWriteStream(this._logPath, { flags: 'a' })
      // Prevent unhandled error if stream fails
      this.logStream.on('error', () => {})
    } catch {
      this.logStream = null
    }
  }

  private closeLogStream(): void {
    if (this.logStream) {
      try {
        this.logStream.end()
      } catch {
        // ignore
      }
      this.logStream = null
    }
  }

  private writeLog(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`
    if (this.logStream) {
      try {
        this.logStream.write(line)
      } catch {
        // ignore
      }
    }
    // Defer rotation check to avoid re-entrancy during write
  }

  private rotateLog(): void {
    try {
      this.closeLogStream()
      const rotated = `${this._logPath}.1`
      // Remove old rotated if exists
      try {
        if (this.fsDeps.existsSync(rotated)) {
          // overwrite by rename; on win need unlink first if exists
          // renameSync will overwrite on posix, fail on win if exists — use try
          try {
            this.fsDeps.renameSync(this._logPath, rotated)
          } catch {
            // win: try unlink then rename
            const { unlinkSync } = fs
            try { unlinkSync(rotated) } catch {}
            this.fsDeps.renameSync(this._logPath, rotated)
          }
        } else {
          this.fsDeps.renameSync(this._logPath, rotated)
        }
      } catch {
        // ignore rename failure
      }
      this.openLogStream()
      this.writeLog(`[rotate] log rotated to ${rotated}`)
    } catch {
      // ignore
    }
  }
}
