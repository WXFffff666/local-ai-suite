/**
 * Sidecar health monitoring (extracted from SidecarManager in audit fix W0-2
 * so the manager stays a single-purpose lifecycle state machine):
 * 5s pulse / single probe with 2s default timeout / failure counting with a
 * threshold trigger.
 *
 * Ownership gate (audit fix, preserved): if OUR child is gone, any responder
 * on the port is a FOREIGN process — its healthy answer must never count as
 * health for us (e.g. user's standalone Ollama on 11434).
 */

export const HEALTH_INTERVAL_MS = 5_000
export const MAX_FAILURES = 3
export const PROBE_TIMEOUT_MS = 2_000

/** Returns true if the healthUrl answers OK. Injectable for Vitest. */
export type SidecarFetcher = (url: string) => Promise<boolean>

export interface HealthMonitorDeps {
  intervalMs: number
  maxFailures: number
  logger: { write(msg: string, level?: 'info' | 'warn' | 'error'): void; rotateIfNeeded(): void }
  fetcher: SidecarFetcher | undefined
  isRunning: () => boolean
  healthUrl: () => string
  /** Called when failures reach maxFailures; the manager decides restart policy. */
  onThreshold: () => void
}

function unrefTimer(timer: NodeJS.Timeout): void {
  const maybe = timer as unknown as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

export class SidecarHealthMonitor {
  /** Public by design: SidecarManager surfaces it through getStatus(). */
  failures = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: HealthMonitorDeps) {}

  /** Single health probe — returns true if healthy. Triggers onThreshold at the limit. */
  async check(): Promise<boolean> {
    const d = this.deps
    if (!d.isRunning()) {
      d.logger.write(`[health] child not running — foreign port responder ignored (fail ${this.failures + 1}/${d.maxFailures})`, 'warn')
      return this.registerFailure()
    }
    if (await this.probe()) {
      if (this.failures !== 0) d.logger.write('[health] recovered')
      this.failures = 0
      return true
    }
    d.logger.write(`[health] fail ${this.failures + 1}/${d.maxFailures} url=${d.healthUrl()}`, 'warn')
    return this.registerFailure()
  }

  startPulse(): void {
    this.stopPulse()
    this.timer = setInterval(() => {
      void this.check().then(() => this.deps.logger.rotateIfNeeded())
    }, this.deps.intervalMs)
    // Let process exit if only the timer remains
    unrefTimer(this.timer)
  }

  stopPulse(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private registerFailure(): boolean {
    this.failures += 1
    if (this.failures >= this.deps.maxFailures) {
      this.deps.logger.write('[health] threshold reached, restarting', 'error')
      this.deps.onThreshold()
    }
    return false
  }

  private async probe(): Promise<boolean> {
    if (this.deps.fetcher) return this.deps.fetcher(this.deps.healthUrl())
    // Default: fetch with 2s timeout via AbortController
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetch(this.deps.healthUrl(), { signal: ctrl.signal })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(t)
    }
  }
}
