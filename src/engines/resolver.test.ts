import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  OLLAMA_MIN_VERSION,
  createResolver,
  isVersionBelow,
  manifestDeps,
  parseVersionOutput,
  type ResolverDeps,
} from './resolver'
import { ENGINE_MIN_OLLAMA_VERSION, isVersionBelow as apiIsVersionBelow } from '../main/apiServer'
import type { EngineManifest } from './manifest'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

const MANIFEST: EngineManifest = {
  version: 1,
  generated_at: '2026-09-03T00:00:00.000Z',
  baseUrlTemplate: 'https://packs.example/{engine}/{variant}/{file}',
  engines: {
    llama: {
      cpu: { file: 'llama-cpu.exe', sha256: HEX_A, minVersion: 'b5034', platform: 'win32' },
      gpu: { cuda: { file: 'llama-cuda.exe', sha256: HEX_B } },
    },
    sd: { cpu: { file: 'sd-cli.exe', sha256: HEX_A, minVersion: 'b100', platform: 'win32' } },
  },
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

type Harness = {
  deps: ResolverDeps
  versionProbe: ReturnType<typeof vi.fn>
  tmps: string[]
  cleanup(): void
}

function makeHarness(over: Partial<ResolverDeps> = {}): Harness {
  const userDataDir = mkdtempSync(join(tmpdir(), 'las-resolver-ud-'))
  const resourcesPath = mkdtempSync(join(tmpdir(), 'las-resolver-res-'))
  const versionProbe = vi.fn(async () => undefined as string | undefined)
  const deps: ResolverDeps = {
    manifest: MANIFEST,
    manifestStatus: 'ok',
    userDataDir,
    resourcesPath,
    platform: 'win32',
    env: { PATH: 'C:\\fakebin' },
    pathEntries: ['C:\\fakebin'],
    execVersion: versionProbe,
    fileExists: existsSync,
    ...over,
  }
  return {
    deps,
    versionProbe,
    tmps: [userDataDir, resourcesPath],
    cleanup: () => {
      for (const d of [userDataDir, resourcesPath]) rmSync(d, { recursive: true, force: true })
    },
  }
}

describe('resolver cascade priority (plan row 30)', () => {
  it('① system PATH hit above the minVersion floor wins and carries the version', async () => {
    const h = makeHarness({
      fileExists: (p) => p === join('C:\\fakebin', 'llama-server.exe'),
      execVersion: async () => '5100',
    })
    const r = await createResolver(h.deps).resolve('llama')
    expect(r.source).toBe('system')
    if (r.source === 'system') {
      expect(r.bin).toBe(join('C:\\fakebin', 'llama-server.exe'))
      expect(r.version).toBe('5100')
    }
    h.cleanup()
  })

  it('system binary below the floor is REJECTED (TALOS floor) and falls to ② bundled', async () => {
    const h = makeHarness({ execVersion: async () => '5000', shaFile: async () => HEX_A })
    const resolver = createResolver({
      ...h.deps,
      fileExists: (p) =>
        p === join('C:\\fakebin', 'llama-server.exe') ||
        p === join(h.deps.resourcesPath!, 'engines', 'llama-cpu.exe'),
    })
    const r = await resolver.resolve('llama')
    expect(r.source).toBe('bundled-cpu')
    expect(r.skipped).toEqual([{ source: 'system', reason: expect.stringContaining('below minVersion') }])
    h.cleanup()
  })

  it('② bundled CPU binary is sha256-verified against the manifest; mismatch falls through', async () => {
    const h = makeHarness({ shaFile: async () => 'f'.repeat(64) })
    const resolver = createResolver({
      ...h.deps,
      fileExists: (p) => p === join(h.deps.resourcesPath!, 'engines', 'llama-cpu.exe'),
    })
    const r = await resolver.resolve('llama')
    expect(r.source).toBe('none')
    expect(r.skipped[0]?.reason).toContain('sha256 mismatch')
    h.cleanup()
  })

  it('③ active GPU pack resolves after ①② miss; digest re-verified pre-spawn', async () => {
    const h = makeHarness()
    const root = join(h.deps.userDataDir, 'engines')
    mkdirSync(join(root, 'llama-cuda'), { recursive: true })
    const binPath = join(root, 'llama-cuda', 'llama-cuda.exe')
    writeFileSync(binPath, Buffer.from('packed binary bytes'))
    writeFileSync(join(root, 'llama-cuda', 'meta.json'), JSON.stringify({ engine: 'llama', variant: 'cuda', file: 'llama-cuda.exe', sha256: HEX_B, url: 'u', activatedAt: 'now' }), 'utf-8')
    writeFileSync(join(root, 'active.json'), JSON.stringify({ llama: 'cuda' }), 'utf-8')
    const resolver = createResolver({ ...h.deps, shaFile: async () => HEX_B })
    const r = await resolver.resolve('llama', { prefer: 'gpu-pack' })
    expect(r.source).toBe('gpu-pack')
    if (r.source === 'gpu-pack') expect(r.bin).toBe(binPath)
    // manifest pins cuda to HEX_B; a digest change must reject the pack
    const tampered = createResolver({ ...h.deps, shaFile: async () => 'e'.repeat(64) })
    const bad = await tampered.resolve('llama', { prefer: 'gpu-pack' })
    expect(bad.source).toBe('none')
    expect(bad.skipped[0]?.reason).toContain('sha256 mismatch')
    h.cleanup()
  })

  it('ollama is system-only: never bundled, never a GPU pack; floor mirrors apiServer', async () => {
    expect(OLLAMA_MIN_VERSION).toBe(ENGINE_MIN_OLLAMA_VERSION)
    const h = makeHarness({
      manifest: null,
      manifestStatus: 'absent',
      fileExists: (p) => p === join('C:\\fakebin', 'ollama.exe'),
      execVersion: async () => '0.1.12',
      resourcesPath: undefined,
    })
    const r = await createResolver(h.deps).resolve('ollama')
    expect(r.source).toBe('none')
    expect(r.skipped[0]?.reason).toContain('below minVersion')
    h.cleanup()
  })
})

describe('manifest dev-absent warn+pass semantics', () => {
  it('bundled engine resolves by packaging convention WITHOUT sha verification (dev pass)', async () => {
    const h = makeHarness({ manifest: null, manifestStatus: 'absent', shaFile: vi.fn(async () => { throw new Error('must not hash in dev pass') }) })
    const resolver = createResolver({
      ...h.deps,
      fileExists: (p) => p === join(h.deps.resourcesPath!, 'engines', 'llama-server.exe'),
    })
    const r = await resolver.resolve('llama', { prefer: 'bundled-cpu' })
    expect(r.source).toBe('bundled-cpu')
    h.cleanup()
  })

  it('manifest ok but version unprovable -> system refused; manifest absent -> accepted (warn+pass)', async () => {
    const exists = (p: string): boolean => p === join('C:\\fakebin', 'llama-server.exe')
    const strict = makeHarness({ manifestStatus: 'ok', fileExists: exists })
    const r1 = await createResolver(strict.deps).resolve('llama')
    expect(r1.source).toBe('none')
    expect(r1.skipped[0]?.reason).toContain('version unprovable')
    const pass = makeHarness({ manifest: null, manifestStatus: 'absent', fileExists: exists })
    const r2 = await createResolver(pass.deps).resolve('llama')
    expect(r2.source).toBe('system')
    strict.cleanup()
    pass.cleanup()
  })

  it('invalid manifest refuses unverifiable bundled/gpu tiers', async () => {
    const h = makeHarness({ manifest: null, manifestStatus: 'invalid' })
    const resolver = createResolver({ ...h.deps, fileExists: (p) => p === join(h.deps.resourcesPath!, 'engines', 'llama-server.exe') })
    const r = await resolver.resolve('llama')
    expect(r.source).toBe('none')
    expect(r.skipped[0]?.reason).toContain('manifest invalid')
    h.cleanup()
  })
})

describe('resolver behavior: prefer, cache, availability', () => {
  it("prefer='bundled-cpu' starts the cascade there and never runs the PATH probe", async () => {
    const h = makeHarness()
    const r = await createResolver(h.deps).resolve('llama', { prefer: 'bundled-cpu' })
    expect(h.versionProbe).not.toHaveBeenCalled()
    expect(r.source).toBe('none')
    h.cleanup()
  })

  it('results are cached per (name, prefer); invalidate() re-probes', async () => {
    const h = makeHarness({ fileExists: (p) => p === join('C:\\fakebin', 'llama-server.exe') })
    // versionProbe is deps.execVersion; keep it so we can count calls
    const resolver = createResolver(h.deps)
    await resolver.resolve('llama')
    await resolver.resolve('llama')
    expect(h.versionProbe).toHaveBeenCalledTimes(1)
    resolver.invalidate()
    await resolver.resolve('llama')
    expect(h.versionProbe).toHaveBeenCalledTimes(2)
    h.cleanup()
  })

  it('availability matrix covers llama/ollama/sd for the settings UI', async () => {
    const h = makeHarness()
    const rows = await createResolver(h.deps).availability()
    expect(rows.map((r) => r.name)).toEqual(['llama', 'ollama', 'sd'])
    expect(rows.every((r) => r.source === 'none')).toBe(true)
    h.cleanup()
  })
})

describe('version helpers', () => {
  it('parseVersionOutput understands llama.cpp build tags, ollama semver, and garbage', () => {
    expect(parseVersionOutput('llama.cpp version: b5034 (1a2b3c4)')).toBe('5034')
    expect(parseVersionOutput('ollama version is 0.5.7')).toBe('0.5.7')
    expect(parseVersionOutput('no digits here')).toBeUndefined()
  })

  it('isVersionBelow stays semantically equal to the apiServer takeover comparator', () => {
    const cases: Array<[string, string]> = [
      ['5000', 'b5034'],
      ['5100', 'b5034'],
      ['0.1.12', '0.1.13'],
      ['0.1.13', '0.1.13'],
      ['0.2', '0.1.99'],
      ['b45', 'b1000'],
    ]
    for (const [v, m] of cases) {
      expect(isVersionBelow(v, m)).toBe(apiIsVersionBelow(v.replace(/^[A-Za-z]+/, ''), m.replace(/^[A-Za-z]+/, '')))
    }
  })
})

describe('manifestDeps adapter', () => {
  it('maps an absent load to manifest=null + resourcesPath from process', () => {
    const deps = manifestDeps({ status: 'absent', path: 'p', warnings: [] }, '/ud', { platform: 'linux' })
    expect(deps.manifest).toBeNull()
    expect(deps.manifestStatus).toBe('absent')
    expect(deps.userDataDir).toBe('/ud')
    expect(deps.platform).toBe('linux')
    void readFileSync
  })
})
