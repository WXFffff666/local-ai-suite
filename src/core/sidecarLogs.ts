/**
 * Sidecar log file management (extracted from SidecarManager in W0-2 so the
 * manager stays a single-purpose lifecycle state machine): append stream at
 * <logDir>/sidecar-<name>.log with size-threshold rotation to <path>.1.
 *
 * fsDeps is injectable for Vitest (same convention as the manager's
 * spawner/fetcher overrides). All fs failures are swallowed by design —
 * losing a log line must never take down a sidecar lifecycle.
 */

import * as fs from 'fs'
import * as path from 'path'

export const LOG_MAX_BYTES = 5 * 1024 * 1024

export interface LogFsDeps {
  createWriteStream: typeof fs.createWriteStream
  statSync: typeof fs.statSync
  renameSync: typeof fs.renameSync
  mkdirSync: typeof fs.mkdirSync
  existsSync: typeof fs.existsSync
}

export type LogLevel = 'info' | 'warn' | 'error'

export class SidecarLogger {
  readonly filePath: string
  private readonly maxBytes: number
  private readonly deps: LogFsDeps
  private stream: fs.WriteStream | null = null
  /**
   * Streams already handed to end() but whose fd is not yet released
   * ('close' pending). whenIdle() lets shutdown await full flush so a
   * later directory removal cannot race a still-open append handle
   * (Windows CI ENOTEMPTY on temp-dir teardown).
   */
  private readonly closing = new Map<fs.WriteStream, Promise<void>>()

  constructor(opts: { name: string; logDir: string; maxBytes: number; fsDeps: LogFsDeps }) {
    this.filePath = path.join(opts.logDir, `sidecar-${opts.name}.log`)
    this.maxBytes = opts.maxBytes
    this.deps = opts.fsDeps
  }

  /** Ensure the log dir exists and (re)open the append stream. */
  open(): void {
    try {
      this.deps.mkdirSync(path.dirname(this.filePath), { recursive: true })
    } catch {
      // ignore — writes degrade to no-op below
    }
    this.close()
    try {
      this.stream = this.deps.createWriteStream(this.filePath, { flags: 'a' })
      // Prevent unhandled error if the stream fails later.
      this.stream.on('error', () => {})
    } catch {
      this.stream = null
    }
  }

  close(): void {
    if (!this.stream) return
    const ending = this.stream
    this.stream = null
    let settled = false
    let settle: () => void = () => {}
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    const finish = (): void => {
      if (settled) return
      settled = true
      this.closing.delete(ending)
      settle()
    }
    this.closing.set(ending, done)
    // 'close' fires once the fd is released (after all buffered writes flush).
    // Guarded: an injected fake fsDeps stream (tests) may not implement
    // once/close — such a handle holds no real fd, so there is nothing to wait
    // on and finish() resolves synchronously below.
    const waitsForClose = typeof ending.once === 'function' && ending.writableEnded !== true
    if (waitsForClose) {
      ending.once('close', finish)
      ending.once('error', () => {
        try {
          ending.destroy()
        } catch {
          // ignore — nothing left to release
        }
        finish()
      })
    }
    try {
      ending.end(() => {
        // end() callback runs after the final flush; if the stream never
        // emitted 'close' (mock, or writableEnded already true) settle here.
        if (!waitsForClose) finish()
      })
    } catch {
      try {
        ending.destroy()
      } catch {
        // ignore
      }
      finish()
    }
    if (!waitsForClose && !settled) {
      // last-resort: a mock end() that neither invoked its callback nor threw
      finish()
    }
  }

  /** Resolves when every handed-off stream has flushed and closed its fd. */
  whenIdle(): Promise<void> {
    if (this.closing.size === 0) return Promise.resolve()
    return Promise.all([...this.closing.values()]).then(() => undefined)
  }

  write(msg: string, level: LogLevel = 'info'): void {
    if (!this.stream) return
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`
    try {
      this.stream.write(line)
    } catch {
      // ignore
    }
  }

  /** Rotate when the file exceeds maxBytes: <path> -> <path>.1, then reopen. */
  rotateIfNeeded(): void {
    try {
      if (!this.deps.existsSync(this.filePath)) return
      const st = this.deps.statSync(this.filePath)
      if (st.size <= this.maxBytes) return
      this.rotate()
    } catch {
      // ignore stat/existence errors
    }
  }

  private rotate(): void {
    try {
      this.close()
      const rotated = `${this.filePath}.1`
      try {
        if (this.deps.existsSync(rotated)) {
          // renameSync overwrites on posix, may fail on Windows if the target
          // is briefly held — unlink first, then rename (original manager fix).
          try {
            this.deps.renameSync(this.filePath, rotated)
          } catch {
            try {
              fs.unlinkSync(rotated)
            } catch {
              // ignore
            }
            this.deps.renameSync(this.filePath, rotated)
          }
        } else {
          this.deps.renameSync(this.filePath, rotated)
        }
      } catch {
        // ignore rename failure — keep appending to the oversized file
      }
      this.open()
      this.write(`[rotate] log rotated to ${rotated}`)
    } catch {
      // ignore
    }
  }
}
