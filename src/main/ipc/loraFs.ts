/**
 * LoRA filesystem helpers (todo19) — safetensors header parsing, modelsDir
 * path confinement, and the registry-entry LoRA filter. Kept out of
 * handlers.ts so the ipc map stays registration-only (imageOps precedent).
 *
 * Security posture: models:loraMeta receives a renderer-supplied path. Zod
 * bounds the shape; assertInsideModelsDir is the trust boundary — the same
 * casefold + path.relative containment form gallery.ts:143 enforces (Windows
 * drive-letter case and `\\?\` prefix traps both neutralised). Anything that
 * fails containment is rejected BEFORE any fs call.
 *
 * Safetensors layout (https://huggingface.co/docs/safetensors): first 8 bytes
 * = u64 little-endian N; next N bytes = JSON header. Kohya-style LoRA tags
 * live in the header's `__metadata__` object (ss_tag_string, ss_network_dim…).
 * We read at most 8 + LORA_HEADER_MAX_BYTES; an oversized declared header is
 * rejected outright (QA scenario "huge header >10MB guard").
 */

import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'

import type { ModelEntry } from '../../models/registry'
import type { LoraFile, LoraMeta, LoraMetaError } from './whitelist'

/** Declared safetensors header cap: 10 MiB (plan W3 QA scenario). */
export const LORA_HEADER_MAX_BYTES = 10 * 1024 * 1024

/** Max __metadata__ keys surfaced to the UI (pathological headers stay cheap). */
export const LORA_META_MAX_KEYS = 48

// ---------------------------------------------------------------------------
// path confinement (gallery assertInsideGalleryDir pattern)
// ---------------------------------------------------------------------------

export class LoraPathError extends Error {
  constructor(readonly code: LoraMetaError) {
    super(`lora path rejected: ${code}`)
    this.name = 'LoraPathError'
  }
}

/**
 * Throws LoraPathError('path-outside-models-dir') unless `target` resolves
 * strictly inside `modelsDir` (casefolded; '' / '..' / absolute rel = escape).
 */
export function assertInsideModelsDir(target: string, modelsDir: string): void {
  const rel = relative(resolve(modelsDir).toLowerCase(), resolve(target).toLowerCase())
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new LoraPathError('path-outside-models-dir')
  }
}

// ---------------------------------------------------------------------------
// safetensors header parse (pure — synthetic bytes are unit-testable)
// ---------------------------------------------------------------------------

export type HeaderParseResult =
  | { ok: true; meta: LoraMeta }
  | { ok: false; error: Exclude<LoraMetaError, 'path-outside-models-dir' | 'file-not-found' | 'meta-unsupported'> }

/** True for keys worth showing: kohya ss_* training metadata and *lora* hints. */
function isLoraMetaKey(key: string): boolean {
  return /^ss_/i.test(key) || /lora/i.test(key) || /^modelspec\./i.test(key)
}

function toMetaValue(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  // kohya writes every __metadata__ value as a string; numeric ones display
  // compactly as numbers (and the UI types them against LoraMeta = string|number).
  const trimmed = value.trim()
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isFinite(n)) return n
  }
  return value.slice(0, 2048)
}

/**
 * Parses a buffer that holds [8-byte u64-LE length][JSON header] (plus any
 * trailing tensor payload, which is ignored). Rejects: <8B input, declared
 * length < 16 or > 10 MiB (covers big-endian misreads — 1 as BE decodes to
 * 2^56 LE), declared > present bytes, non-JSON, non-object header.
 */
export function parseSafetensorsHeader(buf: Buffer): HeaderParseResult {
  if (buf.length < 8) return { ok: false, error: 'bad-header' }
  const headerLen = Number(buf.readBigUInt64LE(0))
  if (!Number.isFinite(headerLen) || headerLen < 16) return { ok: false, error: 'bad-header' }
  if (headerLen > LORA_HEADER_MAX_BYTES) return { ok: false, error: 'header-too-large' }
  if (buf.length < 8 + headerLen) return { ok: false, error: 'bad-header' }
  let header: unknown
  try {
    header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf-8'))
  } catch {
    return { ok: false, error: 'bad-header' }
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    return { ok: false, error: 'bad-header' }
  }
  const raw = (header as Record<string, unknown>)
  const metaSource = raw['__metadata__']
  const meta: LoraMeta = {}
  if (typeof metaSource === 'object' && metaSource !== null) {
    for (const [key, value] of Object.entries(metaSource as Record<string, unknown>)) {
      if (!isLoraMetaKey(key)) continue
      const v = toMetaValue(value)
      if (v === undefined) continue
      meta[key] = v
      if (Object.keys(meta).length >= LORA_META_MAX_KEYS) break
    }
  }
  return { ok: true, meta }
}

