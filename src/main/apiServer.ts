/**
 * Embedded OpenAI-compatible server lifecycle + 11434 ownership arbitration
 * (plan W1-10). The 11434 port is a FIXED public promise (README integration
 * contract): we never rebind. Order of decisions, per plan r1 verbatim:
 *
 *  1. probe GET http://127.0.0.1:11434/v1/models (2s budget)
 *     200 + JSON {data:[...]}  -> 'external-takeover'  (an external engine,
 *     e.g. a running system Ollama, already fulfils the compat promise; we
 *     skip the embedded server and NEVER kill it). Takeover also probes the
 *     version (GET /api/version, Server header fallback) against
 *     ENGINE_MIN_OLLAMA_VERSION; older engines still take over (r2: never
 *     kill user processes) but flip `degraded` -> tray warning + settings
 *     banner via the status callback.
 *  2. answered but incompatible -> occupied-incompatible: retry the probe
 *     OCCUPIED_RETRIES times, then a persistent error notification
 *     ('app:notification', code 'api-port-conflict') + error tooltip.
 *     NEVER rebind.
 *  3. refused -> free: start the embedded server on 127.0.0.1:11434, wrapped
 *     with the CVE-2024-28224 / Probllama middleware: every inbound request
 *     is unconditionally Host-pinned to {127.0.0.1:11434, localhost:11434}
 *     (else 403); Origin is only checked when PRESENT (browser requests) and
 *     must be a localhost origin (else 403) — a MISSING Origin header is
 *     allowed so curl / OpenCode / Continue CLI integrations keep working
 *     (ollama validateOrigin semantics, plan r1 fix).
 *
 * src/api/openai.ts contracts are untouched: the guard wraps at OUR http
 * layer and delegates passing requests to the unmodified request engine.
 * No electron import here — notifications/status flow through injected
 * callbacks (index.ts wires broadcastEvent + TrayController).
 */

import * as http from 'http'
import { AddressInfo } from 'net'
import { createOpenAiServer, OPENAI_HOST, OPENAI_PORT, MODELS_PATH } from '../api/openai'
import { registerShutdownHook } from './shutdown'
import { E2E_API_PORT } from './testSupport'
import type { AppNotificationEvent } from './ipc/whitelist'

export const API_PORT = OPENAI_PORT
export const PROBE_TIMEOUT_MS = 2000
export const OCCUPIED_RETRIES = 3
/** Floor for external engines (TALOS-2024-1912/13/14/16 series fixes). */
export const ENGINE_MIN_OLLAMA_VERSION = '0.1.13'

export type ApiServerMode = 'embedded' | 'external-takeover' | 'conflict'

export type ApiServerStatus = {
  mode: ApiServerMode
  port: number
  /** external-takeover: detected engine version when the probe exposed one. */
  version?: string
  /** external-takeover: engine answers compat but sits below the security floor. */
  degraded?: boolean
  /** conflict: raw probe failure summary surfaced for the tray tooltip / logs. */
  detail?: string
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export type ProbeOutcome =
  | { kind: 'compatible'; version?: string; degraded?: boolean }
  | { kind: 'free' }
  | { kind: 'occupied'; detail: string }

/** Connection-level errors that prove nobody is listening -> the port is free. */
const FREE_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EADDRNOTAVAIL'])

/** Semver-ish numeric segment compare; returns true when `version` < `minimum`. */
export function isVersionBelow(version: string, minimum: string): boolean {
  const a = version.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const b = minimum.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av < bv
  }
  return false
}

function withTimeout(timeoutMs: number): { init: { signal: AbortSignal }; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  return { init: { signal: controller.signal }, done: () => clearTimeout(timer) }
}

/** GET /v1/models once; classify the answer into compatible / free / occupied. */
export async function probe11434(fetchImpl: FetchLike, port: number, timeoutMs: number): Promise<ProbeOutcome> {
  const { init, done } = withTimeout(timeoutMs)
  try {
    const res = await fetchImpl(`http://${OPENAI_HOST}:${port}${MODELS_PATH}`, init)
    if (!res.ok) return { kind: 'occupied', detail: `GET /v1/models -> HTTP ${res.status}` }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      return { kind: 'occupied', detail: 'GET /v1/models -> non-JSON body' }
    }
    if (json === null || typeof json !== 'object' || !Array.isArray((json as { data?: unknown }).data)) {
      return { kind: 'occupied', detail: 'GET /v1/models -> JSON without data[]' }
    }
    const version = await probeEngineVersion(fetchImpl, port, timeoutMs, res.headers.get('server'))
    const outcome: { kind: 'compatible'; version?: string; degraded?: boolean } = { kind: 'compatible' }
    if (version !== undefined) {
      outcome.version = version
      outcome.degraded = isVersionBelow(version, ENGINE_MIN_OLLAMA_VERSION)
    }
    return outcome
  } catch (error) {
    const code = errorCode(error)
    if (code !== undefined && FREE_ERROR_CODES.has(code)) return { kind: 'free' }
    // timeouts / hangs mean something accepted the socket but will not speak
    // the compat protocol — that is an occupancy conflict, not a free port.
    return { kind: 'occupied', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    done()
  }
}

function errorCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } }
  return e.code ?? e.cause?.code
}

