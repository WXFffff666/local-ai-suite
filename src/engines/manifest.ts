/**
 * Engine distribution manifest (todo30). Defines the SHA256 manifest format that
 * the resolver consumes for verification; CI generation lands in todo34, which
 * fills real digests into extraResources `engines/manifest.json`.
 *
 * Security baseline (Appendix R3 §C, TALOS-2024-1912/13/14/16): every engine
 * entry carries a `minVersion` floor; a PATH-installed binary below the floor is
 * rejected by the resolver. Runtime hash verification before spawn uses `sha256`
 * (bundled CPU) / per-variant `sha256` (GPU packs in userData/engines — R4 #7781:
 * extraResources is NOT differentially updated, so packs live outside the app dir).
 *
 * Dev ergonomics (plan r2): while todo34 has not shipped, the manifest file is
 * ABSENT -> loadEngineManifest reports 'absent' and the resolver DOWNGRADES TO
 * WARN + PASS (no verification) instead of bricking every engine. An INVALID
 * (present-but-malformed) manifest is never passed: unverifiable binaries stay
 * rejected for the bundled/GPU tiers.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'fs'
import { join } from 'path'

export const MANIFEST_VERSION = 1 as const

/** Engine keys that can appear in the manifest. `whisper` is optional (todo36 consumes it). */
export const MANIFEST_ENGINES = ['llama', 'sd', 'whisper'] as const
export type ManifestEngineKey = (typeof MANIFEST_ENGINES)[number]

/** All GPU-pack engines additionally live under userData/engines; ollama is system-only. */
export const RESOLVER_ENGINES = ['llama', 'ollama', 'sd'] as const
export type EngineBinary = (typeof RESOLVER_ENGINES)[number]

export type CpuBinarySpec = {
  /** File name inside extraResources <resourcesPath>/engines/ */
  file: string
  /** lowercase hex sha256 of the shipped binary */
  sha256: string
  /**
   * Minimum engine version (upstream release tag, e.g. llama.cpp 'b5034' or
   * '0.1.13'). Binaries probing below this floor are never spawned.
   */
  minVersion: string
  platform: string
}

export type GpuVariantSpec = {
  /** Binary file name inside the activated pack directory. */
  file: string
  sha256: string
  /** Optional per-variant URL override; supports the same placeholders as baseUrlTemplate. */
  urlTemplate?: string
}

export type EngineSpec = {
  cpu: CpuBinarySpec
  /** GPU variants keyed by variant name, e.g. 'cuda' | 'vulkan'. Absent = CPU-only engine. */
  gpu?: Record<string, GpuVariantSpec>
}

export type EngineManifest = {
  version: typeof MANIFEST_VERSION
  /** ISO timestamp stamped by the todo34 CI generator. */
  generated_at: string
  /**
   * Template for GPU pack downloads. Placeholders: {engine} {variant} {file}.
   * Overridable at runtime via env ENGINE_PACK_BASE_URL (CI/dev pin file
   * engine-pins.json may set the same env before first resolution).
   */
  baseUrlTemplate: string
  engines: Partial<Record<ManifestEngineKey, EngineSpec>>
}

export const PACK_BASE_URL_ENV = 'ENGINE_PACK_BASE_URL' as const

