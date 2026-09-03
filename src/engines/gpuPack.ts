/**
 * GPU engine packs (todo30). NVIDIA detection + resumable download + sha256
 * verification + atomic activation, all under `<userData>/engines/`.
 *
 * Rationale (plan R4 #7781): extraResources is NOT covered by differential
 * auto-update, so GPU packs must never live inside the app directory. Only the
 * CPU binaries ship in extraResources; GPU variants download to userData and
 * are swapped atomically AFTER a successful sha256 verification against the
 * engine manifest (dev-absent manifest -> warn + pass, resolver-side policy).
 *
 * Directory contract:
 *   <userData>/engines/
 *     active.json                      { llma...: variant } single active per engine
 *     <engine>-<variant>/              activated pack directory (atomic rename target)
 *       meta.json                      { engine, variant, file, sha256, url, activatedAt }
 *     .staging/<engine>-<variant>-<ts>/ in-flight download workspace
 *     .quarantine/<engine>-<variant>-<ts>/ verify-failed packs (moved, never activated)
 */

import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { execFile as cpExecFile } from 'child_process'

import { DownloaderHelper } from 'node-downloader-helper'

import { resolvePackUrl, type EngineManifest, type ManifestEngineKey } from './manifest'

export const NVIDIA_SMI_QUERY = [
  '--query-gpu=name,driver_version,memory.total',
  '--format=csv,noheader,nounits',
] as const

export type NvidiaInfo = {
  available: boolean
  name?: string
  driverVersion?: string
  memoryMB?: number
  /** Set when unavailable: 'no-nvidia-smi' | 'parse-failed' | 'exec-failed:<msg>' */
  reason?: string
}

export type NvidiaProbe = {
  /** execFile seam (tests inject). Default: child_process.execFile with timeout. */
  execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string }>
}

/** Parse one `nvidia-smi --query-gpu=... csv,noheader,nounits` line. */
export function parseNvidiaSmiLine(line: string): Omit<NvidiaInfo, 'available'> | null {
  const parts = line.split(',').map((p) => p.trim())
  if (parts.length < 3) return null
  const [name, driverVersion, mem] = parts as [string, string, string]
  const memoryMB = Number.parseInt(mem, 10)
  if (!name || !driverVersion || !Number.isFinite(memoryMB) || memoryMB <= 0) return null
  return { name, driverVersion, memoryMB }
}

export async function detectNvidia(deps: NvidiaProbe = {}): Promise<NvidiaInfo> {
  const execFile =
    deps.execFile ??
    ((file: string, args: readonly string[]) =>
      new Promise<{ stdout: string }>((resolve, reject) => {
        cpExecFile(file, [...args], { timeout: 5000, windowsHide: true }, (err, stdout) =>
          err !== null && err !== undefined ? reject(err) : resolve({ stdout }),
        )
      }))
  try {
    const { stdout } = await execFile('nvidia-smi', NVIDIA_SMI_QUERY)
    const first = stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
    if (!first) return { available: false, reason: 'parse-failed' }
    const parsed = parseNvidiaSmiLine(first)
    if (!parsed) return { available: false, reason: 'parse-failed' }
    return { available: true, ...parsed }
  } catch (error) {
    const e = error as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { available: false, reason: 'no-nvidia-smi' }
    return { available: false, reason: `exec-failed:${e.message}` }
  }
}

// ---------------------------------------------------------------------------
// Pack layout helpers
// ---------------------------------------------------------------------------

export function enginesRoot(userDataDir: string): string {
  return join(userDataDir, 'engines')
}

export function packDirName(engine: string, variant: string): string {
  return `${engine}-${variant}`
}

export type PackMeta = {
  engine: string
  variant: string
  file: string
  sha256: string
  url: string
  activatedAt: string
}

export type InstalledPack = PackMeta & { dir: string }

export function readActive(root: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'active.json'), 'utf-8')) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

/** Single active pack per engine (kept simple per plan). */
export function activatePack(root: string, engine: string, variant: string): void {
  mkdirSync(root, { recursive: true })
  const active = readActive(root)
  active[engine] = variant
  writeFileSync(join(root, 'active.json'), JSON.stringify(active, null, 2), 'utf-8')
}

export function listInstalled(root: string): InstalledPack[] {
  if (!existsSync(root)) return []
  const out: InstalledPack[] = []
  for (const entry of statDirs(root)) {
    if (entry.startsWith('.')) continue
    try {
      const meta = JSON.parse(readFileSync(join(root, entry, 'meta.json'), 'utf-8')) as PackMeta
      if (typeof meta.engine === 'string' && typeof meta.variant === 'string') {
        out.push({ ...meta, dir: join(root, entry) })
      }
    } catch {
      // directory without a readable meta.json is not an installed pack
    }
  }
  return out
}

function statDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// sha256 verification
// ---------------------------------------------------------------------------

