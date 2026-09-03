/**
 * paddleocr.ts — PaddleOCR-json stdin/stdout JSON-lines client (todo37, pure,
 * no electron). Protocol verified LIVE against the pinned v1.4.1 exe
 * (evidence .omo/evidence/task-37): spawn with no args → "anonymous pipe
 * mode"; stdout emits a version banner + "OCR anonymous pipe mode." noise
 * lines BEFORE the "OCR init completed." handshake, so the reader frames by
 * LINE TYPE (handshake line / JSON lines), never by "next line". One input
 * line (\n-terminated JSON) produces exactly one output JSON line
 * {"code":N,"data":...}; bare "exit\n" quits with code 0.
 *
 * The docs' recommendation "为传入的json启用ascii转义" is honored by
 * asciiEscapeJson: Windows pipe bytes must stay ASCII-safe for the engine's
 * getline path (image_path with CJK dirs is the realistic trigger).
 */

import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// Wire types (README 返回值说明 table, @1beac1c)
// ---------------------------------------------------------------------------

export type OcrBox = [[number, number], [number, number], [number, number], [number, number]]
export type OcrTextItem = { text: string, score: number, box: OcrBox }

/** Engine response codes: 100 = success, 101 = empty result, 2xx/3xx/4xx = errors. */
export type OcrResponse =
  | { code: 100 | 101, data: OcrTextItem[] }
  | { code: number, data: string }

export function parseResponseLine(line: string): OcrResponse | null {
  const t = line.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  let raw: unknown
  try {
    raw = JSON.parse(t)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj['code'] !== 'number') return null
  return { code: obj['code'], data: obj['data'] } as OcrResponse
}

/** code 100 → joined text lines; 101 → '' (recognized nothing); else throw. */
export function responseText(res: OcrResponse): string {
  if (res.code === 100 || res.code === 101) {
    const items = Array.isArray(res.data) ? (res.data as OcrTextItem[]) : []
    return items
      .map((i) => (typeof i?.text === 'string' ? i.text : ''))
      .filter((s) => s.length > 0)
      .join('\n')
  }
  const detail = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '')
  throw new OcrEngineError(`PaddleOCR-json error ${res.code}: ${detail}`, res.code)
}

export class OcrEngineError extends Error {
  readonly ocrCode?: number
  constructor(message: string, ocrCode?: number) {
    super(message)
    this.name = 'OcrEngineError'
    if (ocrCode !== undefined) this.ocrCode = ocrCode
  }
}

// ---------------------------------------------------------------------------
// Request framing
// ---------------------------------------------------------------------------

export type OcrRequest = { imagePath: string } | { imageBase64: string }

/** exactly one task key per line (docs: 每次任务仅可传入其中一项) */
export function buildRequestLine(req: OcrRequest): string {
  if ('imagePath' in req && 'imageBase64' in req) {
    throw new OcrEngineError('ocr request must carry exactly one of imagePath/imageBase64')
  }
  if ('imagePath' in req) {
    if (!req.imagePath) throw new OcrEngineError('imagePath must be non-empty')
    // docs use forward slashes on Windows (D:/test/...); normalize backslashes.
    return asciiEscapeJson(JSON.stringify({ image_path: req.imagePath.replace(/\\/g, '/') })) + '\n'
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(req.imageBase64)) {
    throw new OcrEngineError('imageBase64 must be raw base64 (no data-URL prefix)')
  }
  return JSON.stringify({ image_base64: req.imageBase64 }) + '\n'
}

/** \uXXXX-escape every non-ASCII char (JSON spec-safe, engine pipe-safe). */
export function asciiEscapeJson(json: string): string {
  return json.replace(/[^\x20-\x7e]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

// ---------------------------------------------------------------------------
// Managed pipe-mode process
// ---------------------------------------------------------------------------

/** Minimal child-process surface (tests inject an EventEmitter-based fake). */
export type OcrChildProcess = {
  readonly pid?: number
  readonly stdin: { write(chunk: string): unknown; end?(): unknown }
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown }
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown }
  on(event: 'exit', cb: (code: number | null) => void): unknown
  kill(): unknown
}