// ---------------------------------------------------------------------------
// file-level meta read (containment happens inside)
// ---------------------------------------------------------------------------

export type LoraMetaFileResult = { ok: true; meta: LoraMeta } | { ok: false; error: LoraMetaError }

/**
 * Reads only the header region of a confined LoRA file and returns filtered
 * __metadata__. Never reads more than 8 + declared-length (≤ cap) bytes.
 * Non-safetensors extensions (gguf loras) report 'meta-unsupported' — the UI
 * keeps them selectable with an "unknown" badge.
 */
export function readLoraMetaFile(absPath: string, modelsDir: string): LoraMetaFileResult {
  try {
    assertInsideModelsDir(absPath, modelsDir)
  } catch (e) {
    return { ok: false, error: (e as LoraPathError).code }
  }
  if (!/\.safetensors$/i.test(absPath)) return { ok: false, error: 'meta-unsupported' }
  let fd: number
  try {
    fd = openSync(absPath, 'r')
  } catch {
    return { ok: false, error: 'file-not-found' }
  }
  try {
    const size = fstatSync(fd).size
    if (size < 8) return { ok: false, error: 'bad-header' }
    const lenBuf = Buffer.alloc(8)
    if (readSync(fd, lenBuf, 0, 8, 0) < 8) return { ok: false, error: 'bad-header' }
    const declared = Number(lenBuf.readBigUInt64LE(0))
    if (!Number.isFinite(declared) || declared < 16) return { ok: false, error: 'bad-header' }
    if (declared > LORA_HEADER_MAX_BYTES) return { ok: false, error: 'header-too-large' }
    const headerLen = Math.min(declared, Math.max(0, size - 8))
    const header = Buffer.alloc(headerLen)
    const got = readSync(fd, header, 0, headerLen, 8)
    return parseSafetensorsHeader(Buffer.concat([lenBuf, header.subarray(0, got)]))
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* fd already gone — the read result above stands */
    }
  }
}

// ---------------------------------------------------------------------------
// registry-entry filter (models:loraScan source of truth)
// ---------------------------------------------------------------------------

/**
 * LoRA dir convention (sd.cpp --lora-model-dir, plan W3): weights under
 * diffusion/lora/ or diffusion/loras/, or direct diffusion/* files carrying
 * 'lora' in the name (checkpoint files without the hint stay out of the list).
 * `file` is the registry's modelsDir-relative POSIX path.
 */
export function isLoraEntry(file: string): boolean {
  const f = file.toLowerCase().replace(/\\/g, '/')
  if (/^diffusion\/lora\/[^/]+/.test(f) || /^diffusion\/loras\/[^/]+/.test(f)) return true
  return /^diffusion\/[^/]+$/.test(f) && f.includes('lora')
}

/** Bytes → '142.3 MB' style label (renderer-side formatSize parity, main-owned). */
export function formatLoraSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let v = bytes / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(1)} ${units[u]}`
}

/** Projects registry ModelEntry[] onto the LoRA wire list (sorted by file). */
export function toLoraFiles(entries: readonly ModelEntry[]): LoraFile[] {
  const out: LoraFile[] = []
  for (const e of entries) {
    if (e.corrupted === true) continue
    if (!isLoraEntry(e.file)) continue
    if (e.format !== 'safetensors' && e.format !== 'gguf') continue
    out.push({ name: e.name, file: e.file, path: e.path, sizeLabel: formatLoraSize(e.size), format: e.format })
  }
  out.sort((a, b) => a.file.localeCompare(b.file))
  return out
}
