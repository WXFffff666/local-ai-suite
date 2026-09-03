import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  MANIFEST_VERSION,
  defaultManifestCandidates,
  loadEngineManifest,
  resolvePackUrl,
  validateEngineManifest,
  type EngineManifest,
} from './manifest'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

function baseManifest(): EngineManifest {
  return {
    version: MANIFEST_VERSION,
    generated_at: '2026-09-03T00:00:00.000Z',
    baseUrlTemplate: 'https://packs.example/{engine}/{variant}/{file}',
    engines: {
      llama: {
        cpu: { file: 'llama-server.exe', sha256: HEX_A, minVersion: 'b5034', platform: 'win32' },
        gpu: { cuda: { file: 'llama-server-cuda.exe', sha256: HEX_B } },
      },
      sd: {
        cpu: { file: 'sd-cli.exe', sha256: HEX_A, minVersion: 'b1234', platform: 'win32' },
      },
    },
  }
}

describe('validateEngineManifest (boundary parser)', () => {
  it('accepts a well-formed manifest incl. optional whisper key', () => {
    const m = { ...baseManifest(), engines: { ...baseManifest().engines, whisper: baseManifest().engines.llama } }
    const r = validateEngineManifest(m)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.engines.whisper?.cpu.file).toBe('llama-server.exe')
  })

  it('rejects wrong version / non-object root / unknown engine key', () => {
    expect(validateEngineManifest('x').ok).toBe(false)
    expect(validateEngineManifest({ ...baseManifest(), version: 2 }).ok).toBe(false)
    const r = validateEngineManifest({ ...baseManifest(), engines: { ...baseManifest().engines, zzz: baseManifest().engines.llama } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('unknown engine key')
  })

  it('rejects malformed cpu spec (sha256 not hex, empty file, bad version)', () => {
    const bad = {
      ...baseManifest(),
      engines: {
        llama: { cpu: { file: '', sha256: 'nothex', minVersion: '!!', platform: 'win32' } },
      },
    }
    const r = validateEngineManifest(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('rejects malformed gpu variants', () => {
    const bad = {
      ...baseManifest(),
      engines: {
        ...baseManifest().engines,
        llama: {
          cpu: baseManifest().engines.llama!.cpu,
          gpu: { cuda: { file: 'x', sha256: 'short' } },
        },
      },
    }
    const r = validateEngineManifest(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('sha256')
  })
})

describe('loadEngineManifest (dev-absent -> warn + pass)', () => {
  it('absent -> status absent with a warning that verification is skipped', () => {
    const load = loadEngineManifest({
      candidatePaths: [join(tmpdir(), 'las-does-not-exist-xyz', 'manifest.json')],
    })
    expect(load.status).toBe('absent')
    if (load.status !== 'absent') throw new Error('unreachable')
    expect(load.warnings.join(' ')).toMatch(/SKIPPED/)
  })

  it('valid file -> ok with parsed manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'las-manifest-'))
    try {
      const p = join(dir, 'manifest.json')
      writeFileSync(p, JSON.stringify(baseManifest()), 'utf-8')
      const load = loadEngineManifest({ candidatePaths: [p] })
      expect(load.status === 'ok' && load.manifest.baseUrlTemplate).toBe(baseManifest().baseUrlTemplate)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('present-but-malformed -> invalid (never warn+pass on unverifiable digests)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'las-manifest-'))
    try {
      const p = join(dir, 'manifest.json')
      writeFileSync(p, '{ not json', 'utf-8')
      const load = loadEngineManifest({ candidatePaths: [p] })
      expect(load.status).toBe('invalid')
      if (load.status === 'invalid') expect(load.errors.join(' ')).toContain('unparseable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolvePackUrl', () => {
  const m = baseManifest()
  it('substitutes {engine} {variant} {file} from baseUrlTemplate', () => {
    expect(resolvePackUrl(m, { engine: 'llama', variant: 'cuda', file: 'llama-server-cuda.exe' }, {})).toBe(
      'https://packs.example/llama/cuda/llama-server-cuda.exe',
    )
  })
  it('per-variant urlTemplate wins over baseUrlTemplate; env wins over both', () => {
    const withVariant = {
      ...m,
      engines: {
        ...m.engines,
        llama: {
          cpu: m.engines.llama!.cpu,
          gpu: { cuda: { file: 'f', sha256: HEX_B, urlTemplate: 'https://pin.example/{file}' } },
        },
      },
    }
    expect(resolvePackUrl(withVariant, { engine: 'llama', variant: 'cuda', file: 'f' }, {})).toBe('https://pin.example/f')
    expect(
      resolvePackUrl(withVariant, { engine: 'llama', variant: 'cuda', file: 'f' }, { ENGINE_PACK_BASE_URL: 'https://env.example/{engine}/{file}' }),
    ).toBe('https://env.example/llama/f')
  })
})

describe('defaultManifestCandidates', () => {
  it('prefers extraResources engines/ then repo build/engines', () => {
    const c = defaultManifestCandidates('/opt/app/resources', '/repo')
    expect(c[0]).toBe(join('/opt/app/resources', 'engines', 'manifest.json'))
    expect(c[1]).toBe(join('/repo', 'build', 'engines', 'manifest.json'))
  })
  it('omits the resources candidate when not packaged', () => {
    const c = defaultManifestCandidates(undefined, '/repo')
    expect(c).toEqual([join('/repo', 'build', 'engines', 'manifest.json')])
  })
})
