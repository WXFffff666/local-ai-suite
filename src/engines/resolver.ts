/**
 * Detection-first engine resolver (todo30). Cascade, per plan row 30 verbatim:
 *
 *   ① system PATH    — llama-server / ollama / sd-cli probed via --version and
 *                      checked against the manifest minVersion floor (TALOS-2024-
 *                      1912/13/14/16). NEVER probes 11434: a running external
 *                      Ollama is detected and arbitrated by src/main/apiServer.ts
 *                      ('external-takeover' mode, todo10) — this resolver only
 *                      reports the binary it found, so states stay aligned and
 *                      no duplicate instance is ever spawned by us.
 *   ② extraResources — <resourcesPath>/engines/<cpu.file>, sha256-verified
 *                      against the manifest (dev-absent manifest -> warn + pass).
 *   ③ GPU pack       — the single active pack per engine under
 *                      <userData>/engines/ (gpuPack.ts), sha256-verified.
 *
 * Pure module: every environment touch (PATH scan, version probe, fs, manifest)
 * is an injectable dependency; the Services container owns the wiring and caches.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execFile as cpExecFile } from 'child_process'

import { type EngineManifest, type ManifestEngineKey, type ManifestLoad } from './manifest'
import { enginesRoot, readActive, sha256File, verifyFileSha } from './gpuPack'

export type { EngineBinary } from './manifest'
import type { EngineBinary } from './manifest'

/**
 * Mirrors apiServer.ENGINE_MIN_OLLAMA_VERSION (todo10 owns that constant and the
 * 11434 takeover). Kept equal by test (resolver.test.ts parity case).
 */
export const OLLAMA_MIN_VERSION = '0.1.13'

export type EngineSource = 'system' | 'bundled-cpu' | 'gpu-pack'

/** Rejection recorded while falling through a cascade tier. */
export type SkipNote = { source: EngineSource; reason: string }

/** Raw tier outcome (no cascade bookkeeping). */
type TierHit = { name: EngineBinary; source: EngineSource; bin: string; version?: string }

export type ResolvedEngineHit = TierHit & {
  /** Rejections encountered on the way down the cascade (UI diagnostics). */
  skipped: SkipNote[]
}

export type ResolvedEngineMiss = {
  name: EngineBinary
  source: 'none'
  bin: null
  skipped: SkipNote[]
}

export type ResolvedEngine = ResolvedEngineHit | ResolvedEngineMiss

export type ResolveOptions = {
  /**
   * 'auto' = full cascade ①→②→③. A named source = start the cascade there
   * (still falling through forwards), e.g. 'bundled-cpu' skips the PATH probe.
   */
  prefer?: 'auto' | EngineSource
}

export type VersionProbe = (binPath: string) => Promise<string | undefined>

export type ResolverDeps = {
  /** null = manifest absent/invalid -> verification is SKIPPED (warn + pass). */
  manifest: EngineManifest | null
  manifestStatus: 'ok' | 'absent' | 'invalid'
  env?: Record<string, string | undefined>
  resourcesPath?: string
  userDataDir: string
  platform?: NodeJS.Platform
  /** Absolute exe candidates per engine, PATH-scanned; default built from engine name. */
  pathEntries?: string[]
  execVersion?: VersionProbe
  fileExists?: (p: string) => boolean
  shaFile?: (p: string) => Promise<string>
}

type EngineProfile = {
  /** EXE names (without extension) to look for on PATH. */
  pathExes: string[]
  /** Manifest key carrying cpu/gpu specs; undefined = system-only engine (ollama). */
  manifestKey: ManifestEngineKey | undefined
  /** Security floor when no manifest exists (ollama: the takeover floor). */
  fallbackMinVersion?: string
}

const PROFILES: Record<EngineBinary, EngineProfile> = {
  llama: { pathExes: ['llama-server'], manifestKey: 'llama' },
  sd: { pathExes: ['sd-server', 'sd-cli'], manifestKey: 'sd' },
  ollama: {
    pathExes: ['ollama'],
    manifestKey: undefined,
    fallbackMinVersion: OLLAMA_MIN_VERSION,
  },
}

const CASCADE: EngineSource[] = ['system', 'bundled-cpu', 'gpu-pack']

// ---------------------------------------------------------------------------
// Version compare (semver-ish leading-integer compare; must stay semantically
// equal to apiServer.isVersionBelow, which owns the same rule for the takeover)
// ---------------------------------------------------------------------------

