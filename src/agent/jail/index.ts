/**
 * Jail API (todo26) - the single surface todo28 codes against.
 *
 * Two tiers behind one JailHandle interface:
 *   1. native-job  : Windows Job Object via koffi FFI (win32.ts) - OS-enforced
 *   2. watchdog    : taskkill /T /F tree-kill (watchdog.ts) - weaker, best effort
 *
 * createJail() returns the native tier or null (with unavailableReason());
 * createJailWithFallback() always returns a usable handle, degrading to the
 * watchdog and reporting the degradation through the onWarning callback.
 */
import { type JailHandle, type JailOptions, type JailUnavailable } from './types'
import * as native from './win32'
import { createWatchdogJail } from './watchdog'

export function isAvailable(): boolean {
  return native.isAvailable()
}

export function unavailableReason(): JailUnavailable | null {
  return native.unavailableReason()
}

/** Native Job Object jail, or null when the native tier is unavailable. */
export function createJail(name = 'local-ai-jail', opts: JailOptions = {}): JailHandle | null {
  return native.createJail(name, opts)
}

/** Always returns a jail: native when available, otherwise the watchdog fallback (warned, never silent). */
export function createJailWithFallback(name = 'local-ai-jail', opts: JailOptions = {}): JailHandle {
  const jail = native.createJail(name, opts)
  if (jail !== null) return jail
  const reason = native.unavailableReason()
  opts.onWarning?.({
    area: 'watchdog',
    message: `native job tier unavailable (${reason === null ? 'unknown' : reason.reason}); degraded to tree-kill watchdog (weaker guarantee: no OS-enforced reaping on parent death)`,
  })
  return createWatchdogJail(name, opts)
}

export { createWatchdogJail } from './watchdog'
export type { JailHandle, JailKind, JailLayout, JailOptions, JailUnavailable, JailWarning, JailWarningArea, ManagedChild } from './types'
