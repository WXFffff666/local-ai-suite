/**
 * models:download session runner (plan W1-8, extended by todo14b).
 *
 * Wraps src/market/hf.ts downloadWithResume (huggingface-cli / aria2c child
 * process, resume-by-default) in an id-keyed session that emits the
 * 'download:progress' event {id, repoId, received, total, state}.
 *
 * Byte totals: hf.ts spawns with stdio 'inherit' and exposes no progress hook,
 * so 'received' is the observed on-disk size of localDir polled on an interval
 * and 'total' stays 0 until the child exits successfully — then total ===
 * received (terminal sample).
 *
 * todo14b additions:
 * - cancel(id): tree-kills the registered hf.ts child (via the module handle
 *   map), clears the poll timer and emits the terminal state 'cancelled'.
 * - disk pre-flight: when the caller supplies expectedBytes (Market UI passes
 *   the byte budget from the HF file size), fs.statfs checks the nearest
 *   existing ancestor of localDir; free < expectedBytes * 1.1 → the download
 *   is refused up-front with {ok:false, error:'insufficient-disk', free, needed}
 *   and no child process is spawned. Unknown size → check skipped (honest:
 *   HfModelCard.sizeLabel is a display string, not bytes).
 */

import * as fs from 'fs'
import * as path from 'path'
import { downloadWithResume, killDownloadChild, type DownloadOptions } from '../../market/hf'
import type { ModelsDownloadInput } from './schemas'
import type { DownloadProgressEvent } from './whitelist'

/** Subset of fs.Stats/StatFs the pre-flight needs (injectable in tests). */
export type StatfsResult = { bsize: number; bavail: number }

export type DownloadManagerDeps = {
  /** progress sink (per-window send or main broadcast). */
  emit: (event: DownloadProgressEvent) => void
  /** spawn injection forwarded to hf.ts (tests never real-spawn). */
  spawnFn?: DownloadOptions['spawnFn']
  /** recursive byte-size probe; default real fs walk. */
  measureBytes?: (dir: string) => number
  pollIntervalMs?: number
  /** session-id generator, overridable for deterministic tests. */
  nextId?: () => string
  /** test seam: replaces the real hf.ts invocation. */
  runDownload?: (repoId: string, opts: DownloadOptions) => Promise<unknown>
  /** 14b disk probe seam; default wraps fs.promises.statfs. */
  statfs?: (dir: string) => Promise<StatfsResult>
}

export type DownloadAck = { ok: true; id: string; repoId: string; state: 'downloading' }
export type InsufficientDisk = { ok: false; error: 'insufficient-disk'; free: number; needed: number }
export type DownloadStartResult = DownloadAck | InsufficientDisk
export type DownloadCancelResult = { ok: true; id: string; cancelled: true } | { ok: false; error: 'not-found' }

/** headroom multiplier from plan todo14 (< needed × 1.1 → refuse). */
export const DISK_HEADROOM = 1.1

function defaultMeasure(dir: string): number {
  let total = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += defaultMeasure(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    } catch {
      /* file vanished mid-walk — skip */
    }
  }
  return total
}

async function defaultStatfs(dir: string): Promise<StatfsResult> {
  const s: fs.StatsFs = await fs.promises.statfs(dir)
  return { bsize: s.bsize, bavail: s.bavail }
}

function genId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Mirrors hf.ts buildHfCliArgs default so the probe watches the right dir. */
export function resolveLocalDir(repoId: string, explicit?: string): string {
  return explicit ?? `models/${repoId.replace(/\//g, '__')}`
}

/** localDir usually does not exist yet — statfs the nearest existing ancestor. */
function nearestExistingDir(target: string): string {
  let dir = path.resolve(target)
  for (;;) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

type Session = { timer: ReturnType<typeof setInterval>; repoId: string; localDir: string; cancelled: boolean }

export class DownloadManager {
  private readonly measure: (dir: string) => number
  private readonly emit: (event: DownloadProgressEvent) => void
  private readonly running = new Map<string, Session>()

  constructor(private readonly deps: DownloadManagerDeps) {
    this.measure = deps.measureBytes ?? defaultMeasure
    this.emit = deps.emit
  }

  /** Disk pre-flight, then registers the session and starts hf-cli/aria2. */
  async start(input: ModelsDownloadInput): Promise<DownloadStartResult> {
    const id = input.id ?? this.deps.nextId?.() ?? genId()
    const localDir = resolveLocalDir(input.repoId, input.localDir)

    if (input.expectedBytes !== undefined) {
      const needed = Math.ceil(input.expectedBytes * DISK_HEADROOM)
      const probe = nearestExistingDir(localDir)
      try {
        const stat = await (this.deps.statfs ?? defaultStatfs)(probe)
        const free = stat.bsize * stat.bavail
        if (free < needed) {
          return { ok: false, error: 'insufficient-disk', free, needed }
        }
      } catch {
        /* probe failed (unsupported platform etc) — skip the check, download proceeds */
      }
    }

    this.emit({ id, repoId: input.repoId, received: 0, total: 0, state: 'downloading' })

    const pollIntervalMs = this.deps.pollIntervalMs ?? 1000
    const timer = setInterval(() => {
      const session = this.running.get(id)
      if (session && !session.cancelled) {
        this.emit({
          id,
          repoId: input.repoId,
          received: this.measure(localDir),
          total: 0,
          state: 'downloading'
        })
      }
    }, pollIntervalMs)
    this.running.set(id, { timer, repoId: input.repoId, localDir, cancelled: false })

    void this.finish(id, input, localDir)
    return { ok: true, id, repoId: input.repoId, state: 'downloading' }
  }

  /**
   * 14b: tree-kill the hf.ts child (handle map keyed by session id), stop the
   * poll timer and emit the terminal 'cancelled' event. Unknown/finished ids
   * answer {ok:false, error:'not-found'} — never throws across IPC.
   */
  cancel(id: string): DownloadCancelResult {
    const session = this.running.get(id)
    if (!session) return { ok: false, error: 'not-found' }
    session.cancelled = true
    clearInterval(session.timer)
    this.running.delete(id)
    killDownloadChild(id)
    this.emit({
      id,
      repoId: session.repoId,
      received: this.measure(session.localDir),
      total: 0,
      state: 'cancelled'
    })
    return { ok: true, id, cancelled: true }
  }

  private async finish(id: string, input: ModelsDownloadInput, localDir: string): Promise<void> {
    try {
      const run =
        this.deps.runDownload ??
        ((repoId, opts) => downloadWithResume(repoId, opts))
      await run(input.repoId, {
        ...(this.deps.spawnFn === undefined ? {} : { spawnFn: this.deps.spawnFn }),
        localDir,
        sessionId: id,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(input.quant === undefined ? {} : { quant: input.quant })
      })
      const session = this.running.get(id)
      if (session === undefined || session.cancelled) return
      const final = this.measure(localDir)
      this.emit({ id, repoId: input.repoId, received: final, total: final, state: 'done' })
    } catch (error) {
      const session = this.running.get(id)
      if (session === undefined || session.cancelled) return
      this.emit({
        id,
        repoId: input.repoId,
        received: this.measure(localDir),
        total: 0,
        state: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      const session = this.running.get(id)
      if (session) {
        clearInterval(session.timer)
        this.running.delete(id)
      }
    }
  }

  /** Active sessions (diagnostics/tests). */
  active(): number {
    return this.running.size
  }
}