const SHA256_RE = /^[0-9a-f]{64}$/
// Dotted numeric tag with optional 'b'/'v' prefix and pre-release tail: b5034, 0.1.13, v45.
const VERSION_RE = /^[A-Za-z]{0,2}\d+(\.\d+)*([A-Za-z0-9.+-]*)?$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Boundary parser: unknown JSON -> EngineManifest, collecting every violation. */
export function validateEngineManifest(raw: unknown): { ok: true; manifest: EngineManifest } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['manifest root must be an object'] }

  if (raw.version !== MANIFEST_VERSION) errors.push(`version must be ${MANIFEST_VERSION}`)
  if (typeof raw.generated_at !== 'string' || !raw.generated_at) errors.push('generated_at must be a non-empty string')
  if (typeof raw.baseUrlTemplate !== 'string' || !raw.baseUrlTemplate) errors.push('baseUrlTemplate must be a non-empty string')

  const enginesOut: Partial<Record<ManifestEngineKey, EngineSpec>> = {}
  if (!isPlainObject(raw.engines)) {
    errors.push('engines must be an object')
  } else {
    for (const [key, spec] of Object.entries(raw.engines)) {
      if (!(MANIFEST_ENGINES as readonly string[]).includes(key)) {
        errors.push(`unknown engine key: ${key}`)
        continue
      }
      const parsed = validateEngineSpec(`${key}`, spec)
      if ('errors' in parsed) {
        errors.push(...parsed.errors)
      } else {
        enginesOut[key as ManifestEngineKey] = parsed.spec
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    manifest: {
      version: MANIFEST_VERSION,
      generated_at: raw.generated_at as string,
      baseUrlTemplate: raw.baseUrlTemplate as string,
      engines: enginesOut,
    },
  }
}

function validateEngineSpec(path: string, spec: unknown): { spec: EngineSpec } | { errors: string[] } {
  if (!isPlainObject(spec)) return { errors: [`${path}: spec must be an object`] }
  const problems: string[] = []
  const cpu = spec.cpu
  let cpuSpec: CpuBinarySpec | null = null
  if (!isPlainObject(cpu)) {
    problems.push(`${path}.cpu: missing cpu spec`)
  } else {
    if (typeof cpu.file !== 'string' || !cpu.file) problems.push(`${path}.cpu.file: must be a non-empty string`)
    if (typeof cpu.sha256 !== 'string' || !SHA256_RE.test(cpu.sha256)) problems.push(`${path}.cpu.sha256: must be 64-char lowercase hex`)
    if (typeof cpu.minVersion !== 'string' || !VERSION_RE.test(cpu.minVersion)) problems.push(`${path}.cpu.minVersion: invalid version tag`)
    if (typeof cpu.platform !== 'string' || !cpu.platform) problems.push(`${path}.cpu.platform: must be a non-empty string`)
    if (problems.length === 0) {
      cpuSpec = { file: cpu.file, sha256: cpu.sha256, minVersion: cpu.minVersion, platform: cpu.platform } as CpuBinarySpec
    }
  }
  let gpuSpec: Record<string, GpuVariantSpec> | undefined
  let gpuOk = true
  if (spec.gpu !== undefined) {
    if (!isPlainObject(spec.gpu)) {
      problems.push(`${path}.gpu: must be an object of variants`)
      gpuOk = false
    } else {
      gpuSpec = {}
      for (const [variant, v] of Object.entries(spec.gpu)) {
        if (!isPlainObject(v)) {
          problems.push(`${path}.gpu.${variant}: must be an object`)
          gpuOk = false
          continue
        }
        let bad = false
        if (typeof v.file !== 'string' || !v.file) {
          problems.push(`${path}.gpu.${variant}.file: must be a non-empty string`)
          bad = true
        }
        if (typeof v.sha256 !== 'string' || !SHA256_RE.test(v.sha256)) {
          problems.push(`${path}.gpu.${variant}.sha256: must be 64-char lowercase hex`)
          bad = true
        }
        if (v.urlTemplate !== undefined && typeof v.urlTemplate !== 'string') {
          problems.push(`${path}.gpu.${variant}.urlTemplate: must be a string`)
          bad = true
        }
        if (!bad) {
          gpuSpec[variant] = v.urlTemplate === undefined
            ? { file: v.file as string, sha256: v.sha256 as string }
            : { file: v.file as string, sha256: v.sha256 as string, urlTemplate: v.urlTemplate as string }
        }
      }
    }
  }
  if (problems.length > 0 || cpuSpec === null) return { errors: problems.length > 0 ? problems : [`${path}: invalid cpu spec`] }
  const out: EngineSpec = { cpu: cpuSpec }
  if (gpuOk && gpuSpec !== undefined) out.gpu = gpuSpec
  return { spec: out }
}

// ---------------------------------------------------------------------------
// Loader (dev-absent -> warn + pass)
// ---------------------------------------------------------------------------

export type ManifestLoad =
  | { status: 'ok'; manifest: EngineManifest; path: string }
  | { status: 'absent'; path: string; warnings: string[] }
  | { status: 'invalid'; path: string; errors: string[] }

export type LoadManifestDeps = {
  /** Ordered candidate absolute paths; the FIRST existing one wins. */
  candidatePaths?: string[]
  existsSync?: (p: string) => boolean
  readFileSync?: (p: string, enc: 'utf-8') => string
}

/** Default candidates: packaged extraResources first, repo build/ dir for dev. */
export function defaultManifestCandidates(resourcesPath?: string, cwd: string = process.cwd()): string[] {
  const out: string[] = []
  if (resourcesPath) out.push(join(resourcesPath, 'engines', 'manifest.json'))
  out.push(join(cwd, 'build', 'engines', 'manifest.json'))
  return out
}

export function loadEngineManifest(deps: LoadManifestDeps = {}): ManifestLoad {
  const existsSync = deps.existsSync ?? fsExistsSync
  const readFileSync = deps.readFileSync ?? ((p: string): string => fsReadFileSync(p, 'utf-8'))
  const candidates = deps.candidatePaths ?? defaultManifestCandidates(
    typeof process !== 'undefined' ? process.resourcesPath : undefined,
  )
  for (const path of candidates) {
    if (!existsSync(path)) continue
    let json: unknown
    try {
      json = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (error) {
      return { status: 'invalid', path, errors: [`unparseable JSON: ${error instanceof Error ? error.message : String(error)}`] }
    }
    const checked = validateEngineManifest(json)
    if (!checked.ok) return { status: 'invalid', path, errors: checked.errors }
    return { status: 'ok', manifest: checked.manifest, path }
  }
  const first = candidates[0] ?? 'engines/manifest.json'
  return {
    status: 'absent',
    path: first,
    // plan r2: dev-period missing manifest degrades to warning + pass; todo34
    // CI generates the real digests into extraResources.
    warnings: [`engine manifest missing (${first}) - sha256 verification SKIPPED (dev fallback)`],
  }
}

// ---------------------------------------------------------------------------
// GPU pack URL templating
// ---------------------------------------------------------------------------

/** Identifies one GPU pack for URL resolution. */
export type PackLocator = {
  engine: ManifestEngineKey
  variant: string
  file: string
}

/** Substitute {engine} {variant} {file}; env override beats the manifest template. */
export function resolvePackUrl(
  manifest: EngineManifest,
  locator: PackLocator,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): string {
  const template =
    env[PACK_BASE_URL_ENV] ??
    manifest.engines[locator.engine]?.gpu?.[locator.variant]?.urlTemplate ??
    manifest.baseUrlTemplate
  return template
    .replaceAll('{engine}', locator.engine)
    .replaceAll('{variant}', locator.variant)
    .replaceAll('{file}', locator.file)
}
