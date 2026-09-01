/**
 * models:download session runner (plan W1-8).
 *
 * Wraps src/market/hf.ts downloadWithResume (huggingface-cli / aria2c child
 * process, resume-by-default) in an id-keyed session that emits the
 * 'download:progress' event {id, repoId, received, total, state}.
 *
 * Byte totals: hf.ts spawns with stdio 'inherit' and exposes no progress hook,
 * so 'received' is the observed on-disk size of localDir polled on an interval
 * and 'total' stays 0 until the child exits successfully — then total ===
 * received (terminal sample). todo14 (market UX) owns pre-flight size/disk
 * checks and cancel; the event shape here is already its superset.
 */

import * as fs from 'fs'
import * as path from 'path'
import { downloadWithResume, type DownloadOptions } from '../../market/hf'
import type { ModelsDownloadInput } from './schemas'
import type { DownloadProgressEvent } from './whitelist'

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
}

export type DownloadAck = { ok: true; id: string; repoId: string; state: 'downloading' }

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

function genId(): string {
  return `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Mirrors hf.ts buildHfCliArgs default so the probe watches the right dir. */
function resolveLocalDir(repoId: string, explicit?: string): string {
  return explicit ?? `models/${repoId.replace(/\//g, '__')}`
}

export class DownloadManager {
  private readonly measure: (dir: string) => number
  private readonly emit: (event: DownloadProgressEvent) => void
  private readonly running = new Map<string, { timer: ReturnType<typeof setInterval> }>()

  constructor(private readonly deps: DownloadManagerDeps) {
    this.measure = deps.measureBytes ?? defaultMeasure
    this.emit = deps.emit
  }

  /** Registers the session and starts hf-cli/aria2 detached. */
  start(input: ModelsDownloadInput): DownloadAck {
    const id = input.id ?? genId()
    const localDir = resolveLocalDir(input.repoId, input.localDir)
    this.emit({ id, repoId: input.repoId, received: 0, total: 0, state: 'downloading' })

    const pollIntervalMs = this.deps.pollIntervalMs ?? 1000
    const timer = setInterval(() => {
      if (this.running.has(id)) {
        this.emit({
          id,
          repoId: input.repoId,
          received: this.measure(localDir),
          total: 0,
          state: 'downloading'
        })
      }
    }, pollIntervalMs)
    this.running.set(id, { timer })

    void this.finish(id, input, localDir)
    return { ok: true, id, repoId: input.repoId, state: 'downloading' }
  }

  private async finish(id: string, input: ModelsDownloadInput, localDir: string): Promise<void> {
    try {
      const run =
        this.deps.runDownload ??
        ((repoId, opts) => downloadWithResume(repoId, opts))
      await run(input.repoId, {
        ...(this.deps.spawnFn === undefined ? {} : { spawnFn: this.deps.spawnFn }),
        localDir,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(input.quant === undefined ? {} : { quant: input.quant })
      })
      const final = this.measure(localDir)
      this.emit({ id, repoId: input.repoId, received: final, total: final, state: 'done' })
    } catch (error) {
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
      if (session) clearInterval(session.timer)
      this.running.delete(id)
    }
  }

  /** Active sessions (diagnostics/tests). */
  active(): number {
    return this.running.size
  }
}
