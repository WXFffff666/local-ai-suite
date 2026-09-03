/**
 * installer.ts — OCR engine pack installer (todo37). Downloads the pinned
 * PaddleOCR-json v1.4.1 windows x64 .7z into <userData>/engines, verifies the
 * ARCHIVE sha256 BEFORE extraction, extracts with the in-box Windows bsdtar
 * (System32\tar.exe reads 7z via libarchive — verified in evidence; no new
 * dependency, no bundled 7zip), then atomically activates the pack directory.
 *
 * Reuses src/engines/gpuPack layout primitives (enginesRoot/packDirName/
 * activatePack/.staging/.quarantine flow, PackMeta shape) WITHOUT touching the
 * frozen EngineBinary/manifest union — the pins live in src/ocr/pins.ts
 * (documented in pins.ts header; engines lane untouched).
 */

import { execFile as cpExecFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  activatePack,
  enginesRoot,
  ndhDownloader,
  packDirName,
  sha256File,
  type PackDownloader,
  type PackProgress,
} from '../engines/gpuPack'
import {
  OCR_ARCHIVE_TOPDIR,
  OCR_ASSET_FILE,
  OCR_ASSET_SHA256,
  OCR_ASSET_URL,
  OCR_ENGINE_KEY,
  OCR_ENGINE_VERSION,
  OCR_EXE_FILE,
  OCR_PACK_VARIANT,
  OCR_SUPPORTED_ARCH,
  OCR_SUPPORTED_PLATFORM,
} from './pins'

/** meta.json written into the activated pack dir (gpuPack PackMeta + extras). */
export type OcrPackMeta = {
  engine: string
  variant: string
  file: string
  /** sha256 of the .7z archive (pin). */
  sha256: string
  url: string
  activatedAt: string
  /** engine version tag (v1.4.1). */
  version: string
  /** sha256 of PaddleOCR-json.exe — verified again pre-spawn (service gate). */
  exeSha256: string
}

export type OcrInstallResult =
  | { ok: true; dir: string; exe: string; meta: OcrPackMeta }
  | { ok: false; reason: string }

export type OcrInstallDeps = {
  userDataDir: string
  platform?: NodeJS.Platform
  arch?: string
  onProgress?: (p: PackProgress) => void
  /** download seam (gpuPack PackDownloader). */
  downloader?: PackDownloader
  /** archive sha256 seam. */
  shaFile?: (path: string) => Promise<string>
  /** bsdtar exec seam: extract 7z → destDir. */
  extract?: (archivePath: string, destDir: string) => Promise<void>
  /** exe sha256 of the extracted binary (pin recomputation seam for tests). */
  exeSha256?: string
}

export function ocrPackDir(userDataDir: string): string {
  return join(enginesRoot(userDataDir), packDirName(OCR_ENGINE_KEY, OCR_PACK_VARIANT))
}

export function ocrPackExePath(packDir: string): string {
  return join(packDir, OCR_EXE_FILE)
}

export function isSupportedTarget(platform?: NodeJS.Platform, arch?: string): boolean {
  const p = platform ?? process.platform
  const a = arch ?? process.arch
  return p === OCR_SUPPORTED_PLATFORM && a === OCR_SUPPORTED_ARCH
}

/** Read + validate the installed pack; null = not installed / tampered meta. */
export function readOcrInstall(userDataDir: string): { dir: string; exe: string; meta: OcrPackMeta } | null {
  const dir = ocrPackDir(userDataDir)
  const exe = ocrPackExePath(dir)
  if (!existsSync(exe)) return null
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')) as OcrPackMeta
    if (meta.engine !== OCR_ENGINE_KEY || typeof meta.exeSha256 !== 'string') return null
    return { dir, exe, meta }
  } catch {
    return null
  }
}

/**
 * Download → verify → extract → activate. Every failure either quarantines the
 * staging tree (download/verify) or removes it (extract), never activates a
 * partial pack. Single-flight is enforced by the caller (ipc layer).
 */
