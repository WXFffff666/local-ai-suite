/**
 * service.ts — OcrService: owns the PaddleOCR-json pipe-mode pipeline
 * (todo37). Mirrors src/speech/service.ts deliberately:
 *  - lazy contract: NOTHING spawns until the first recognize(); status() is
 *    side-effect free (settings/gallery/chat mounts probe it);
 *  - bin precedence: OCR_BIN env override > installed pack
 *    (<userData>/engines/ocr-cpu, todo37 installer) > none — no PATH tier, no
 *    extraResources bundle (the 92 MB pack must never ship in the installer,
 *    plan「绝不捆绑」);
 *  - integrity: pinned exe sha256 (src/ocr/pins.ts) verified ONCE per process
 *    before the first spawn (whisper shaCheckedFor precedent; the pack lives
 *    in WRITABLE userData, so unlike whisper's extraResources tier this gate
 *    is fail-CLOSED — userData can be tampered at runtime);
 *  - serial tail queue (one in-flight request; 1-in-1-out framing).
 */

import { spawn as cpSpawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'

import type { PackDownloader, PackProgress } from '../engines/gpuPack'
import { registerShutdownHook } from '../main/shutdown'
import { installOcrEngine, readOcrInstall } from './installer'
import {
  OcrEngineError,
  PaddleOcrPipeline,
  type OcrChildProcess,
  type OcrRequest,
  type OcrSpawnFn,
} from './paddleocr'
import { OCR_BIN_ENV, OCR_ENGINE_VERSION, OCR_EXE_SHA256 } from './pins'

export type OcrEngineSource = 'env' | 'pack' | 'none'
export type OcrEngineResolution = {
  bin: string | null
  source: OcrEngineSource
  /** pinned version on the pack tier; null on env/none (unknown binary). */
  version: string | null
}

export type OcrServiceStatus = {
  engine: OcrEngineResolution
  running: boolean
  /** win32-x64 only (pinned .7z asset); other targets render honest unavailable. */
  supported: boolean
}

export type OcrInstallOutcome = { ok: boolean; reason?: string }

export type OcrServiceDeps = {
  userDataDir: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  arch?: string
  spawnImpl?: OcrSpawnFn
  shaFile?: (path: string) => Promise<string>
  /** install seams (tests fake the whole pack flow; prod = gpuPack defaults). */
  packDownloader?: PackDownloader
  extract?: (archivePath: string, destDir: string) => Promise<void>
  initTimeoutMs?: number
  responseTimeoutMs?: number
}

export class OcrService {
  private pipeline: PaddleOcrPipeline | null = null
  private shaCheckedFor: string | null = null
  /** serializes recognize + start races (whisper/SdQueue pattern). */
  private tail: Promise<unknown> = Promise.resolve()
  private installInFlight: Promise<OcrInstallOutcome> | null = null
  private readonly deps: OcrServiceDeps

  constructor(deps: OcrServiceDeps) {
    this.deps = deps
  }

  /** Side-effect free (fs stat only): resolve the engine, report pipeline state. */
  status(): OcrServiceStatus {
    return {
      engine: this.resolveEngine(),
      running: this.pipeline?.isRunning() ?? false,
      supported: this.supported(),
    }
  }

  supported(): boolean {
    const p = this.deps.platform ?? process.platform
    const a = this.deps.arch ?? process.arch
    return p === 'win32' && a === 'x64'
  }

  resolveEngine(): OcrEngineResolution {
    const env = this.deps.env ?? process.env
    const override = env[OCR_BIN_ENV]
    if (override !== undefined && override.trim() !== '') {
      return { bin: override.trim(), source: 'env', version: null }
    }
    const installed = readOcrInstall(this.deps.userDataDir)
    if (installed !== null) {
      return { bin: installed.exe, source: 'pack', version: installed.meta.version }
    }
    return { bin: null, source: 'none', version: null }
  }

  /** Queue a recognition; rejects with OcrEngineError (UI maps messages). */
  recognize(req: OcrRequest): Promise<string> {
    const run = this.tail.then(() => this.recognizeNow(req))
    this.tail = run.catch(() => undefined)
    return run
  }

  /**
   * Single-flight engine install (ocr:install). Progress rides the caller's
   * callback — never stored on the singleton (per-frame event routing).
   */
  install(onProgress?: (p: PackProgress) => void): Promise<OcrInstallOutcome> {
    if (this.installInFlight !== null) return this.installInFlight
    const p = installOcrEngine({
      userDataDir: this.deps.userDataDir,
      ...(this.deps.platform === undefined ? {} : { platform: this.deps.platform }),
      ...(this.deps.arch === undefined ? {} : { arch: this.deps.arch }),
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(this.deps.shaFile === undefined ? {} : { shaFile: this.deps.shaFile }),
      ...(this.deps.packDownloader === undefined ? {} : { downloader: this.deps.packDownloader }),
      ...(this.deps.extract === undefined ? {} : { extract: this.deps.extract }),
    })
      .then((r): OcrInstallOutcome => (r.ok ? { ok: true } : { ok: false, reason: r.reason }))
      .catch((error: unknown): OcrInstallOutcome => {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      })
      .finally(() => {
        this.installInFlight = null
      })
    this.installInFlight = p
    return p
  }

  stop(): void {
    this.pipeline?.stop()
    this.pipeline = null
    this.shaCheckedFor = null
  }

  // --- internals -------------------------------------------------------------

  private async ensurePipeline(): Promise<PaddleOcrPipeline> {
    const engine = this.resolveEngine()
    if (engine.bin === null) {
      throw new OcrEngineError('ocr engine binary not found — install it in Settings → OCR')
    }
    if (engine.source === 'pack' && this.shaCheckedFor !== engine.bin) {
      const metaSha = readOcrInstall(this.deps.userDataDir)?.meta.exeSha256
      // The PIN is the trust root; a meta.json that disagrees with the pinned
      // exe hash is tamper evidence, so BOTH must match the actual bytes.
      const actual = await (this.deps.shaFile ?? sha256FileDefault)(engine.bin)
      if (actual !== OCR_EXE_SHA256 || metaSha !== OCR_EXE_SHA256) {
        throw new OcrEngineError(`ocr engine failed pinned sha256 verification (${engine.bin})`)
      }
      this.shaCheckedFor = engine.bin
    }
    if (this.pipeline === null) {
      const spawnImpl: OcrSpawnFn = this.deps.spawnImpl ?? defaultSpawn
      this.pipeline = new PaddleOcrPipeline({
        bin: engine.bin,
        spawnImpl,
        ...(this.deps.initTimeoutMs === undefined ? {} : { initTimeoutMs: this.deps.initTimeoutMs }),
        ...(this.deps.responseTimeoutMs === undefined ? {} : { responseTimeoutMs: this.deps.responseTimeoutMs }),
      })
      registerShutdownHook(() => this.stop())
    }
    await this.pipeline.ensureStarted()
    return this.pipeline
  }

  private async recognizeNow(req: OcrRequest): Promise<string> {
    const pipeline = await this.ensurePipeline()
    return pipeline.recognize(req)
  }
}

async function sha256FileDefault(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function defaultSpawn(bin: string, args: string[], cwd: string): OcrChildProcess {
  return adaptNodeChild(cpSpawn(bin, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }))
}

/** node ChildProcess → the OcrChildProcess surface (utf8-decoded stdio). */
export function adaptNodeChild(child: ChildProcess): OcrChildProcess {
  return {
    pid: child.pid,
    stdin: {
      write: (s: string) => child.stdin?.write(s) ?? false,
      end: () => child.stdin?.end(),
    },
    stdout: {
      on: (e, cb) => {
        if (e === 'data') child.stdout?.setEncoding('utf8').on('data', cb)
        return undefined
      },
    },
    stderr: {
      on: (e, cb) => {
        if (e === 'data') child.stderr?.setEncoding('utf8').on('data', cb)
        return undefined
      },
    },
    on: (e, cb) => {
      if (e === 'exit') child.on('exit', (code) => cb(code))
      return undefined
    },
    kill: () => child.kill(),
  }
}

let instance: OcrService | null = null

/** Process singleton (main side). Lazy: construction spawns/downloads nothing. */
export function getOcrService(deps?: OcrServiceDeps): OcrService {
  instance ??= new OcrService(deps ?? { userDataDir: join(process.cwd(), 'userData') })
  return instance
}

/** Test seam. */
export function resetOcrService(): void {
  instance?.stop()
  instance = null
}

export const OCR_SERVICE_VERSION = OCR_ENGINE_VERSION
