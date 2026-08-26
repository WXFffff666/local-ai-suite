/**
 * health/diagnose — logs rotation + GET /health aggregation + Diagnose export
 * MIT, no AGPL. Pure Node deps only.
 *
 * Features:
 *  - logs/sidecar-*.log rotation (5MiB -> .1) + listLogFiles + rotateLogs/logRotate
 *  - Help->Show Logs (openLogsFolder / createShowLogsHandler)
 *  - GET /health aggregation (sidecars + gpu + app) -> AggregatedHealth
 *  - Diagnose export (desensitized report) -> DiagnoseReport + exportDiagnoseReport
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_GLOB_PREFIX = 'sidecar-'
export const LOG_GLOB_SUFFIX = '.log'
export const DIAGNOSE_VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// FsDeps (injectable for tests)
// ---------------------------------------------------------------------------
export type FsDeps = {
  existsSync: typeof fs.existsSync
  statSync: typeof fs.statSync
  renameSync: typeof fs.renameSync
  mkdirSync: typeof fs.mkdirSync
  readdirSync: typeof fs.readdirSync
  readFileSync: typeof fs.readFileSync
  writeFileSync: typeof fs.writeFileSync
  unlinkSync: typeof fs.unlinkSync
}

export const defaultFsDeps: FsDeps = {
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  renameSync: fs.renameSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  unlinkSync: fs.unlinkSync,
}

// ---------------------------------------------------------------------------
// Logs dir resolution (Help->Show Logs)
// ---------------------------------------------------------------------------
export function getLogsDir(customDir?: string): string {
  if (customDir) return path.resolve(customDir)
  return path.join(process.cwd(), 'logs')
}
export const resolveLogsDir = getLogsDir

// ---------------------------------------------------------------------------
// Redaction (desensitization)
// ---------------------------------------------------------------------------
const REDACTED = '[REDACTED]'

const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  // api keys / tokens / secrets
  [/(api[_-]?key\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, `$1$2${REDACTED}`],
  [/(Bearer\s+)[A-Za-z0-9\-_\.]+/gi, `$1${REDACTED}`],
  [/(authorization\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, `$1$2${REDACTED}`],
  [/(sk-[A-Za-z0-9]{10,})/g, REDACTED],
  [/(ghp_[A-Za-z0-9]{20,})/g, REDACTED],
  [/(token\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, `$1$2${REDACTED}`],
  [/(password\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, `$1$2${REDACTED}`],
  [/(secret\s*[:=]\s*)(['"]?)[^\s'",}]+/gi, `$1$2${REDACTED}`],
]

export function redactSensitive(text: string): string {
  let out = text
  for (const [re, rep] of SENSITIVE_PATTERNS) {
    out = out.replace(re, rep)
  }
  // redact user home paths: C:\Users\Alice -> C:\Users\[REDACTED] / /home/alice -> /home/[REDACTED]
  out = out.replace(/([A-Z]:\\Users\\)[^\\\/\s"']+/gi, `$1${REDACTED}`)
  out = out.replace(/(\/home\/)[^\/\s"']+/g, `$1${REDACTED}`)
  out = out.replace(/(Users\/)[^\/\s"']+/g, `$1${REDACTED}`)
  // redact emails
  out = out.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, REDACTED)
  // redact absolute paths that contain username segment — keep structure but hide user
  return out
}

export function redactObject<T>(obj: T): T {
  const json = JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'string') return redactSensitive(v)
    return v
  })
  return JSON.parse(json) as T
}

// ---------------------------------------------------------------------------
// Log listing + rotation
// ---------------------------------------------------------------------------
export function listLogFiles(logDir: string, fsDeps: Partial<FsDeps> = defaultFsDeps): string[] {
  const readdir = (fsDeps.readdirSync ?? defaultFsDeps.readdirSync) as typeof fs.readdirSync
  const exists = (fsDeps.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
  if (!exists(logDir)) return []
  try {
    const entries = readdir(logDir) as unknown as string[]
    return entries
      .filter((f) => f.startsWith(LOG_GLOB_PREFIX) && f.endsWith(LOG_GLOB_SUFFIX))
      .map((f) => path.join(logDir, f))
      .sort()
  } catch {
    return []
  }
}

export function isSidecarLogFile(filename: string): boolean {
  const base = path.basename(filename)
  return base.startsWith(LOG_GLOB_PREFIX) && base.endsWith(LOG_GLOB_SUFFIX)
}

export type RotateResult = { rotated: string[]; skipped: string[]; errors: string[] }

export function rotateLogFile(
  filePath: string,
  fsDeps: Partial<FsDeps> = defaultFsDeps,
  maxBytes: number = LOG_MAX_BYTES,
): boolean {
  const exists = (fsDeps.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
  const stat = (fsDeps.statSync ?? defaultFsDeps.statSync) as typeof fs.statSync
  const rename = (fsDeps.renameSync ?? defaultFsDeps.renameSync) as typeof fs.renameSync
  const unlink = (fsDeps.unlinkSync ?? defaultFsDeps.unlinkSync) as typeof fs.unlinkSync
  if (!exists(filePath)) return false
  let size = 0
  try {
    const st = stat(filePath) as { size: number }
    size = st.size
  } catch {
    return false
  }
  if (size <= maxBytes) return false
  const rotated = `${filePath}.1`
  try {
    if (exists(rotated)) {
      try {
        rename(filePath, rotated)
      } catch {
        try { unlink(rotated) } catch {}
        rename(filePath, rotated)
      }
    } else {
      rename(filePath, rotated)
    }
    return true
  } catch {
    return false
  }
}

export type RotateLogsOptions = {
  maxBytes?: number
  fsDeps?: Partial<FsDeps>
  pattern?: { prefix?: string; suffix?: string }
}

export function rotateLogs(logDir: string, opts: RotateLogsOptions = {}): RotateResult {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES
  const fsDeps = opts.fsDeps ?? defaultFsDeps
  const files = listLogFiles(logDir, fsDeps)
  const rotated: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  for (const f of files) {
    try {
      const did = rotateLogFile(f, fsDeps, maxBytes)
      if (did) rotated.push(f)
      else skipped.push(f)
    } catch (e) {
      errors.push(`${f}: ${(e as Error).message}`)
    }
  }
  return { rotated, skipped, errors }
}

// alias required by spec wording: logRotate
export const logRotate = rotateLogs
export const rotateSidecarLogs = rotateLogs

// ---------------------------------------------------------------------------
// Help->Show Logs (Electron shell.openPath wrapper, injectable)
// ---------------------------------------------------------------------------
export type ShellDeps = { openPath: (p: string) => Promise<string> }
export type ShowLogsOptions = {
  logDir?: string
  shellDeps?: ShellDeps
  fsDeps?: Partial<FsDeps>
}

export async function openLogsFolder(opts: ShowLogsOptions = {}): Promise<string> {
  const logDir = getLogsDir(opts.logDir)
  const mkdir = (opts.fsDeps?.mkdirSync ?? defaultFsDeps.mkdirSync) as typeof fs.mkdirSync
  const exists = (opts.fsDeps?.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
  if (!exists(logDir)) {
    try { mkdir(logDir, { recursive: true } as unknown as string) } catch {}
  }
  if (opts.shellDeps?.openPath) {
    const res = await opts.shellDeps.openPath(logDir)
    if (res) throw new Error(res)
    return logDir
  }
  // fallback: just return path (tests / non-electron)
  return logDir
}
export const showLogs = openLogsFolder
export const revealLogsFolder = openLogsFolder

export function createShowLogsHandler(opts: ShowLogsOptions = {}) {
  return async (_event?: unknown): Promise<{ ok: boolean; path: string }> => {
    const p = await openLogsFolder(opts)
    return { ok: true, path: p }
  }
}

// ---------------------------------------------------------------------------
// GET /health aggregation (sidecars + optional gpu)
// ---------------------------------------------------------------------------
export type SidecarHealthConfig = { name: string; healthUrl: string; port?: number }
export type SidecarHealthStatus = {
  name: string
  ok: boolean
  status: 'ok' | 'fail' | 'unknown'
  latencyMs?: number
  healthUrl: string
  port?: number
  detail?: string
  httpStatus?: number
}

export type AggregatedHealth = {
  status: 'ok' | 'degraded' | 'fail'
  timestamp: string
  uptimeSec: number
  version?: string
  sidecars: Record<string, SidecarHealthStatus>
  gpu?: unknown
  logs?: { dir: string; files: Array<{ name: string; size: number }> }
}

export type AggregateHealthOptions = {
  sidecars?: SidecarHealthConfig[]
  // injectable fetcher: (url)-> {ok,status}
  fetcher?: (url: string) => Promise<{ ok: boolean; status: number }>
  // optional gpu getter: ()->GpuInfo
  getGpuInfo?: () => Promise<unknown>
  logDir?: string
  version?: string
  fsDeps?: Partial<FsDeps>
  timeoutMs?: number
}

async function probeOne(
  cfg: SidecarHealthConfig,
  fetcher?: AggregateHealthOptions['fetcher'],
  timeoutMs: number = 2000,
): Promise<SidecarHealthStatus> {
  const start = Date.now()
  try {
    let ok = false
    let status = 0
    if (fetcher) {
      const r = await fetcher(cfg.healthUrl)
      ok = r.ok
      status = r.status
    } else {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const r = await fetch(cfg.healthUrl, { signal: ctrl.signal } as RequestInit)
        ok = r.ok
        status = r.status
      } finally { clearTimeout(t) }
    }
    const latencyMs = Date.now() - start
    return {
      name: cfg.name,
      ok,
      status: ok ? 'ok' : 'fail',
      latencyMs,
      healthUrl: cfg.healthUrl,
      port: cfg.port,
      httpStatus: status,
    }
  } catch (e) {
    return {
      name: cfg.name,
      ok: false,
      status: 'fail',
      latencyMs: Date.now() - start,
      healthUrl: cfg.healthUrl,
      port: cfg.port,
      detail: (e as Error).message ?? String(e),
    }
  }
}

export async function aggregateHealth(opts: AggregateHealthOptions = {}): Promise<AggregatedHealth> {
  const sidecars = opts.sidecars ?? []
  const results: Record<string, SidecarHealthStatus> = {}
  for (const cfg of sidecars) {
    const r = await probeOne(cfg, opts.fetcher, opts.timeoutMs)
    results[cfg.name] = r
  }
  let gpu: unknown = undefined
  if (opts.getGpuInfo) {
    try { gpu = await opts.getGpuInfo() } catch { gpu = { error: 'gpu probe failed' } }
  }
  // logs summary
  let logs: AggregatedHealth['logs']
  if (opts.logDir !== undefined) {
    const logDir = getLogsDir(opts.logDir)
    const fsDeps = opts.fsDeps ?? defaultFsDeps
    const exists = (fsDeps.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
    const stat = (fsDeps.statSync ?? defaultFsDeps.statSync) as typeof fs.statSync
    if (exists(logDir)) {
      const files = listLogFiles(logDir, fsDeps)
      const mapped = files.map((f) => {
        let size = 0
        try { size = (stat(f) as { size: number }).size } catch { size = 0 }
        return { name: path.basename(f), size }
      })
      logs = { dir: logDir, files: mapped }
    } else {
      logs = { dir: logDir, files: [] }
    }
  }

  const allOk = Object.values(results).length === 0 ? true : Object.values(results).every((r) => r.ok)
  const someOk = Object.values(results).some((r) => r.ok)
  const status: AggregatedHealth['status'] = allOk ? 'ok' : someOk ? 'degraded' : sidecars.length ? 'fail' : 'ok'

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    version: opts.version,
    sidecars: results,
    gpu,
    logs,
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers — GET /health (aggregation) + GET /health/diagnose
// ---------------------------------------------------------------------------
export type HealthHandlerOptions = AggregateHealthOptions & {
  path?: string
}

export async function handleHealthRequest(req: Request, opts: HealthHandlerOptions = {}): Promise<Response> {
  const url = new URL(req.url, 'http://127.0.0.1')
  const pathname = url.pathname
  const expected = opts.path ?? '/health'
  if (pathname !== expected) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  if (req.method.toUpperCase() !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'content-type': 'application/json' } })
  }
  const body = await aggregateHealth(opts)
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

export function createHealthHandler(opts: HealthHandlerOptions = {}) {
  const pathExpected = opts.path ?? '/health'
  const handler = async (
    req: { method?: string; url?: string },
    res: { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (b: string) => void },
  ): Promise<void> => {
    let pathname: string
    try { pathname = new URL(req.url ?? pathExpected, 'http://127.0.0.1').pathname } catch { pathname = req.url ?? pathExpected }
    if (pathname !== pathExpected) {
      if (res.statusCode !== undefined) res.statusCode = 404
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: 'not found' }))
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      if (res.statusCode !== undefined) res.statusCode = 405
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const body = await aggregateHealth(opts)
    if (res.statusCode !== undefined) res.statusCode = 200
    res.setHeader?.('content-type', 'application/json')
    res.end?.(JSON.stringify(body))
  }
  ;(handler as unknown as Record<string, unknown>)['handleRequest'] = (req: Request) => handleHealthRequest(req, opts)
  return handler as typeof handler & { handleRequest: (req: Request) => Promise<Response> }
}

// ---------------------------------------------------------------------------
// Diagnose export (desensitized)
// ---------------------------------------------------------------------------
export type DiagnoseReport = {
  version: string
  timestamp: string
  system: { platform: string; arch: string; node: string; uptimeSec: number; hostname?: string }
  health: AggregatedHealth
  logs: { dir: string; files: Array<{ name: string; size: number; tail?: string }> }
  notes?: string
}

export type DiagnoseOptions = AggregateHealthOptions & {
  logTailBytes?: number
  includeLogs?: boolean
  notes?: string
  fsDeps?: Partial<FsDeps>
}

function readTail(filePath: string, maxBytes: number, fsDeps: Partial<FsDeps>): string | undefined {
  const read = (fsDeps.readFileSync ?? defaultFsDeps.readFileSync) as typeof fs.readFileSync
  const stat = (fsDeps.statSync ?? defaultFsDeps.statSync) as typeof fs.statSync
  const exists = (fsDeps.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
  if (!exists(filePath)) return undefined
  try {
    const st = stat(filePath) as { size: number }
    const size = st.size
    if (size <= maxBytes) {
      const buf = read(filePath, 'utf-8') as unknown as string
      return redactSensitive(String(buf).slice(-maxBytes))
    }
    // read last maxBytes
    const full = read(filePath, 'utf-8') as unknown as string
    const tail = String(full).slice(-maxBytes)
    return redactSensitive(tail)
  } catch {
    return undefined
  }
}

export async function generateDiagnoseReport(opts: DiagnoseOptions = {}): Promise<DiagnoseReport> {
  const health = await aggregateHealth(opts)
  const logDir = getLogsDir(opts.logDir)
  const fsDeps = opts.fsDeps ?? defaultFsDeps
  const exists = (fsDeps.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
  const stat = (fsDeps.statSync ?? defaultFsDeps.statSync) as typeof fs.statSync
  const tailBytes = opts.logTailBytes ?? 4096
  const includeLogs = opts.includeLogs ?? true

  let logFiles: Array<{ name: string; size: number; tail?: string }> = []
  if (includeLogs && exists(logDir)) {
    const files = listLogFiles(logDir, fsDeps)
    logFiles = files.map((f) => {
      let size = 0
      try { size = (stat(f) as { size: number }).size } catch { size = 0 }
      const tail = readTail(f, tailBytes, fsDeps)
      return { name: path.basename(f), size, tail }
    })
  } else if (includeLogs) {
    logFiles = []
  }

  const system = {
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
    hostname: (() => { try { return os.hostname() } catch { return undefined } })(),
  }

  const report: DiagnoseReport = {
    version: DIAGNOSE_VERSION,
    timestamp: new Date().toISOString(),
    system: redactObject(system) as DiagnoseReport['system'],
    health: redactObject(health) as AggregatedHealth,
    logs: { dir: redactSensitive(logDir), files: redactObject(logFiles) as DiagnoseReport['logs']['files'] },
  }
  if (opts.notes) report.notes = redactSensitive(opts.notes)
  return report
}

export async function exportDiagnoseReport(
  outPath: string,
  opts: DiagnoseOptions = {},
): Promise<string> {
  const report = await generateDiagnoseReport(opts)
  const fsDeps = opts.fsDeps ?? defaultFsDeps
  const write = (fsDeps.writeFileSync ?? defaultFsDeps.writeFileSync) as typeof fs.writeFileSync
  const mkdir = (fsDeps.mkdirSync ?? defaultFsDeps.mkdirSync) as typeof fs.mkdirSync
  const dir = path.dirname(path.resolve(outPath))
  const exists = (fsDeps.existsSync ?? defaultFsDeps.existsSync) as typeof fs.existsSync
  if (!exists(dir)) {
    try { mkdir(dir, { recursive: true } as unknown as string) } catch {}
  }
  const json = JSON.stringify(report, null, 2)
  write(path.resolve(outPath), json, 'utf-8' as unknown as BufferEncoding)
  return path.resolve(outPath)
}

// Diagnose HTTP handler — GET /health/diagnose
export async function handleDiagnoseRequest(req: Request, opts: DiagnoseOptions & { path?: string } = {}): Promise<Response> {
  const url = new URL(req.url, 'http://127.0.0.1')
  const expected = (opts as { path?: string }).path ?? '/health/diagnose'
  if (url.pathname !== expected) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  if (req.method.toUpperCase() !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'content-type': 'application/json' } })
  }
  const report = await generateDiagnoseReport(opts)
  return new Response(JSON.stringify(report), { status: 200, headers: { 'content-type': 'application/json' } })
}

export function createDiagnoseHandler(opts: DiagnoseOptions & { path?: string } = {}) {
  const expected = opts.path ?? '/health/diagnose'
  const handler = async (
    req: { method?: string; url?: string },
    res: { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (b: string) => void },
  ) => {
    let pathname: string
    try { pathname = new URL(req.url ?? expected, 'http://127.0.0.1').pathname } catch { pathname = req.url ?? expected }
    if (pathname !== expected) {
      if (res.statusCode !== undefined) res.statusCode = 404
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: 'not found' }))
      return
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      if (res.statusCode !== undefined) res.statusCode = 405
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    const report = await generateDiagnoseReport(opts)
    if (res.statusCode !== undefined) res.statusCode = 200
    res.setHeader?.('content-type', 'application/json')
    res.end?.(JSON.stringify(report))
  }
  ;(handler as unknown as Record<string, unknown>)['handleRequest'] = (req: Request) => handleDiagnoseRequest(req, opts)
  return handler as typeof handler & { handleRequest: (req: Request) => Promise<Response> }
}

export default {
  LOG_MAX_BYTES,
  getLogsDir,
  listLogFiles,
  rotateLogFile,
  rotateLogs,
  logRotate,
  openLogsFolder,
  showLogs,
  aggregateHealth,
  handleHealthRequest,
  createHealthHandler,
  generateDiagnoseReport,
  exportDiagnoseReport,
  redactSensitive,
}