export async function installOcrEngine(deps: OcrInstallDeps): Promise<OcrInstallResult> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  if (!isSupportedTarget(platform, arch)) {
    return { ok: false, reason: 'engine-unsupported-platform' }
  }
  const root = enginesRoot(deps.userDataDir)
  const staging = join(root, '.staging', `${packDirName(OCR_ENGINE_KEY, OCR_PACK_VARIANT)}-${Date.now()}`)
  mkdirSync(staging, { recursive: true })
  const report = (p: Omit<PackProgress, 'stage'>): void => deps.onProgress?.({ ...p, stage: 'downloading' })

  let archive: string
  try {
    archive = await (deps.downloader ?? ndhDownloader)(OCR_ASSET_URL, OCR_ASSET_FILE, staging, report)
  } catch (error) {
    quarantine(root, staging)
    return { ok: false, reason: `download-error:${error instanceof Error ? error.message : String(error)}` }
  }

  deps.onProgress?.({ percent: 100, downloaded: statSize(archive), total: null, stage: 'verifying' })
  const sha = await (deps.shaFile ?? sha256File)(archive)
  if (sha !== OCR_ASSET_SHA256) {
    quarantine(root, staging)
    return { ok: false, reason: 'sha256-mismatch' }
  }

  // bsdtar lands the archive's top dir (PaddleOCR-json_v1.4.1) under out/.
  const out = join(staging, 'extract')
  mkdirSync(out, { recursive: true })
  deps.onProgress?.({ percent: 100, downloaded: 0, total: null, stage: 'activating' })
  try {
    await (deps.extract ?? bsdtarExtract)(archive, out)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    pruneStagingParent(root)
    return { ok: false, reason: `extract-failed:${error instanceof Error ? error.message : String(error)}` }
  }

  const inner = findExeDir(out)
  if (inner === null) {
    rmSync(staging, { recursive: true, force: true })
    pruneStagingParent(root)
    return { ok: false, reason: 'extract-missing-exe' }
  }
  const exe = join(inner, OCR_EXE_FILE)
  const exeSha256 = deps.exeSha256 ?? (await sha256File(exe))

  const finalDir = ocrPackDir(deps.userDataDir)
  const meta: OcrPackMeta = {
    engine: OCR_ENGINE_KEY,
    variant: OCR_PACK_VARIANT,
    file: OCR_ASSET_FILE,
    sha256: OCR_ASSET_SHA256,
    url: OCR_ASSET_URL,
    activatedAt: new Date().toISOString(),
    version: OCR_ENGINE_VERSION,
    exeSha256,
  }
  rmSync(finalDir, { recursive: true, force: true })
  mkdirSync(join(finalDir, '..'), { recursive: true })
  renameSync(inner, finalDir) // atomic activation AFTER verification+extraction
  rmSync(staging, { recursive: true, force: true })
  pruneStagingParent(root)
  writeFileSync(join(finalDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
  activatePack(root, OCR_ENGINE_KEY, OCR_PACK_VARIANT)
  return { ok: true, dir: finalDir, exe, meta }
}

/** Windows in-box bsdtar reads 7z (libarchive). `tar -xf a.7z -C dest`. */
export const bsdtarExtract = (archivePath: string, destDir: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const tar = process.env['SystemRoot'] ? join(process.env['SystemRoot'], 'System32', 'tar.exe') : 'tar'
    cpExecFile(tar, ['-xf', archivePath, '-C', destDir], { timeout: 300_000, windowsHide: true }, (err) =>
      err !== null && err !== undefined ? reject(err) : resolve(),
    )
  })

/** Locate the directory that contains the engine exe (archive top dir). */
export function findExeDir(root: string): string | null {
  const direct = join(root, OCR_ARCHIVE_TOPDIR, OCR_EXE_FILE)
  if (existsSync(direct)) return join(root, OCR_ARCHIVE_TOPDIR)
  return walkForExe(root, 0)
}

function walkForExe(dir: string, depth: number): string | null {
  if (depth > 3) return null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  if (names.includes(OCR_EXE_FILE)) return dir
  for (const n of names) {
    const p = join(dir, n)
    try {
      if (statSync(p).isDirectory()) {
        const found = walkForExe(p, depth + 1)
        if (found !== null) return found
      }
    } catch {
      /* ignore unreadable entries */
    }
  }
  return null
}

function quarantine(root: string, staging: string): void {
  const qRoot = join(root, '.quarantine')
  try {
    mkdirSync(qRoot, { recursive: true })
    renameSync(staging, join(qRoot, `${packDirName(OCR_ENGINE_KEY, OCR_PACK_VARIANT)}-${Date.now()}`))
  } catch {
    // best-effort, same policy as gpuPack: never activated regardless
  }
}

/** remove the .staging parent when no in-flight workspace remains */
function pruneStagingParent(root: string): void {
  const parent = join(root, '.staging')
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
  } catch {
    /* cosmetic only */
  }
}

function statSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