/** Streaming sha256 of a file (lowercase hex). Whole-pack streaming: no 8MB chunking. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function verifyFileSha(path: string, expectedHex: string): Promise<boolean> {
  try {
    return (await sha256File(path)) === expectedHex.toLowerCase()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type PackProgress = {
  percent: number
  downloaded: number
  total: number | null
  stage: 'downloading' | 'verifying' | 'activating'
}

/** Download seam: fetch `url` into `destDir`, return the resulting file path. */
export type PackDownloader = (
  url: string,
  fileName: string,
  destDir: string,
  onProgress: (p: Omit<PackProgress, 'stage'>) => void,
) => Promise<string>

export type DownloadPackOptions = {
  engine: ManifestEngineKey
  variant: string
  manifest: EngineManifest
  userDataDir: string
  onProgress?: (p: PackProgress) => void
  downloader?: PackDownloader
  env?: Record<string, string | undefined>
  shaFile?: (path: string) => Promise<string>
}

export type DownloadPackResult =
  | { ok: true; dir: string; file: string; shaVerified: boolean }
  | { ok: false; reason: string; quarantine?: string }

/** Default downloader: node-downloader-helper with resume-if-partial + retry. */
export const ndhDownloader: PackDownloader = (url, fileName, destDir, onProgress) =>
  new Promise<string>((resolve, reject) => {
    const dl = new DownloaderHelper(url, destDir, {
      fileName: { name: fileName, ext: true },
      override: false,
      resumeIfFileExists: true,
      removeOnFail: false,
      timeout: 60_000,
      retry: { maxRetries: 3, delay: 1000 },
    })
    dl.on('progress', (s: { progress: number; downloaded: number; total: number }) => {
      onProgress({ percent: s.progress, downloaded: s.downloaded, total: s.total > 0 ? s.total : null })
    })
    dl.on('end', (s: { onDiskSize: number; incomplete: boolean; filePath: string }) => {
      if (s.incomplete) reject(new Error(`incomplete download: ${s.onDiskSize} bytes on disk`))
      else resolve(dl.getDownloadPath() ?? s.filePath)
    })
    dl.on('error', (e: { message?: string }) => reject(new Error(`download failed: ${e.message ?? 'unknown'}`)))
    void dl.start().catch(reject)
  })

/**
 * Download -> sha256 verify -> atomic activation. A verify failure quarantines the
 * staged pack (moved under .quarantine/, never deleted silently) and returns
 * {ok:false} so the resolver keeps falling back to the CPU binary (plan QA-fail
 * scenario: corrupted GPU pack falls back to CPU + toast — toast is lane-30b UI).
 */
export async function downloadPack(opts: DownloadPackOptions): Promise<DownloadPackResult> {
  const { engine, variant, manifest, userDataDir } = opts
  const spec = manifest.engines[engine]?.gpu?.[variant]
  if (!spec) return { ok: false, reason: `no gpu variant '${variant}' for engine '${engine}' in manifest` }

  const root = enginesRoot(userDataDir)
  const staging = join(root, '.staging', `${packDirName(engine, variant)}-${Date.now()}`)
  mkdirSync(staging, { recursive: true })
  const url = resolvePackUrl(manifest, { engine, variant, file: spec.file }, opts.env ?? process.env)
  const report = (p: Omit<PackProgress, 'stage'>): void => opts.onProgress?.({ ...p, stage: 'downloading' })

  let downloaded: string
  try {
    downloaded = await (opts.downloader ?? ndhDownloader)(url, spec.file, staging, report)
  } catch (error) {
    quarantine(root, staging, engine, variant)
    return { ok: false, reason: `download-error:${error instanceof Error ? error.message : String(error)}` }
  }

  opts.onProgress?.({ percent: 100, downloaded: statSize(downloaded), total: null, stage: 'verifying' })
  const actualSha = await (opts.shaFile ?? sha256File)(downloaded)
  if (actualSha !== spec.sha256.toLowerCase()) {
    quarantine(root, staging, engine, variant)
    return { ok: false, reason: 'sha256-mismatch', quarantine: join(root, '.quarantine') }
  }

  opts.onProgress?.({ percent: 100, downloaded: 0, total: null, stage: 'activating' })
  const finalDir = join(root, packDirName(engine, variant))
  const meta: PackMeta = { engine, variant, file: spec.file, sha256: spec.sha256, url, activatedAt: new Date().toISOString() }
  writeFileSync(join(staging, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
  rmSync(finalDir, { recursive: true, force: true }) // swap previous active pack of same name
  renameSync(staging, finalDir) // atomic rename AFTER verification
  activatePack(root, engine, variant)
  return { ok: true, dir: finalDir, file: join(finalDir, spec.file), shaVerified: true }
}

function quarantine(root: string, staging: string, engine: string, variant: string): void {
  const qRoot = join(root, '.quarantine')
  try {
    mkdirSync(qRoot, { recursive: true })
    renameSync(staging, join(qRoot, `${packDirName(engine, variant)}-${Date.now()}`))
  } catch {
    // quarantine is best-effort; the pack is never activated on failure regardless
  }
}

function statSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
