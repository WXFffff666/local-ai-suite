/**
 * Unified shutdown-hook registry for the Electron main process (audit fix: zombie
 * sidecars on quit — see plan W0-1).
 *
 * Services (todo7's container: sidecar managers, servers, watchers) register their
 * stop functions here via {@link registerShutdownHook}. `before-quit` / `will-quit`
 * in src/main/index.ts funnel into {@link shutdownServices}, which:
 *
 * - runs hooks in LIFO order (last started = first stopped), sequentially;
 * - bounds every hook with a per-hook timeout (default 3s) so a hung hook can never
 *   block app termination;
 * - is idempotent: the first call owns the run, later calls await the same promise;
 * - never rejects — failures are reported via {@link ShutdownResult.errors}.
 */

export const DEFAULT_HOOK_TIMEOUT_MS = 3000

export type ShutdownHook = () => void | Promise<void>

/** Raised when a single hook exceeds its timeout budget. */
export class ShutdownHookTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`shutdown hook timed out after ${timeoutMs}ms`)
    this.name = 'ShutdownHookTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface ShutdownFailure {
  /** Position of the failed hook in LIFO execution order (0 = last registered). */
  readonly hookIndex: number
  readonly timeoutMs: number
  readonly reason: unknown
}

export interface ShutdownResult {
  readonly errors: readonly ShutdownFailure[]
}

const hooks: ShutdownHook[] = []
let activeRun: Promise<ShutdownResult> | null = null

export function registerShutdownHook(fn: ShutdownHook): void {
  hooks.push(fn)
}

/**
 * Run all registered shutdown hooks (LIFO, sequential, per-hook timeout).
 * Idempotent: concurrent and subsequent calls return the first call's promise.
 */
export function shutdownServices(
  hookTimeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS
): Promise<ShutdownResult> {
  activeRun ??= runHooks(hookTimeoutMs)
  return activeRun
}

async function runHooks(hookTimeoutMs: number): Promise<ShutdownResult> {
  const errors: ShutdownFailure[] = []
  const ordered = [...hooks].reverse()
  for (let i = 0; i < ordered.length; i += 1) {
    const hook = ordered[i]
    if (hook === undefined) continue
    try {
      await withTimeout(Promise.resolve().then(() => hook()), hookTimeoutMs)
    } catch (reason) {
      // Expected path: a failing/timed-out hook must not abort the remaining
      // cleanup. The reason is surfaced to the caller (index.ts logs it via the
      // main logger) instead of being swallowed here.
      errors.push({ hookIndex: i, timeoutMs: hookTimeoutMs, reason })
    }
  }
  return { errors }
}

function withTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ShutdownHookTimeoutError(timeoutMs)), timeoutMs)
    // The guard must never keep the event loop alive on its own.
    timer.unref()
  })
  return Promise.race([task, guard]).finally(() => clearTimeout(timer))
}

/** Test-only state reset (mirrors resetConfig() in main/storage/config.ts). */
export function resetShutdownState(): void {
  hooks.length = 0
  activeRun = null
}
