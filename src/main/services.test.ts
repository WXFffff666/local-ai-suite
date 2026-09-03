import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getServices, initServices, resetServices, SIDECAR_NAMES, type ServicesOptions } from './services'
import { resetShutdownState, shutdownServices } from './shutdown'
import { readSidecarsJson, SIDECARS_FILENAME } from '../core/handshake'
import { deterministicPort } from '../core/ports'
import type { EngineResolver, ResolvedEngine } from '../engines/resolver'

// --- fakes: no real spawn / net / electron / chokidar ------------------------

function mockChild(pid: number) {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number
    killed: boolean
    exitCode: number | null
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter
    stderr: EventEmitter
  }
  ee.pid = pid
  ee.killed = false
  ee.exitCode = null
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.kill = vi.fn(() => {
    ee.killed = true
    return true
  })
  return ee
}

function makeFakeWatcher() {
  const events = new Map<string, (...args: unknown[]) => void>()
  const watcher = {
    events,
    closeCalls: 0,
    on: (ev: string, cb: (...args: unknown[]) => void) => {
      events.set(ev, cb)
      return watcher
    },
    close: async (): Promise<void> => {
      watcher.closeCalls += 1
    },
  }
  return watcher
}

type Probe = (host: string, port: number) => Promise<boolean>

interface Harness {
  services: ReturnType<typeof getServices>
  spawnCalls: Array<{ bin: string; args: string[] }>
  children: ReturnType<typeof mockChild>[]
  watcher: ReturnType<typeof makeFakeWatcher>
  warns: Array<{ message: string; error: unknown }>
  userDataDir: string
}

function createHarness(overrides: Partial<ServicesOptions> = {}, probePort: Probe = async () => true): Harness {
  const userDataDir = mkdtempSync(join(tmpdir(), 'las-services-userdata-'))
  const modelsDir = mkdtempSync(join(tmpdir(), 'las-services-models-'))
  const galleryDir = mkdtempSync(join(tmpdir(), 'las-services-gallery-'))
  const logDir = mkdtempSync(join(tmpdir(), 'las-services-logs-'))
  tmpRoots.push(userDataDir, modelsDir, galleryDir, logDir)

  const spawnCalls: Harness['spawnCalls'] = []
  const children: Harness['children'] = []
  const warns: Harness['warns'] = []
  const watcher = makeFakeWatcher()

  // All AppConfig-derived defaults are injected here on purpose:
  // resolveOptions() then never calls getConfig(), so require('electron')
  // is never touched (learnings.md: real electron package load stalls vitest).
  // engineResolver: null keeps the todo7 spawn baseline (env-only bin default);
  // todo30 resolver behavior is covered by dedicated harnesses below.
  const options: ServicesOptions = {
    userDataDir,
    modelsDir,
    galleryBaseDir: galleryDir,
    logDir,
    llamaPort: 11435,
    ollamaPort: 11434,
    sdPort: 11436,
    engineResolver: null,
    warn: (message, error) => warns.push({ message, error }),
    sidecarOptions: {
      spawner: ((bin: string, args: string[]) => {
        spawnCalls.push({ bin, args })
        const child = mockChild(1000 + spawnCalls.length)
        children.push(child)
        return child as never
      }) as never,
      probePort,
      fetcher: async () => true,
      healthIntervalMs: 60_000,
    },
    registryOptions: { watcherFactory: (() => watcher) as never },
    ...overrides,
  }
  return { services: getServices(options), spawnCalls, children, watcher, warns, userDataDir }
}

let tmpRoots: string[] = []

beforeEach(() => {
  resetShutdownState()
  resetServices()
  tmpRoots = []
})