export type OcrSpawnFn = (bin: string, args: string[], cwd: string) => OcrChildProcess

export const OCR_READY_LINE = 'OCR init completed.' as const
export const OCR_EXIT_COMMAND = 'exit\n' as const

export type PipelineOptions = {
  bin: string
  spawnImpl: OcrSpawnFn
  /** stdout handshake wait budget (model load ~1s on probe, slow CPU budget). */
  initTimeoutMs?: number
  /** per-request response wait budget (big images, CPU inference). */
  responseTimeoutMs?: number
  /** grace window between exit\\n and kill() in stop(). */
  exitGraceMs?: number
}

type Pending = {
  resolve: (res: OcrResponse) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One managed engine process, FIFO request queue (1 in ↔ 1 out framing makes
 * ordering implicit). Not thread-safe by design — the ONLY serializer is
 * OcrService's tail queue; the pipeline asserts on overlapping recognize.
 */
export class PaddleOcrPipeline {
  private child: OcrChildProcess | null = null
  private stdoutBuf = ''
  private ready = false
  private starting: Promise<void> | null = null
  private startupResolve: (() => void) | null = null
  private startupReject: ((err: Error) => void) | null = null
  private pending: Pending | null = null
  private lastStderr = ''
  private readonly initMs: number
  private readonly responseMs: number
  private readonly exitGraceMs: number

  constructor(private readonly opts: PipelineOptions) {
    this.initMs = opts.initTimeoutMs ?? 60_000
    this.responseMs = opts.responseTimeoutMs ?? 120_000
    this.exitGraceMs = opts.exitGraceMs ?? 2_000
  }

  isRunning(): boolean {
    return this.child !== null && this.ready
  }

  /** Idempotent lazy start: spawn → wait handshake line. */
  async ensureStarted(): Promise<void> {
    if (this.ready) return
    if (this.starting !== null) return this.starting
    this.starting = this.spawnAndWait().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  recognize(req: OcrRequest): Promise<string> {
    const run = this.ensureStarted().then(() => this.recognizeNow(req))
    return run
  }

  /** exit\n → graceful close; kill() after grace window if still alive. */
  stop(): void {
    const child = this.child
    this.child = null
    this.ready = false
    this.stdoutBuf = ''
    if (child === null) return
    const fail = new OcrEngineError('ocr engine process stopped')
    this.startupReject?.(fail)
    this.startupReject = null
    this.startupResolve = null
    this.pending?.reject(fail)
    this.pending = null
    try {
      child.stdin.write(OCR_EXIT_COMMAND)
    } catch {
      /* pipe already closed */
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
    }, this.exitGraceMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('exit', () => clearTimeout(timer))
  }

  // --- internals -------------------------------------------------------------

  private spawnAndWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: OcrChildProcess
      try {
        child = this.opts.spawnImpl(this.opts.bin, [], this.dirname(this.opts.bin))
      } catch (error) {
        reject(new OcrEngineError(`failed to spawn ${this.opts.bin}: ${String(error)}`))
        return
      }
      this.child = child
      this.ready = false
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        this.ready = false
        reject(err)
      }
      const initTimer = setTimeout(
        () => fail(new OcrEngineError(`ocr engine init timed out (${this.initMs}ms)${this.stderrHint()}`)),
        this.initMs,
      )
      if (typeof initTimer.unref === 'function') initTimer.unref()
      this.startupResolve = () => {
        if (settled) return
        settled = true
        clearTimeout(initTimer)
        resolve()
      }
      this.startupReject = fail
      child.on('exit', (code: number | null) => {
        this.ready = false
        const err = new OcrEngineError(`ocr engine exited (code ${code})${this.stderrHint()}`)
        this.pending?.reject(err)
        this.pending = null
        fail(err)
      })
      child.stderr.on('data', (chunk) => {
        this.lastStderr = (this.lastStderr + String(chunk)).slice(-4000)
      })
      child.stdout.on('data', (chunk) => {
        this.stdoutBuf += String(chunk)
        let i
        while ((i = this.stdoutBuf.indexOf('\n')) >= 0) {
          const line = this.stdoutBuf.slice(0, i)
          this.stdoutBuf = this.stdoutBuf.slice(i + 1)
          this.handleLine(line)
        }
      })
    })
  }

  private handleLine(line: string): void {
    const t = line.trim()
    if (!this.ready) {
      // pre-handshake: version banner + "OCR anonymous pipe mode." are noise.
      if (t === OCR_READY_LINE) {
        this.ready = true
        const up = this.startupResolve
        this.startupResolve = null
        this.startupReject = null
        up?.()
      }
      return
    }
    if (this.pending === null) return // unsolicited line while idle: drop
    const res = parseResponseLine(t)
    if (res === null) return // perf-log noise between requests: skip, keep waiting
    const p = this.pending
    this.pending = null
    clearTimeout(p.timer)
    p.resolve(res)
  }

  private recognizeNow(req: OcrRequest): Promise<string> {
    const child = this.child
    if (child === null || !this.ready) {
      return Promise.reject(new OcrEngineError('ocr engine not running'))
    }
    if (this.pending !== null) {
      return Promise.reject(new OcrEngineError('ocr engine busy (serializer contract violated)'))
    }
    const line = buildRequestLine(req)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new OcrEngineError(`ocr response timed out (${this.responseMs}ms)${this.stderrHint()}`))
      }, this.responseMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending = {
        resolve: (res) => {
          // responseText throws on engine error codes — route through reject,
          // never let it escape the stdout event listener.
          try {
            resolve(responseText(res))
          } catch (error) {
            reject(error instanceof Error ? error : new OcrEngineError(String(error)))
          }
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
        timer,
      }
      try {
        child.stdin.write(line)
      } catch (error) {
        this.pending.reject(new OcrEngineError(`ocr stdin write failed: ${String(error)}`))
      }
    })
  }

  private dirname(bin: string): string {
    const i = Math.max(bin.lastIndexOf('\\'), bin.lastIndexOf('/'))
    return i > 0 ? bin.slice(0, i) : '.'
  }

  private stderrHint(): string {
    return this.lastStderr ? ` — stderr: ${this.lastStderr.slice(-200)}` : ''
  }
}