/** Ollama exposes /api/version; other engines may only reveal a Server header. */
async function probeEngineVersion(
  fetchImpl: FetchLike,
  port: number,
  timeoutMs: number,
  serverHeader: string | null
): Promise<string | undefined> {
  const { init, done } = withTimeout(timeoutMs)
  try {
    const res = await fetchImpl(`http://${OPENAI_HOST}:${port}/api/version`, init)
    if (res.ok) {
      const json = (await res.json()) as { version?: unknown }
      if (typeof json.version === 'string') return json.version
    }
  } catch {
    /* fall through to the Server header */
  } finally {
    done()
  }
  const m = serverHeader?.match(/ollama\/([0-9][0-9a-zA-Z._-]*)/i)
  return m?.[1]
}

// ---------------------------------------------------------------------------
// Host/Origin guard (Appendix C "local API exposure" — implemented HERE only)
// ---------------------------------------------------------------------------

export type GuardRequest = { headers: { host?: string | undefined; origin?: string | undefined } }
export type GuardVerdict = { allow: true } | { allow: false; reason: 'bad-host' | 'cross-origin' }

export function allowedApiHosts(port: number = API_PORT): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`])
}

export function evaluateApiGuard(req: GuardRequest, port: number = API_PORT): GuardVerdict {
  if (!allowedApiHosts(port).has(req.headers.host ?? '')) return { allow: false, reason: 'bad-host' }
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return { allow: true } // curl / CLI integrations
  try {
    const url = new URL(origin)
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return { allow: false, reason: 'cross-origin' }
    return { allow: true }
  } catch {
    return { allow: false, reason: 'cross-origin' } // unparseable (incl. 'null') — reject
  }
}

/**
 * http server that gates every request through evaluateApiGuard BEFORE the
 * unmodified api/openai.ts engine sees it. The inner server is never bound;
 * accepted requests are dispatched to it in-process.
 */
export function createGuardedOpenAiServer(opts: { port?: number } = {}): http.Server {
  const port = opts.port ?? API_PORT
  const inner = createOpenAiServer()
  return http.createServer((req, res) => {
    const verdict = evaluateApiGuard({ headers: { host: req.headers.host, origin: req.headers.origin } }, port)
    if (!verdict.allow) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: verdict.reason === 'bad-host' ? 'host header not allowed (local API is loopback-only)' : 'cross-origin request blocked',
            type: 'invalid_request_error'
          }
        })
      )
      return
    }
    inner.emit('request', req, res)
  })
}

// ---------------------------------------------------------------------------
// Arbitration-driven lifecycle
// ---------------------------------------------------------------------------

export type ApiServerHandle = {
  status: ApiServerStatus
  /** embedded: close the listener; takeover/conflict: no-op. */
  stop: () => Promise<void>
}

export type StartApiServerDeps = {
  fetchImpl?: FetchLike
  /** embedded-server launcher seam; defaults to the guarded 127.0.0.1:11434 bind. */
  listen?: (port: number) => Promise<{ close: () => Promise<void> }>
  sleep?: (ms: number) => Promise<void>
  retryDelayMs?: number
  port?: number
  probeTimeoutMs?: number
  notify?: (event: AppNotificationEvent) => void
  onStatus?: (status: ApiServerStatus) => void
}

export async function startApiServer(deps: StartApiServerDeps = {}): Promise<ApiServerHandle> {
  // E2E_API_PORT: undefined in production (hook module reads an env var no
  // packaged run sets); see src/main/testSupport.ts for the host-EACCES rationale.
  const port = deps.port ?? E2E_API_PORT ?? API_PORT
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const retryDelayMs = deps.retryDelayMs ?? 500
  const listen =
    deps.listen ??
    (async (p: number) => {
      const server = createGuardedOpenAiServer({ port: p })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(p, OPENAI_HOST, () => resolve())
      })
      return { close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))) }
    })

  const publish = (status: ApiServerStatus): ApiServerHandle => {
    deps.onStatus?.(status)
    return { status, stop: async () => undefined }
  }

  for (let attempt = 0; attempt <= OCCUPIED_RETRIES; attempt += 1) {
    const outcome = await probe11434(fetchImpl, port, probeTimeoutMs)
    if (outcome.kind === 'compatible') {
      return publish({
        mode: 'external-takeover',
        port,
        ...(outcome.version === undefined ? {} : { version: outcome.version }),
        ...(outcome.degraded === undefined ? {} : { degraded: outcome.degraded })
      })
    }
    if (outcome.kind === 'free') {
      try {
        const listener = await listen(port)
        const handle: ApiServerHandle = {
          status: { mode: 'embedded', port },
          stop: async () => {
            await listener.close()
          }
        }
        // Registered NOW (after the container hooks registered during
        // initServices): LIFO shutdown therefore stops this server first.
        registerShutdownHook(() => handle.stop())
        deps.onStatus?.(handle.status)
        return handle
      } catch (error) {
        // race: someone grabbed the port between probe and bind -> conflict path
        const e = error as NodeJS.ErrnoException
        if (e.code !== 'EADDRINUSE') throw error
      }
    }
    if (attempt < OCCUPIED_RETRIES) await sleep(retryDelayMs)
  }

  const detail = 'last probe could not confirm an OpenAI-compatible endpoint on 127.0.0.1'
  deps.notify?.({
    level: 'error',
    title: '本地 API 端口 11434 被占用',
    message:
      `${detail}（端口被非兼容进程占用）。端口保持固定承诺、绝不换口：` +
      '请关闭占用进程（可运行 netstat -ano | findstr :11434 定位 PID）后重启应用。',
    persistent: true,
    code: 'api-port-conflict'
  })
  return publish({ mode: 'conflict', port, detail })
}

/** Bound address info helper for tests against ephemeral guarded servers. */
export function addressOf(server: http.Server): AddressInfo {
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('server not listening')
  return addr
}
