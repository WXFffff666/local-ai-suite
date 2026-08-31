/**
 * sidecars.json handshake file (audit fix W0-2, advisory A2 folded in).
 *
 * The services container (todo7) publishes the live sidecar roster to
 * `<userData>/sidecars.json` so other app windows / dev tools can discover
 * which (possibly dynamically reallocated) port each sidecar ended up on:
 *
 *   { "version": 1, "entries": [ { "name": "llama", "port": 20001, "pid": 4242 } ] }
 *
 * Pure fs — NO electron imports (this module is unit-testable and reusable
 * outside the desktop shell; `app.getPath('userData')` is resolved by the caller).
 * Writes are atomic: serialize to `sidecars.json.<pid>.tmp` then rename over the
 * target (with a Windows unlink-then-retry, mirroring log rotation practice).
 */

import * as fs from 'fs'
import * as path from 'path'

export const SIDECARS_FILENAME = 'sidecars.json' as const
export const HANDSHAKE_VERSION = 1 as const

export interface SidecarEntry {
  name: string
  port: number
  pid: number
}

export interface HandshakeDoc {
  version: typeof HANDSHAKE_VERSION
  entries: SidecarEntry[]
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535
}

function isValidEntry(value: unknown): value is SidecarEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['name'] === 'string' &&
    v['name'].length > 0 &&
    isValidPort(v['port']) &&
    typeof v['pid'] === 'number' &&
    Number.isInteger(v['pid']) &&
    v['pid'] > 0
  )
}

/**
 * Atomically write `<userDataDir>/sidecars.json` (schema v1).
 * Throws on malformed entries (boundary validation) or fs failure.
 */
export function writeSidecarsJson(userDataDir: string, entries: readonly SidecarEntry[]): void {
  for (const entry of entries) {
    if (!isValidEntry(entry)) {
      throw new TypeError(`invalid sidecar handshake entry: ${JSON.stringify(entry)}`)
    }
  }
  const doc: HandshakeDoc = { version: HANDSHAKE_VERSION, entries: [...entries] }
  const target = path.join(userDataDir, SIDECARS_FILENAME)
  fs.mkdirSync(userDataDir, { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    try {
      fs.renameSync(tmp, target)
    } catch (renameErr) {
      // Windows: rename over an existing file can transiently fail (sharing
      // violation); unlink the stale target once, then retry.
      const code = (renameErr as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST') {
        try {
          fs.unlinkSync(target)
        } catch {
          // target may already be gone — retry rename regardless
        }
        fs.renameSync(tmp, target)
      } else {
        throw renameErr
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // tmp already renamed or never created — original error is the one that matters
    }
    throw err
  }
}

/**
 * Read `<userDataDir>/sidecars.json`. Tolerant by design: a missing, corrupt,
 * wrong-version, or partially-malformed handshake file must never crash the
 * consumer — it degrades to fewer/zero entries (the roster is advisory; the
 * authoritative source is SidecarManager.getStatus()).
 */
export function readSidecarsJson(userDataDir: string): SidecarEntry[] {
  const target = path.join(userDataDir, SIDECARS_FILENAME)
  let raw: string
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const doc = parsed as Record<string, unknown>
  if (doc['version'] !== HANDSHAKE_VERSION) return []
  if (!Array.isArray(doc['entries'])) return []
  return doc['entries'].filter(isValidEntry)
}