afterEach(() => {
  resetShutdownState()
  resetServices()
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

describe('services container — lazy wiring (todo7)', () => {
  it('(a) getServices returns the same singleton on every call', () => {
    const h = createHarness()
    expect(getServices()).toBe(h.services)
    expect(getServices({ userDataDir: 'ignored-after-first-create' })).toBe(h.services)
    expect([...SIDECAR_NAMES]).toEqual(['llama', 'ollama', 'sd'])
  })

  it('(b) startup spawns nothing; initServices starts the watch and publishes an empty roster', async () => {
    const h = createHarness()
    const services = await initServices()
    expect(services).toBe(h.services)
    expect(h.spawnCalls).toHaveLength(0)
    expect(services.sidecarStatuses()).toEqual([])
    expect(h.watcher.events.size).toBeGreaterThan(0) // chokidar fake wired to add/change/unlink
    const roster = JSON.parse(readFileSync(join(h.userDataDir, SIDECARS_FILENAME), 'utf8')) as {
      version: number
      entries: unknown[]
    }
    expect(roster.version).toBe(1)
    expect(roster.entries).toEqual([])
  })

  it('(c) ensureSidecar(llama) creates lazily and spawns exactly once, even when raced', async () => {
    const h = createHarness()
    expect(h.services.getSidecar('llama')).toBeUndefined()
    const [first, second] = await Promise.all([
      h.services.ensureSidecar('llama'),
      h.services.ensureSidecar('llama'),
    ])
    expect(h.spawnCalls).toHaveLength(1)
    expect(h.spawnCalls[0]?.bin).toBe('llama-server')
    expect(first.state).toBe('running')
    expect(second).toEqual(first)
    await shutdownServices()
  })

  it('(e) sidecars.json carries the resolved dynamic port when 11435 is occupied', async () => {
    const h = createHarness({}, async (_host, port) => port !== 11435)
    await h.services.ensureSidecar('llama')
    const resolved = deterministicPort('llama')
    expect(h.services.getSidecar('llama')?.getStatus().port).toBe(resolved)
    const entries = readSidecarsJson(h.userDataDir)
    expect(entries).toEqual([{ name: 'llama', port: resolved, pid: 1001 }])
    expect(entries[0]?.port).not.toBe(11435)
    await shutdownServices()
  })

  it('(d) shutdown stops every owned resource; a second run stops nothing again', async () => {
    const h = createHarness()
    await h.services.ensureSidecar('llama')
    await h.services.ensureSidecar('sd')
    void h.services.gallery
    void h.services.registry // lazy-create: watch starts, close hook registered
    const queue = h.services.imageQueue
    const jobId = queue.enqueue({ prompt: 'draw' })

    const result = await shutdownServices()
    expect(result.errors).toEqual([])

    for (const child of h.children) expect(child.kill).toHaveBeenCalledTimes(1)
    expect(h.services.sidecarStatuses().every((s) => s.state === 'stopped')).toBe(true)
    expect(h.watcher.closeCalls).toBe(1)
    await vi.waitFor(() => expect(queue.getJob(jobId)?.status).toBe('cancelled'))
    expect(queue.pending).toBe(0)
    // handshake final write (registered first => runs last) reflects the stopped roster
    expect(readSidecarsJson(h.userDataDir)).toEqual([])

    await shutdownServices() // idempotent: same run, no double stop
    for (const child of h.children) expect(child.kill).toHaveBeenCalledTimes(1)
    expect(h.watcher.closeCalls).toBe(1)
  })

  it('handshake write failure is isolated — warn sink fires, container survives', () => {
    const blockerRoot = mkdtempSync(join(tmpdir(), 'las-services-blocker-'))
    tmpRoots.push(blockerRoot)
    const blocker = join(blockerRoot, 'blocker')
    writeFileSync(blocker, 'a file, not a directory')
    const h = createHarness({ userDataDir: join(blocker, 'nested') })
    expect(() => h.services.refreshHandshake()).not.toThrow()
    expect(h.warns.some((w) => w.message.includes('sidecars.json write failed'))).toBe(true)
    expect(existsSync(join(blocker, 'nested', SIDECARS_FILENAME))).toBe(false)
  })

  it('onSidecarEvent buffers listeners created before the manager and unsubscribes cleanly', async () => {
    const h = createHarness()
    const seen: string[] = []
    const off = h.services.onSidecarEvent('llama', (event) => seen.push(event))
    await h.services.ensureSidecar('llama')
    h.services.getSidecar('llama')?.restart()
    expect(seen).toEqual(['restarting'])
    off()
    const manager = h.services.getSidecar('llama')
    manager?.stop()
    manager?.restart()
    expect(seen).toEqual(['restarting'])
    await shutdownServices()
  })

  it('search orchestrator falls through sources: errors isolated, first non-empty wins', async () => {
    const boom = vi.fn(async () => {
      throw new Error('searxng down')
    })
    const empty = vi.fn(async () => [])
    const hit = vi.fn(async () => [{ title: 'Qwen3', url: 'https://a.example/1', snippet: 'run local llm' }])
    const h = createHarness({ searchAdapters: [{ search: boom }, { search: empty }, { search: hit }] })
    const result = await h.services.search.search('qwen3')
    expect(result.ranked).toHaveLength(1)
    expect(boom).toHaveBeenCalledTimes(1)
    expect(hit).toHaveBeenCalledTimes(1)
    expect(h.warns.some((w) => w.message.includes('searxng down'))).toBe(true)
    await shutdownServices()
  })
})

// ---------------------------------------------------------------------------
// todo30 — engine resolver integration (bin precedence + model/projector hop)
// ---------------------------------------------------------------------------

function fakeResolver(bins: Record<string, string | null>, onResolve?: (name: string) => void): EngineResolver {
  const resolve = async (name: string): Promise<ResolvedEngine> => {
    onResolve?.(name)
    const bin = bins[name] ?? null
    if (bin === null) return { name: name as never, source: 'none', bin: null, skipped: [] }
    return { name: name as never, source: 'system', bin, skipped: [] }
  }
  return {
    resolve: resolve as EngineResolver['resolve'],
    availability: async () => [],
    invalidate: () => undefined,
  }
}

describe('services engine resolver integration (todo30)', () => {
  it('resolver bin is used when no env override is present (replaces raw default)', async () => {
    const h = createHarness({ engineResolver: fakeResolver({ llama: 'C:\\packed\\llama-server.exe' }) })
    await h.services.ensureSidecar('llama')
    expect(h.spawnCalls[0]?.bin).toBe('C:\\packed\\llama-server.exe')
    await shutdownServices()
  })

  it('LLAMA_BIN env override wins and the resolver is never consulted', async () => {
    let consulted = false
    const prev = process.env['LLAMA_BIN']
    process.env['LLAMA_BIN'] = 'C:\\env\\llama-server.exe'
    try {
      const h = createHarness({
        engineResolver: fakeResolver({ llama: 'C:\\resolver\\llama-server.exe' }, () => {
          consulted = true
        }),
      })
      await h.services.ensureSidecar('llama')
      expect(h.spawnCalls[0]?.bin).toBe('C:\\env\\llama-server.exe')
      expect(consulted).toBe(false)
    } finally {
      if (prev === undefined) delete process.env['LLAMA_BIN']
      else process.env['LLAMA_BIN'] = prev
      await shutdownServices()
    }
  })

  it("resolver 'none' keeps the factory default bin (bare command name)", async () => {
    const h = createHarness({ engineResolver: fakeResolver({ llama: null }) })
    await h.services.ensureSidecar('llama')
    expect(h.spawnCalls[0]?.bin).toBe('llama-server')
    await shutdownServices()
  })

  it('ensureSidecar(llama, {modelPath, mmprojPath}) injects --model/--mmproj (todo21 last hop)', async () => {
    const modelDir = mkdtempSync(join(tmpdir(), 'las-model-'))
    tmpRoots.push(modelDir)
    const modelPath = join(modelDir, 'qwen.gguf')
    const mmprojPath = join(modelDir, 'mmproj.gguf')
    writeFileSync(modelPath, 'GGUF fake model')
    writeFileSync(mmprojPath, 'GGUF fake projector')
    const h = createHarness({ engineResolver: null })
    await h.services.ensureSidecar('llama', { modelPath, mmprojPath })
    const args = h.spawnCalls[0]?.args ?? []
    expect(args).toEqual(expect.arrayContaining(['--model', modelPath, '--mmproj', mmprojPath]))
    await shutdownServices()
  })

  it('no-modelPath baseline argv is byte-for-byte unchanged (regression pin)', async () => {
    const h = createHarness({ engineResolver: null })
    await h.services.ensureSidecar('llama')
    expect(h.spawnCalls[0]?.args).toEqual(['--host', '127.0.0.1', '--port', '11435', '--ctx-size', '4096'])
    await shutdownServices()
  })

  it('launchModel resolves registry entry and spawns llama with --model + paired --mmproj', async () => {
    const modelDir = mkdtempSync(join(tmpdir(), 'las-launch-'))
    tmpRoots.push(modelDir)
    // gguf with valid 4-byte magic so the registry probe marks it non-corrupted
    writeFileSync(join(modelDir, 'qwen3-4b.gguf'), 'GGUF' + 'x'.repeat(200))
    writeFileSync(join(modelDir, 'mmproj-qwen3-4b.gguf'), 'GGUF' + 'y'.repeat(200))
    const h = createHarness({ engineResolver: null, modelsDir: modelDir })
    // force a synchronous scan so getModels() sees the fixtures
    h.services.registry.reloadModels()
    const status = await h.services.launchModel('qwen3-4b')
    expect(status.name).toBe('llama')
    const args = h.spawnCalls[0]?.args ?? []
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe(join(modelDir, 'qwen3-4b.gguf'))
    expect(args).toContain('--mmproj')
    await shutdownServices()
  })

  it('launchModel rejects unknown / non-gguf models with a specific reason', async () => {
    const modelDir = mkdtempSync(join(tmpdir(), 'las-launch2-'))
    tmpRoots.push(modelDir)
    writeFileSync(join(modelDir, 'pic.safetensors'), 'x'.repeat(2048)) // ≥1KB skips the magic probe -> valid entry, wrong format
    const h = createHarness({ engineResolver: null, modelsDir: modelDir })
    h.services.registry.reloadModels()
    await expect(h.services.launchModel('does-not-exist')).rejects.toThrow(/model not found/)
    await expect(h.services.launchModel('pic')).rejects.toThrow(/not launchable/)
    await shutdownServices()
  })

  it('dev-absent manifest warns (plan r2 warn+pass) when the default resolver is built', async () => {
    const h = createHarness({
      engineResolver: undefined,
      engineManifestLoad: { status: 'absent', path: 'nowhere/manifest.json', warnings: ['engine manifest missing - sha256 verification SKIPPED'] },
    })
    expect(h.services.engineResolver).not.toBeNull()
    expect(h.warns.some((w) => w.message.includes('SKIPPED'))).toBe(true)
    await shutdownServices()
  })

  it('model switch on a running sidecar restarts the child with the new argv', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'las-switch-'))
    tmpRoots.push(dir)
    const a = join(dir, 'a.gguf')
    const b = join(dir, 'b.gguf')
    writeFileSync(a, 'GGUF a')
    writeFileSync(b, 'GGUF b')
    const h = createHarness({ engineResolver: null })
    await h.services.ensureSidecar('llama', { modelPath: a })
    const firstChild = h.children[0]
    await h.services.ensureSidecar('llama', { modelPath: b })
    expect(firstChild?.kill).toHaveBeenCalled()
    await vi.waitFor(() => expect(h.spawnCalls.length).toBe(2))
    const lastArgs = h.spawnCalls[1]?.args ?? []
    expect(lastArgs).toContain(b)
    await shutdownServices()
  })
})