/** EventEmitter-based export for test fakes (kept here: single wire truth). */
export function makeFakeStdio(): {
  child: OcrChildProcess & EventEmitter
  write: (s: string) => void
  pushStdout: (s: string) => void
  pushStderr: (s: string) => void
  exit: (code: number) => void
  stdinWrites: string[]
  killCount: () => number
} {
  const bus = new EventEmitter()
  const stdinWrites: string[] = []
  let kills = 0
  const child = Object.assign(bus, {
    pid: 4242,
    stdin: {
      write: (s: string) => {
        stdinWrites.push(s)
        bus.emit('stdin', s)
        return true
      },
      end: () => undefined,
    },
    stdout: { on: (e: string, cb: (c: unknown) => void) => bus.on(e === 'data' ? 'stdout-data' : e, cb) },
    stderr: { on: (e: string, cb: (c: unknown) => void) => bus.on(e === 'data' ? 'stderr-data' : e, cb) },
    kill: () => {
      kills += 1
      return true
    },
  }) as unknown as OcrChildProcess & EventEmitter
  return {
    child,
    write: (s) => bus.emit('stdin', s),
    pushStdout: (s) => bus.emit('stdout-data', s),
    pushStderr: (s) => bus.emit('stderr-data', s),
    exit: (code) => bus.emit('exit', code),
    stdinWrites,
    killCount: () => kills,
  }
}
