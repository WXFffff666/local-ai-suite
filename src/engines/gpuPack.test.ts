import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHash } from 'crypto'
import { AddressInfo } from 'net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  activatePack,
  detectNvidia,
  downloadPack,
  enginesRoot,
  listInstalled,
  ndhDownloader,
  parseNvidiaSmiLine,
  readActive,
  sha256File,
} from './gpuPack'
import type { EngineManifest } from './manifest'

const HEX_A = 'a'.repeat(64)

function manifestWith(file: string, sha256: string): EngineManifest {
  return {
    version: 1,
    generated_at: '2026-09-03T00:00:00.000Z',
    baseUrlTemplate: 'http://127.0.0.1:{port}/__placeholder__/{file}',
    engines: {
      llama: {
        cpu: { file: 'llama-cpu.exe', sha256: HEX_A, minVersion: 'b5034', platform: 'win32' },
        gpu: { cuda: { file, sha256 } },
      },
    },
  }
}

function shaHex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// --- a tiny HTTP server with Range support for real resume/progress tests -----

type PackServer = { url: string; fileUrl: string; requests: number[]; close(): Promise<void>; ranges: number }

async function servePack(bytes: Buffer): Promise<PackServer> {
  let requests = 0
  let ranges = 0
  const server: Server = createServer((req, res) => {
    requests += 1
    const range = req.headers.range
    if (typeof range === 'string' && range.startsWith('bytes=')) {
      ranges += 1
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      const start = m ? Number.parseInt(m[1] as string, 10) : 0
      const end = m && m[2] ? Number.parseInt(m[2] as string, 10) : bytes.length - 1
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
      })
      res.end(bytes.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' })
    res.end(bytes)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    get url() {
      return `http://127.0.0.1:${port}`
    },
    get fileUrl() {
      return `http://127.0.0.1:${port}/pack.bin`
    },
    get requests() {
      return [requests]
    },
    get ranges() {
      return ranges
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

// Deterministic in-process downloader seam (no network): writes `bytes` as the file.
function fakeWriter(bytes: Buffer) {
  return async (_url: string, fileName: string, dir: string): Promise<string> => {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, fileName)
    writeFileSync(p, bytes)
    return p
  }
}

// Override the downloader to dial the real server via a per-variant urlTemplate.
function manifestForServer(srv: PackServer, sha256: string): EngineManifest {
  return {
    version: 1,
    generated_at: 'now',
    baseUrlTemplate: `${srv.fileUrl}`,
    engines: {
      llama: {
        cpu: { file: 'llama-cpu.exe', sha256: HEX_A, minVersion: 'b5034', platform: 'win32' },
        gpu: { cuda: { file: 'pack.bin', sha256 } },
      },
    },
  }
}

describe('parseNvidiaSmiLine / detectNvidia', () => {
  it('parses name, driver, VRAM from csv,noheader,nounits', () => {
    expect(parseNvidiaSmiLine('NVIDIA GeForce RTX 4090, 552.22, 24576')).toEqual({
      name: 'NVIDIA GeForce RTX 4090',
      driverVersion: '552.22',
      memoryMB: 24576,
    })
  })
  it('rejects malformed rows', () => {
    expect(parseNvidiaSmiLine('just-a-name')).toBeNull()
    expect(parseNvidiaSmiLine('GPU, 550, notanumber')).toBeNull()
  })
  it('detectNvidia maps ENOENT -> no-nvidia-smi and empty -> parse-failed', async () => {
    const eno = await detectNvidia({
      execFile: async () => {
        throw Object.assign(new Error('spawn nvidia-smi ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(eno).toEqual({ available: false, reason: 'no-nvidia-smi' })
    const empty = await detectNvidia({ execFile: async () => ({ stdout: '\n\n' }) })
    expect(empty.available).toBe(false)
    expect(empty.reason).toBe('parse-failed')
    const ok = await detectNvidia({ execFile: async () => ({ stdout: 'RTX 3060, 530.0, 12288\n' }) })
    expect(ok).toEqual({ available: true, name: 'RTX 3060', driverVersion: '530.0', memoryMB: 12288 })
  })
})

describe('sha256File', () => {
  it('computes lowercase hex over real temp bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'las-sha-'))
    try {
      const p = join(dir, 'x.bin')
      writeFileSync(p, Buffer.from('hello engine'))
      expect(await sha256File(p)).toBe(shaHex(Buffer.from('hello engine')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readActive / activatePack / listInstalled', () => {
  it('single active pack per engine, last activate wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'las-engines-'))
    try {
      expect(readActive(dir)).toEqual({})
      activatePack(dir, 'llama', 'cuda')
      expect(readActive(dir)).toEqual({ llama: 'cuda' })
      activatePack(dir, 'llama', 'vulkan')
      expect(readActive(dir)).toEqual({ llama: 'vulkan' })
      expect(listInstalled(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listInstalled reads meta.json from pack dirs and ignores dotted dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'las-engines-'))
    try {
      const pack = join(dir, 'llama-cuda')
      mkdirSync(pack, { recursive: true })
      writeFileSync(
        join(pack, 'meta.json'),
        JSON.stringify({ engine: 'llama', variant: 'cuda', file: 'b.exe', sha256: HEX_A, url: 'u', activatedAt: 't' }),
        'utf-8',
      )
      mkdirSync(join(dir, '.staging'), { recursive: true })
      const items = listInstalled(dir)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ engine: 'llama', variant: 'cuda' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('downloadPack (real HTTP, verify-before-activate)', () => {
  it('happy: downloads, verifies sha, atomic-renames into <name>-<variant>/ and activates', async () => {
    const bytes = Buffer.from('CUDA-ENGINE-BINARY-CONTENT'.repeat(64))
    const sha = shaHex(bytes)
    const srv = await servePack(bytes)
    const ud = mkdtempSync(join(tmpdir(), 'las-dl-ud-'))
    const progressStages: string[] = []
    try {
      const res = await downloadPack({
        engine: 'llama',
        variant: 'cuda',
        manifest: manifestForServer(srv, sha),
        userDataDir: ud,
        onProgress: (p) => {
          if (!progressStages.includes(p.stage)) progressStages.push(p.stage)
        },
      })
      expect(res.ok).toBe(true)
      if (!res.ok) throw new Error('unreachable')
      const finalBin = join(ud, 'engines', 'llama-cuda', 'pack.bin')
      expect(existsSync(finalBin)).toBe(true)
      expect(readFileSync(finalBin)).toEqual(bytes)
      expect(readActive(enginesRoot(ud))).toEqual({ llama: 'cuda' })
      // verify-before-activate stages observed
      expect(progressStages).toEqual(expect.arrayContaining(['downloading', 'verifying', 'activating']))
      // meta.json recorded
      const meta = JSON.parse(readFileSync(join(ud, 'engines', 'llama-cuda', 'meta.json'), 'utf-8')) as { sha256: string }
      expect(meta.sha256).toBe(sha)
    } finally {
      await srv.close()
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('sha mismatch -> quarantine + ok:false, active pack untouched (fall back to CPU)', async () => {
    const bytes = Buffer.from('CORRUPT-PACK'.repeat(32))
    const srv = await servePack(bytes)
    const ud = mkdtempSync(join(tmpdir(), 'las-dl-ud-'))
    try {
      // pre-activate nothing; even so the manifest digest is wrong -> refuse
      const res = await downloadPack({
        engine: 'llama',
        variant: 'cuda',
        manifest: manifestForServer(srv, '0'.repeat(64)), // digest the bytes will NOT match
        userDataDir: ud,
        downloader: fakeWriter(bytes),
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.reason).toBe('sha256-mismatch')
      expect(res.quarantine).toBeDefined()
      // the final activated dir must NOT exist
      expect(existsSync(join(ud, 'engines', 'llama-cuda'))).toBe(false)
      expect(readActive(enginesRoot(ud))).toEqual({})
      // quarantine holds the bad bytes
      const qDir = join(ud, 'engines', '.quarantine')
      expect(existsSync(qDir)).toBe(true)
      const sub = readdirSync(qDir)[0] as string
      expect(readdirSync(join(qDir, sub))).toContain('pack.bin')
    } finally {
      await srv.close()
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('re-activation swaps the previous pack atomically (single active)', async () => {
    const first = Buffer.from('AAAA-ENGINE'.repeat(80))
    const srv = await servePack(first)
    const ud = mkdtempSync(join(tmpdir(), 'las-dl-ud-'))
    const dl = async (bytes: Buffer): Promise<boolean> => {
      const res = await downloadPack({
        engine: 'llama',
        variant: 'cuda',
        manifest: manifestForServer(srv, shaHex(bytes)),
        userDataDir: ud,
        downloader: fakeWriter(bytes),
      })
      return res.ok
    }
    try {
      expect(await dl(first)).toBe(true)
      const second = Buffer.from('BBBB-ENGINE-NEW'.repeat(80))
      expect(await dl(second)).toBe(true)
      const finalBin = join(ud, 'engines', 'llama-cuda', 'pack.bin')
      expect(readFileSync(finalBin)).toEqual(second)
      expect(readActive(enginesRoot(ud))).toEqual({ llama: 'cuda' })
    } finally {
      await srv.close()
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('unknown variant -> ok:false without touching disk', async () => {
    const ud = mkdtempSync(join(tmpdir(), 'las-dl-ud-'))
    try {
      const res = await downloadPack({
        engine: 'llama',
        variant: 'vulkan',
        manifest: manifestWith('pack.bin', HEX_A),
        userDataDir: ud,
      })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.reason).toContain('no gpu variant')
      expect(existsSync(join(ud, 'engines'))).toBe(false)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })
})

describe('ndhDownloader against real HTTP server', () => {
  it('emits monotonically increasing progress and lands the exact bytes', async () => {
    const bytes = Buffer.from('X'.repeat(200_000)) // large enough to chunk
    const srv = await servePack(bytes)
    const dir = mkdtempSync(join(tmpdir(), 'las-ndh-'))
    try {
      const pcts: number[] = []
      const path = await ndhDownloader(srv.fileUrl, 'pack.bin', dir, (p) => {
        pcts.push(p.percent)
      })
      expect(readFileSync(path)).toEqual(bytes)
      for (let i = 1; i < pcts.length; i += 1) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1] as number)
    } finally {
      await srv.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resumes a partial file when the server supports Range (断点续传)', async () => {
    const bytes = Buffer.from('RESUME-ENGINE-PAYLOAD'.repeat(30_000)) // ~630 KB
    const srv = await servePack(bytes)
    const dir = mkdtempSync(join(tmpdir(), 'las-ndh-resume-'))
    try {
      const partial = join(dir, 'pack.bin')
      const firstChunk = bytes.subarray(0, Math.floor(bytes.length / 2))
      writeFileSync(partial, firstChunk)
      const path = await ndhDownloader(srv.fileUrl, 'pack.bin', dir, () => undefined)
      const full = readFileSync(path)
      expect(full.length).toBe(bytes.length)
      expect(full).toEqual(bytes)
      // the resume path used a Range request for the remainder
      expect(srv.ranges).toBeGreaterThanOrEqual(1)
    } finally {
      await srv.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