export function isVersionBelow(version: string, minimum: string): boolean {
  const seg = (v: string): number[] =>
    v
      .replace(/^[A-Za-z]+/, '')
      .split('.')
      .map((s) => Number.parseInt(s, 10) || 0)
  const a = seg(version)
  const b = seg(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av < bv
  }
  return false
}

/** Extract a version from `--version` stdout: semver or llama.cpp 'version: bNNNN'. */
export function parseVersionOutput(stdout: string): string | undefined {
  const semver = stdout.match(/v?(\d+\.\d+(?:\.\d+)?)/)
  if (semver?.[1]) return semver[1]
  const build = stdout.match(/version:\s*b?(\d{3,6})/i) ?? stdout.match(/\bb(\d{3,6})\b/i)
  return build?.[1]
}

async function defaultExecVersion(binPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    cpExecFile(binPath, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err !== null && err !== undefined ? undefined : parseVersionOutput(stdout))
    })
  })
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export type EngineResolver = {
  resolve(name: EngineBinary, opts?: ResolveOptions): Promise<ResolvedEngine>
  /** Availability matrix for the settings UI (lane-30b renders it). */
  availability(names?: readonly EngineBinary[]): Promise<ResolvedEngine[]>
  invalidate(): void
}

function exeCandidates(exe: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${exe}.exe`, exe] : [exe]
}

function findOnPath(exe: string, deps: ResolverDeps): string | undefined {
  const pathEnv = (deps.env ?? process.env)['PATH'] ?? ''
  const dirs = deps.pathEntries ?? pathEnv.split(';').flatMap((p) => (p.trim() ? [p.trim()] : []))
  for (const dir of dirs) {
    for (const cand of exeCandidates(exe, deps.platform ?? process.platform)) {
      const full = join(dir, cand)
      if ((deps.fileExists ?? existsSync)(full)) return full
    }
  }
  return undefined
}

function minVersionFor(name: EngineBinary, deps: ResolverDeps): string | undefined {
  const profile = PROFILES[name]
  const fromManifest =
    profile.manifestKey !== undefined && deps.manifest !== null
      ? deps.manifest.engines[profile.manifestKey]?.cpu.minVersion
      : undefined
  return fromManifest ?? profile.fallbackMinVersion
}

async function trySystem(name: EngineBinary, deps: ResolverDeps): Promise<TierHit | { reason: string } | null> {
  const profile = PROFILES[name]
  let found: string | undefined
  for (const exe of profile.pathExes) {
    found = findOnPath(exe, deps)
    if (found) break
  }
  if (!found) return null
  const version = await (deps.execVersion ?? defaultExecVersion)(found)
  const floor = minVersionFor(name, deps)
  if (floor !== undefined) {
    if (version === undefined) {
      // Floor exists but the binary will not state a version: refuse (TALOS fix
      // r1) — except when the manifest itself is absent, where the whole-floor
      // regime is dev warn+pass.
      if (deps.manifestStatus === 'ok') return { reason: `version unprovable below floor ${floor}` }
    } else if (isVersionBelow(version, floor)) {
      return { reason: `version ${version} below minVersion ${floor}` }
    }
  }
  const hit: TierHit = { name, source: 'system', bin: found }
  if (version !== undefined) hit.version = version
  return hit
}

async function tryBundled(name: EngineBinary, deps: ResolverDeps): Promise<TierHit | { reason: string } | null> {
  const profile = PROFILES[name]
  if (profile.manifestKey === undefined) return null // ollama is never bundled
  if (deps.resourcesPath === undefined) return null
  if (deps.manifestStatus === 'invalid') return { reason: 'manifest invalid - unverifiable bundled binary refused' }
  const spec = deps.manifest?.engines[profile.manifestKey]?.cpu
  // Dev-absent manifest: fall back to the packaging convention <engines>/<exe>.exe.
  const file = spec?.file ?? `${profile.pathExes[0]}${(deps.platform ?? process.platform) === 'win32' ? '.exe' : ''}`
  const bin = join(deps.resourcesPath, 'engines', file)
  if (!(deps.fileExists ?? existsSync)(bin)) return null
  if (deps.manifestStatus === 'absent' || spec === undefined) return { name, source: 'bundled-cpu', bin }
  const hash = deps.shaFile === undefined ? undefined : await deps.shaFile(bin)
  const verified = hash !== undefined ? hash === spec.sha256 : await verifyFileSha(bin, spec.sha256)
  if (!verified) return { reason: `bundled ${name} sha256 mismatch` }
  return { name, source: 'bundled-cpu', bin }
}

async function tryGpuPack(name: EngineBinary, deps: ResolverDeps): Promise<TierHit | { reason: string } | null> {
  const profile = PROFILES[name]
  if (profile.manifestKey === undefined) return null
  const root = enginesRoot(deps.userDataDir)
  const variant = readActive(root)[name]
  if (variant === undefined) return null
  const dir = join(root, `${name}-${variant}`)
  const metaPath = join(dir, 'meta.json')
  if (!(deps.fileExists ?? existsSync)(metaPath)) return { reason: `active gpu pack '${variant}' missing (no meta.json)` }
  let meta: { file?: unknown; sha256?: unknown }
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { file?: unknown; sha256?: unknown }
  } catch {
    return { reason: `active gpu pack '${variant}' meta.json unreadable` }
  }
  if (typeof meta.file !== 'string') return { reason: `active gpu pack '${variant}' meta.json invalid` }
  const bin = join(dir, meta.file)
  if (!(deps.fileExists ?? existsSync)(bin)) return { reason: `active gpu pack '${variant}' binary missing` }
  if (deps.manifestStatus === 'invalid') return { reason: 'manifest invalid - unverifiable gpu pack refused' }
  // Verify pre-spawn (plan: resolver hash-checks before spawn). The manifest pin
  // wins when the manifest is loadable; otherwise the install-time meta.json
  // digest is the integrity source. Dev-absent manifest with no meta digest:
  // warn + pass (only reachable hand-made packs, never downloadPack output).
  const expected =
    (deps.manifestStatus === 'ok' ? deps.manifest?.engines[profile.manifestKey]?.gpu?.[variant]?.sha256 : undefined) ??
    (typeof meta.sha256 === 'string' ? meta.sha256 : undefined)
  if (expected !== undefined) {
    const hash = deps.shaFile === undefined ? await sha256File(bin) : await deps.shaFile(bin)
    if (hash !== expected.toLowerCase()) return { reason: `gpu pack '${variant}' sha256 mismatch` }
  }
  return { name, source: 'gpu-pack', bin }
}

export function createResolver(deps: ResolverDeps): EngineResolver {
  const cache = new Map<string, ResolvedEngine>()
  const tiers: Record<EngineSource, (n: EngineBinary, d: ResolverDeps) => Promise<TierHit | { reason: string } | null>> = {
    system: trySystem,
    'bundled-cpu': tryBundled,
    'gpu-pack': tryGpuPack,
  }
  const startIdx = (prefer: ResolveOptions['prefer']): number =>
    prefer === undefined || prefer === 'auto' ? 0 : CASCADE.indexOf(prefer)

  const probe = async (name: EngineBinary, opts?: ResolveOptions): Promise<ResolvedEngine> => {
    const skipped: SkipNote[] = []
    const from = startIdx(opts?.prefer)
    if (from < 0) throw new Error(`unknown prefer source: ${String(opts?.prefer)}`)
    for (const source of CASCADE.slice(from)) {
      const outcome = await tiers[source](name, deps)
      if (outcome === null) continue
      if ('reason' in outcome) {
        skipped.push({ source, reason: outcome.reason })
        continue
      }
      return { ...outcome, skipped }
    }
    return { name, source: 'none', bin: null, skipped }
  }

  return {
    async resolve(name, opts) {
      const key = `${name}:${opts?.prefer ?? 'auto'}`
      const cached = cache.get(key)
      if (cached) return cached
      const result = await probe(name, opts)
      cache.set(key, result)
      return result
    },
    async availability(names = ['llama', 'ollama', 'sd']) {
      const out: ResolvedEngine[] = []
      for (const n of names) out.push(await this.resolve(n))
      return out
    },
    invalidate() {
      cache.clear()
    },
  }
}

/** Manifest-load -> resolver-deps adapter used by the Services container. */
export function manifestDeps(load: ManifestLoad, userDataDir: string, extra: Partial<ResolverDeps> = {}): ResolverDeps {
  const manifest = load.status === 'ok' ? load.manifest : null
  return {
    manifest,
    manifestStatus: load.status,
    userDataDir,
    resourcesPath: typeof process !== 'undefined' ? process.resourcesPath : undefined,
    ...extra,
  }
}
