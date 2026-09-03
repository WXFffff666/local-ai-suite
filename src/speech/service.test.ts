/**
 * service.test.ts — WhisperService lifecycle units. No real child, no socket:
 * SidecarManager receives the standard spawner/probePort DI trio; the /health
 * and /inference hops go through the injected fetchImpl. Proves the spawn-free
 * status contract, one-manager reuse, argv, sha gate and the health budget.
 */
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

import { WhisperService } from './service'
import type { ManifestLoad } from '../engines/manifest'

function fakeChild(): EventEmitter & {
  pid: number
  killed: boolean
  exitCode: number | null
  stdout: EventEmitter
  stderr: EventEmitter
  kill: () => boolean
} {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(): boolean {
      child.killed = true
      return true
    },
  })
  return child
}

type Options = {
  /** corrupt the manifest pin to exercise the sha gate */
  wrongSha?: boolean
  /** manifest absent AND no exe on disk -> engine-missing path */
  engineMissing?: boolean
  /** override every fetch outcome (health-timeout case) */
  fetchImpl?: (url: string) => Promise<{ status: number; text(): Promise<string> }>
  healthWaitMs?: number
}

function makeService(opts: Options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'las-whisper-'))
  const modelPath = path.join(dir, 'ggml-base.bin')
  writeFileSync(modelPath, 'fake-model')
  const exeDir = path.join(dir, 'engines', 'whisper')
  mkdirSync(exeDir, { recursive: true })
  const exePath = path.join(exeDir, 'whisper-server.exe')
  writeFileSync(exePath, 'fake-exe')
  const exeSha = createHash('sha256').update('fake-exe').digest('hex')

  const child = fakeChild()
  const spawner = vi.fn(() => child as never)
  const fetches: string[] = []
  const fetchImpl =
    opts.fetchImpl ??
    (async (url: string) => {
      fetches.push(url)
      if (url.endsWith('/health')) return { status: 200, text: async () => '{"status":"ok"}' }
      return { status: 200, text: async () => JSON.stringify({ text: 'transcribed' }) }
    })

  const manifest: ManifestLoad = opts.engineMissing
    ? { status: 'absent', path: 'mem', warnings: ['absent'] }
    : {
        status: 'ok',
        path: 'mem',
        manifest: {
          version: 1,
          generated_at: 'now',
          baseUrlTemplate: 'x',
          engines: {
            whisper: {
              cpu: {
                file: 'whisper/whisper-server.exe',
                sha256: opts.wrongSha ? '0'.repeat(64) : exeSha,
                minVersion: 'b4938',
                platform: 'win32',
              },
            },
          },
        },
      }

  const service = new WhisperService({
    env: {},
    cwd: opts.engineMissing ? path.join(dir, 'nowhere') : dir,
    logDir: dir,
    resourcesPath: opts.engineMissing ? undefined : dir,
    manifestLoad: manifest,
    fetchImpl: fetchImpl as never,
    healthPollMs: 5,
    healthWaitMs: opts.healthWaitMs ?? 1000,
    managerOptions: { spawner, probePort: async () => true },
  })
  return { service, dir, modelPath, spawner, fetchImpl, fetches, child }
}

describe('WhisperService — lazy spawn contract', () => {
  it('status() never spawns (chat mount probe + e2e zero-side-effect invariant)', () => {
    const { service, spawner } = makeService()
    const st = service.status()
    expect(spawner).not.toHaveBeenCalled()
    expect(st.running).toBe(false)
    expect(st.state).toBe('stopped')
    expect(st.engine.source).toBe('bundled')
  })

  it('first transcribe spawns whisper-server with loopback argv; second call reuses the running manager', async () => {
    const { service, spawner, modelPath, fetches, fetchImpl } = makeService()
    const text = await service.transcribe({ wav: new Uint8Array([1]), modelPath })
    expect(text).toBe('transcribed')
    expect(spawner).toHaveBeenCalledTimes(1)
    const [bin, args] = spawner.mock.calls[0] as unknown as [string, string[]]
    expect(bin).toMatch(/whisper-server\.exe$/)
    expect(args.slice(0, 4)).toEqual(['--host', '127.0.0.1', '--port', '11437'])
    expect(args[args.indexOf('--model') + 1]).toBe(modelPath)
    // health polled before the inference POST
    expect(fetches[0]).toMatch(/\/health$/)
    expect(fetches.at(-1)).toMatch(/\/inference$/)

    await service.transcribe({ wav: new Uint8Array([2]), modelPath })
    expect(spawner).toHaveBeenCalledTimes(1)
    service.stop()
  })

  it('bundled sha256 mismatch is refused BEFORE the binary is spawned', async () => {
    const { service, spawner, modelPath } = makeService({ wrongSha: true })
    await expect(service.transcribe({ wav: new Uint8Array(), modelPath })).rejects.toThrow(/sha256/)
    expect(spawner).not.toHaveBeenCalled()
  })

  it('missing engine binary -> loud not-found error, nothing spawned', async () => {
    const { service, spawner, modelPath } = makeService({ engineMissing: true })
    await expect(service.transcribe({ wav: new Uint8Array(), modelPath })).rejects.toThrow(/engine binary not found/)
    expect(spawner).not.toHaveBeenCalled()
    expect(service.status().engine).toEqual({ bin: null, source: 'none' })
  })

  it('health stays 503 (model loading) beyond the budget -> bounded error, no restart storm', async () => {
    const { service, modelPath, spawner } = makeService({
      fetchImpl: async (url: string) =>
        url.endsWith('/health')
          ? { status: 503, text: async () => '{"status":"loading model"}' }
          : { status: 200, text: async () => '{}' },
      healthWaitMs: 30,
    })
    await expect(service.transcribe({ wav: new Uint8Array(), modelPath })).rejects.toThrow(/not healthy/)
    expect(spawner).toHaveBeenCalledTimes(1)
  })

  it('model switch swaps argv and respawns the SAME manager (spawner #2 sees the new --model)', async () => {
    const { service, dir, modelPath, spawner } = makeService()
    await service.transcribe({ wav: new Uint8Array(), modelPath })
    const other = path.join(dir, 'ggml-large.bin')
    writeFileSync(other, 'm2')
    await service.transcribe({ wav: new Uint8Array(), modelPath: other })
    expect(spawner).toHaveBeenCalledTimes(2)
    const [, args] = spawner.mock.calls[1] as unknown as [string, string[]]
    expect(args[args.indexOf('--model') + 1]).toBe(other)
    service.stop()
  })
})
