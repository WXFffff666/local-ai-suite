/**
 * Port preflight for sidecars (audit fix W0-2 — "僵尸/端口漂移" family).
 *
 * - Before spawning, SidecarManager asks whether its port is actually bindable
 *   on 127.0.0.1; an occupied non-fixed port is reallocated inside the dynamic
 *   range 20000-30000, deterministic-first (name hash) then linear scan.
 * - FIXED_API_PORT (11434) is the public OpenAI-compatible promise: it is NEVER
 *   made dynamic. A conflict there is surfaced to the caller (todo10 owns it),
 *   never silently mutated.
 * - probePortFree is the real net implementation; tests inject a fake probe via
 *   SidecarManagerOptions.probePort (same convention as spawner/fetcher/fsDeps).
 */

import * as net from 'net'

import { SIDECAR_HOST, type ISidecar, type PortProbe } from './types'

/** Public OpenAI-compatible API port — fixed by contract, never dynamically reallocated. */
export const FIXED_API_PORT = 11_434
export const DYNAMIC_PORT_MIN = 20_000
export const DYNAMIC_PORT_MAX = 30_000

// PortProbe lives in ./types (shared vocabulary); re-export for existing importers.
export type { PortProbe }

/**
 * Real implementation: try to exclusively bind 127.0.0.1:port, then release.
 * `exclusive: true` maps to SO_EXCLUSIVEADDRUSE on Windows so a foreign
 * socket with SO_REUSEADDR cannot masquerade the port as free.
 */
export const probePortFree: PortProbe = (host, port) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer()
    let settled = false
    const done = (free: boolean): void => {
      if (settled) return
      settled = true
      resolve(free)
    }
    srv.once('error', () => done(false))
    try {
      srv.listen({ host, port, exclusive: true }, () => {
        srv.close(() => done(true))
      })
    } catch {
      done(false)
    }
  })

/** FNV-1a 32-bit hash of the sidecar name (stable across processes). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The only range/dynamic allocation window: always probed on the loopback interface. */
export type PortRange = readonly [min: number, max: number]
export const DEFAULT_DYNAMIC_RANGE: PortRange = [DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX]

/**
 * Deterministic first dynamic candidate for a name: stable per name so a
 * crashed-and-respawned sidecar re-hits the same port before scanning,
 * reducing port churn between restarts.
 */
export function deterministicPort(name: string, range: PortRange = DEFAULT_DYNAMIC_RANGE): number {
  const [min, max] = range
  return min + (fnv1a(name) % (max - min + 1))
}

/**
 * Find a free dynamic port for `name` (always on 127.0.0.1): probe the
 * deterministic candidate first, then linear-scan forward (wrapping to `min`
 * at `max`). Throws when the whole range is exhausted — an unhandled
 * exhaustion must be loud, not a silent fallback onto someone else's port.
 */
export async function findFreeDynamicPort(
  name: string,
  probe: PortProbe,
  range: PortRange = DEFAULT_DYNAMIC_RANGE,
): Promise<number> {
  const [min, max] = range
  const span = max - min + 1
  const first = deterministicPort(name, range)
  for (let step = 0; step < span; step += 1) {
    const candidate = min + ((first - min + step) % span)
    if (await probe(SIDECAR_HOST, candidate)) return candidate
  }
  throw new Error(`no free dynamic port in ${min}-${max} for sidecar "${name}"`)
}

/**
 * Rewrite a config onto a new port: port, healthUrl port segment, and every
 * args token that equals the old port verbatim (e.g. '--port','11435').
 * ISidecar's shape is untouched — this only changes values inside it.
 */
export function applyPortToConfig(config: ISidecar, newPort: number): ISidecar {
  const oldPortToken = String(config.port)
  let healthUrl = config.healthUrl
  try {
    const u = new URL(config.healthUrl)
    if (u.port) {
      u.port = String(newPort)
      healthUrl = u.toString()
    }
  } catch {
    // assertLocalHealthUrl already validated at construction; keep as-is defensively
  }
  return {
    ...config,
    port: newPort,
    healthUrl,
    args: config.args.map((arg) => (arg === oldPortToken ? String(newPort) : arg)),
  }
}

/** Outcome of the pre-spawn port preflight (SidecarManager logs the note). */
export type PortResolution =
  | { action: 'free'; config: ISidecar }
  | { action: 'kept-fixed-conflict'; config: ISidecar; port: number }
  | { action: 'reallocated'; config: ISidecar; from: number; to: number }

/**
 * Preflight one spawn: keep the configured port when free; NEVER reallocate
 * the fixed API port (11434) — that conflict belongs to the caller (todo10);
 * otherwise reallocate from the dynamic range (deterministic-first, then scan;
 * throws when the range is exhausted).
 */
export async function resolveSpawnPort(
  config: ISidecar,
  probe: PortProbe,
  range: PortRange = DEFAULT_DYNAMIC_RANGE,
): Promise<PortResolution> {
  if (await probe(SIDECAR_HOST, config.port)) return { action: 'free', config }
  if (config.port === FIXED_API_PORT) return { action: 'kept-fixed-conflict', config, port: config.port }
  const previous = config.port
  const next = await findFreeDynamicPort(config.name, probe, range)
  return { action: 'reallocated', config: applyPortToConfig(config, next), from: previous, to: next }
}
