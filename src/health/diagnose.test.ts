import { describe, it, expect, vi } from 'vitest'
import * as path from 'path'
import {
  LOG_MAX_BYTES,
  getLogsDir,
  listLogFiles,
  isSidecarLogFile,
  rotateLogFile,
  rotateLogs,
  logRotate,
  redactSensitive,
  redactObject,
  openLogsFolder,
  createShowLogsHandler,
  aggregateHealth,
  handleHealthRequest,
  createHealthHandler,
  generateDiagnoseReport,
  exportDiagnoseReport,
  handleDiagnoseRequest,
  createDiagnoseHandler,
  DIAGNOSE_VERSION,
} from './diagnose'

// ---------------------------------------------------------------------------
// helpers: in-memory fsDeps
// ---------------------------------------------------------------------------
function makeFs(initial: Record<string, { size: number; content?: string }>, files: string[] = Object.keys(initial)) {
  const store: Record<string, { size: number; content: string }> = {}
  for (const [k, v] of Object.entries(initial)) {
    store[path.resolve(k)] = { size: v.size, content: v.content ?? 'x'.repeat(Math.min(v.size, 100)) }
  }
  let fileList = [...files.map((f) => path.basename(f))]
  const deps: Record<string, unknown> = {
    existsSync: vi.fn((p: string) => {
      const r = path.resolve(p)
      if (store[r]) return true
      if (r.endsWith('.1') && store[r.slice(0, -2)]) return false // .1 not exist unless rotated
      // For directory existence: if any file under dir
      if (p.endsWith('logs') || p === getLogsDir('logs')) return true
      return !!store[r]
    }),
    statSync: vi.fn((p: string) => {
      const r = path.resolve(p)
      if (store[r]) return { size: store[r].size } as unknown as ReturnType<typeof import('fs').statSync>
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    renameSync: vi.fn((src: string, dest: string) => {
      const s = path.resolve(src)
      const d = path.resolve(dest)
      if (!store[s]) throw new Error('ENOENT src')
      store[d] = store[s]
      delete store[s]
      // update fileList for listLogFiles if needed
      const srcBase = path.basename(s)
      const destBase = path.basename(d)
      const idx = fileList.indexOf(srcBase)
      if (idx !== -1) fileList.splice(idx, 1)
    }),
    mkdirSync: vi.fn(() => {}),
    readdirSync: vi.fn(() => [...fileList]),
    readFileSync: vi.fn((p: string) => {
      const r = path.resolve(p)
      if (store[r]) return store[r].content
      throw new Error('ENOENT')
    }),
    writeFileSync: vi.fn((p: string, data: string) => {
      const r = path.resolve(p)
      store[r] = { size: Buffer.byteLength(data), content: String(data) }
    }),
    unlinkSync: vi.fn((p: string) => { delete store[path.resolve(p)] }),
    _store: store,
    _fileList: fileList,
  }
  return deps as unknown as Parameters<typeof listLogFiles>[1] & { _store: typeof store; _fileList: string[] }
}

describe('getLogsDir', () => {
  it('resolves custom dir', () => {
    expect(getLogsDir('/tmp/mylogs')).toBe(path.resolve('/tmp/mylogs'))
  })
  it('defaults to cwd/logs', () => {
    expect(getLogsDir()).toBe(path.join(process.cwd(), 'logs'))
  })
})

describe('isSidecarLogFile', () => {
  it('matches sidecar-*.log', () => {
    expect(isSidecarLogFile('sidecar-llama.log')).toBe(true)
    expect(isSidecarLogFile('/a/logs/sidecar-olama.log')).toBe(true)
    expect(isSidecarLogFile('app.log')).toBe(false)
  })
})

describe('listLogFiles', () => {
  it('lists only sidecar-*.log', () => {
    const fsDeps = {
      existsSync: () => true,
      readdirSync: () => ['sidecar-llama.log', 'sidecar-sd.log', 'app.log', 'sidecar-ollama.log.1'],
    } as unknown as Parameters<typeof listLogFiles>[1]
    const files = listLogFiles('/logs', fsDeps)
    expect(files).toHaveLength(2)
    expect(files[0]).toContain('sidecar-llama.log')
  })
  it('returns [] if dir not exists', () => {
    const files = listLogFiles('/nope', { existsSync: () => false } as unknown as Parameters<typeof listLogFiles>[1])
    expect(files).toEqual([])
  })
})

describe('redactSensitive', () => {
  it('redacts Bearer token', () => {
    expect(redactSensitive('Authorization: Bearer sk-abc123xyzTOKEN')).toContain('[REDACTED]')
    expect(redactSensitive('Bearer sk-1234567890abcdef')).toContain('[REDACTED]')
  })
  it('redacts api_key', () => {
    expect(redactSensitive('api_key=secret12345')).toContain('[REDACTED]')
    expect(redactSensitive('apiKey: "mykey123"')).toContain('[REDACTED]')
  })
  it('redacts email', () => {
    expect(redactSensitive('user foo@bar.com here')).toBe('user [REDACTED] here')
  })
  it('redacts home path', () => {
    expect(redactSensitive('path C:\\Users\\Alice\\docs')).toContain('C:\\Users\\[REDACTED]')
    expect(redactSensitive('path /home/bob/data')).toContain('/home/[REDACTED]')
  })
  it('redactObject deep', () => {
    const obj = { token: 'Bearer xyz', nested: { email: 'a@b.com' } }
    const r = redactObject(obj) as typeof obj
    expect(r.nested.email).toBe('[REDACTED]')
  })
})

describe('rotateLogFile / rotateLogs / logRotate', () => {
  it('rotates when over limit', () => {
    const logPath = path.join(getLogsDir('/tmp/logs'), 'sidecar-llama.log')
    const fsDeps = makeFs({ [logPath]: { size: LOG_MAX_BYTES + 1000 } }, [path.basename(logPath)])
    const did = rotateLogFile(logPath, fsDeps as unknown as Parameters<typeof rotateLogFile>[1], LOG_MAX_BYTES)
    expect(did).toBe(true)
    expect(fsDeps['renameSync']).toHaveBeenCalled()
  })
  it('skips when under limit', () => {
    const logPath = path.join(getLogsDir('/tmp/logs'), 'sidecar-llama.log')
    const fsDeps = makeFs({ [logPath]: { size: 100 } }, [path.basename(logPath)])
    const did = rotateLogFile(logPath, fsDeps as unknown as Parameters<typeof rotateLogFile>[1], LOG_MAX_BYTES)
    expect(did).toBe(false)
  })
  it('rotateLogs aggregates', () => {
    const dir = path.resolve('/tmp/logs2')
    const f1 = path.join(dir, 'sidecar-a.log')
    const f2 = path.join(dir, 'sidecar-b.log')
    const fsDeps = {
      existsSync: (p: string) => {
        if (p === dir) return true
        if (p === f1 || p === f2) return true
        if (p.endsWith('.1')) return false
        return false
      },
      readdirSync: () => ['sidecar-a.log', 'sidecar-b.log'],
      statSync: (p: string) => ({ size: p.includes('a.log') ? LOG_MAX_BYTES + 10 : 100 } as unknown as ReturnType<typeof import('fs').statSync>),
      renameSync: vi.fn(() => {}),
      unlinkSync: vi.fn(),
    } as unknown as Parameters<typeof rotateLogs>[1]
    const res = rotateLogs(dir, { fsDeps, maxBytes: LOG_MAX_BYTES })
    expect(res.rotated).toHaveLength(1)
    expect(res.skipped).toHaveLength(1)
    expect(res.rotated[0]).toBe(f1)
  })
  it('logRotate alias equals rotateLogs', () => {
    expect(logRotate).toBe(rotateLogs)
  })
})

describe('openLogsFolder (Help->Show Logs)', () => {
  it('returns path and creates dir if needed', async () => {
    const mkdir = vi.fn(() => {})
    const p = await openLogsFolder({ logDir: '/tmp/showlogs', fsDeps: { existsSync: () => false, mkdirSync: mkdir } as unknown as Parameters<typeof openLogsFolder>[0]['fsDeps'] })
    expect(p).toBe(path.resolve('/tmp/showlogs'))
    expect(mkdir).toHaveBeenCalled()
  })
  it('uses shellDeps.openPath', async () => {
    const openPath = vi.fn(async () => '')
    const p = await openLogsFolder({ logDir: '/tmp/showlogs2', shellDeps: { openPath }, fsDeps: { existsSync: () => true, mkdirSync: vi.fn() } as unknown as Parameters<typeof openLogsFolder>[0]['fsDeps'] })
    expect(openPath).toHaveBeenCalledWith(path.resolve('/tmp/showlogs2'))
    expect(p).toBe(path.resolve('/tmp/showlogs2'))
  })
  it('createShowLogsHandler returns ok/path', async () => {
    const h = createShowLogsHandler({ logDir: '/tmp/handlerlogs', fsDeps: { existsSync: () => true, mkdirSync: vi.fn() } as unknown as Parameters<typeof openLogsFolder>[0]['fsDeps'] })
    const r = await h()
    expect(r.ok).toBe(true)
    expect(r.path).toBe(path.resolve('/tmp/handlerlogs'))
  })
})

describe('GET /health aggregation', () => {
  it('aggregates sidecars ok/degraded/fail', async () => {
    const fetcher = async (url: string) => {
      if (url.includes('11435')) return { ok: true, status: 200 }
      if (url.includes('11434')) return { ok: false, status: 500 }
      throw new Error('down')
    }
    const agg = await aggregateHealth({
      sidecars: [
        { name: 'llama', healthUrl: 'http://127.0.0.1:11435/health', port: 11435 },
        { name: 'ollama', healthUrl: 'http://127.0.0.1:11434/health', port: 11434 },
      ],
      fetcher,
    })
    expect(agg.sidecars['llama'].ok).toBe(true)
    expect(agg.sidecars['ollama'].ok).toBe(false)
    expect(agg.status).toBe('degraded')
    expect(agg.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(agg.timestamp).toBeDefined()
  })
  it('status ok when all ok', async () => {
    const agg = await aggregateHealth({ sidecars: [{ name: 'a', healthUrl: 'http://127.0.0.1:1234/health' }], fetcher: async () => ({ ok: true, status: 200 }) })
    expect(agg.status).toBe('ok')
  })
  it('status fail when none ok', async () => {
    const agg = await aggregateHealth({ sidecars: [{ name: 'a', healthUrl: 'http://127.0.0.1:1234/health' }], fetcher: async () => ({ ok: false, status: 500 }) })
    expect(agg.status).toBe('fail')
  })
  it('includes gpu when getGpuInfo provided', async () => {
    const agg = await aggregateHealth({ sidecars: [], getGpuInfo: async () => ({ backend: 'cpu', vram: null }) })
    expect((agg.gpu as { backend: string }).backend).toBe('cpu')
  })
  it('handleHealthRequest 200 on /health', async () => {
    const req = new Request('http://127.0.0.1/health', { method: 'GET' })
    const res = await handleHealthRequest(req, { sidecars: [], fetcher: async () => ({ ok: true, status: 200 }) })
    expect(res.status).toBe(200)
    const j = await res.json() as { status: string }
    expect(j.status).toBe('ok')
  })
  it('handleHealthRequest 404 on wrong path', async () => {
    const req = new Request('http://127.0.0.1/other', { method: 'GET' })
    const res = await handleHealthRequest(req, {})
    expect(res.status).toBe(404)
  })
  it('handleHealthRequest 405 on POST', async () => {
    const req = new Request('http://127.0.0.1/health', { method: 'POST' })
    const res = await handleHealthRequest(req, {})
    expect(res.status).toBe(405)
  })
  it('createHealthHandler node style', async () => {
    const h = createHealthHandler({ sidecars: [] })
    const req = { method: 'GET', url: '/health' }
    let body = ''
    const res: Record<string, unknown> = { statusCode: 200, setHeader: vi.fn(), end: (b: string) => { body = b } }
    await (h as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    expect(res['statusCode']).toBe(200)
    const j = JSON.parse(body) as { status: string }
    expect(j.status).toBe('ok')
  })
  it('createHealthHandler handleRequest fetch helper', async () => {
    const h = createHealthHandler({ sidecars: [] }) as unknown as { handleRequest: (r: Request) => Promise<Response> }
    const res = await h.handleRequest(new Request('http://127.0.0.1/health'))
    expect(res.status).toBe(200)
  })
})

describe('Diagnose export (desensitized)', () => {
  it('generateDiagnoseReport redacts secrets in logs tail', async () => {
    const dir = path.resolve('/tmp/diaglogs')
    const f = path.join(dir, 'sidecar-llama.log')
    const secretContent = 'hello api_key=supersecret123 token: Bearer xyz123 user@evil.com C:\\Users\\Alice\\file'
    const fsDeps = {
      existsSync: (p: string) => p === dir || p === f,
      readdirSync: () => ['sidecar-llama.log'],
      statSync: () => ({ size: secretContent.length } as unknown as ReturnType<typeof import('fs').statSync>),
      readFileSync: () => secretContent,
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
      writeFileSync: vi.fn(),
    } as unknown as Parameters<typeof generateDiagnoseReport>[0]['fsDeps']
    const report = await generateDiagnoseReport({ logDir: dir, fsDeps, sidecars: [], logTailBytes: 8192 })
    expect(report.version).toBe(DIAGNOSE_VERSION)
    expect(report.logs.files[0].tail).toContain('[REDACTED]')
    expect(report.logs.files[0].tail).not.toContain('supersecret123')
    expect(report.logs.files[0].tail).not.toContain('user@evil.com')
    expect(report.system.platform).toBeDefined()
    expect(report.health.status).toBeDefined()
  })
  it('exportDiagnoseReport writes file', async () => {
    const dir = path.resolve('/tmp/diaglogs2')
    const out = path.join(dir, 'diagnose.json')
    const writes: Record<string, string> = {}
    const fsDeps = {
      existsSync: () => false,
      readdirSync: () => [],
      statSync: () => ({ size: 0 } as unknown as ReturnType<typeof import('fs').statSync>),
      readFileSync: () => '',
      writeFileSync: vi.fn((p: string, data: string) => { writes[path.resolve(p)] = String(data) }),
      mkdirSync: vi.fn(() => {}),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    } as unknown as Parameters<typeof exportDiagnoseReport>[1]['fsDeps']
    const written = await exportDiagnoseReport(out, { fsDeps, sidecars: [], logDir: '/tmp/empty' })
    expect(written).toBe(path.resolve(out))
    expect(writes[path.resolve(out)]).toContain(DIAGNOSE_VERSION)
    const parsed = JSON.parse(writes[path.resolve(out)]) as { version: string }
    expect(parsed.version).toBe(DIAGNOSE_VERSION)
  })
  it('handleDiagnoseRequest GET /health/diagnose', async () => {
    const req = new Request('http://127.0.0.1/health/diagnose', { method: 'GET' })
    const res = await handleDiagnoseRequest(req, { sidecars: [], fsDeps: { existsSync: () => false, readdirSync: () => [] } as unknown as Parameters<typeof handleDiagnoseRequest>[1]['fsDeps'] })
    expect(res.status).toBe(200)
    const j = await res.json() as { version: string }
    expect(j.version).toBe(DIAGNOSE_VERSION)
  })
  it('handleDiagnoseRequest 404/405', async () => {
    expect((await handleDiagnoseRequest(new Request('http://127.0.0.1/health/other'), {})).status).toBe(404)
    expect((await handleDiagnoseRequest(new Request('http://127.0.0.1/health/diagnose', { method: 'POST' }), {})).status).toBe(405)
  })
  it('createDiagnoseHandler node style', async () => {
    const h = createDiagnoseHandler({ sidecars: [], fsDeps: { existsSync: () => false, readdirSync: () => [] } as unknown as Parameters<typeof createDiagnoseHandler>[0]['fsDeps'] })
    const req = { method: 'GET', url: '/health/diagnose' }
    let body = ''
    const res: Record<string, unknown> = { statusCode: 200, setHeader: vi.fn(), end: (b: string) => { body = b } }
    await (h as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    expect(res['statusCode']).toBe(200)
    expect(JSON.parse(body).version).toBe(DIAGNOSE_VERSION)
  })
})
