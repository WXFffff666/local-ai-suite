/**
 * W1-10 tests â€?the three arbitration branches (external-takeover /
 * occupied-incompatible retry-exhaustion / freeâ†’embedded) with a mocked
 * fetch, plus the Host/Origin guard matrix exercised against a REAL
 * ephemeral guarded server via raw http.request.
 */
import { describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import { AddressInfo } from 'net'

import {
  addressOf,
  createGuardedOpenAiServer,
  ENGINE_MIN_OLLAMA_VERSION,
  evaluateApiGuard,
  isVersionBelow,
  probe11434,
  startApiServer
} from './apiServer'
import { resetShutdownState } from './shutdown'
import type { AppNotificationEvent } from './ipc/whitelist'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

// fresh Response per call â€?bodies are single-use
const compatibleModels = () => jsonResponse(200, { object: 'list', data: [{ id: 'qwen3', object: 'model' }] })

function fetchRouter(routes: Record<string, () => Promise<Response> | Response>): (url: string) => Promise<Response> {
  return async (url: string) => {
    const path = new URL(url).pathname
    const route = routes[path]
    if (!route) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    return route()
  }
}

describe('isVersionBelow', () => {
  it.each([
    ['0.1.9', ENGINE_MIN_OLLAMA_VERSION, true],
    ['0.1.13', ENGINE_MIN_OLLAMA_VERSION, false],
    ['0.1.14', ENGINE_MIN_OLLAMA_VERSION, false],
    ['0.1.30', ENGINE_MIN_OLLAMA_VERSION, false],
    ['0.2.0', ENGINE_MIN_OLLAMA_VERSION, false],
    ['1.10.2', '1.9.5', false],
    ['v0.1.8', ENGINE_MIN_OLLAMA_VERSION, true]
  ])('%s vs %s -> below=%s', (a, b, want) => {
    expect(isVersionBelow(a, b)).toBe(want)
  })
})

describe('probe11434', () => {
  it('200 + data[] + /api/version below floor -> compatible+degraded', async () => {
    const fetchImpl = fetchRouter({
      '/v1/models': compatibleModels,
      '/api/version': () => jsonResponse(200, { version: '0.1.9' })
    })
    await expect(probe11434(fetchImpl, 11434, 200)).resolves.toEqual({
      kind: 'compatible',
      version: '0.1.9',
      degraded: true
    })
  })

  it('no /api/version but Server header ollama/0.1.30 -> compatible, not degraded', async () => {
    const fetchImpl = fetchRouter({
      '/v1/models': () => jsonResponse(200, { data: [] }, { server: 'ollama/0.1.30' })
    })
    await expect(probe11434(fetchImpl, 11434, 200)).resolves.toEqual({
      kind: 'compatible',
      version: '0.1.30',
      degraded: false
    })
  })

  it('ECONNREFUSED -> free', async () => {
    const fetchImpl = fetchRouter({})
    await expect(probe11434(fetchImpl, 11434, 200)).resolves.toEqual({ kind: 'free' })
  })

  it('200 but JSON without data[] -> occupied', async () => {
    const fetchImpl = fetchRouter({ '/v1/models': () => jsonResponse(200, { nope: true }) })
    const out = await probe11434(fetchImpl, 11434, 200)
    expect(out.kind).toBe('occupied')
  })

  it('timeout (fetch aborted by the probe budget) -> occupied, not free', async () => {
    const neverSettles = (_url: string, init?: { signal?: AbortSignal }): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })
    await expect(probe11434(neverSettles, 11434, 20)).resolves.toMatchObject({ kind: 'occupied' })
  })
})

describe('startApiServer arbitration (plan todo10 verbatim)', () => {
  it('external compatible endpoint -> takeover, embedded server NEVER started', async () => {
    resetShutdownState()
    const listen = vi.fn()
    const onStatus = vi.fn()
    const handle = await startApiServer({
      fetchImpl: fetchRouter({
        '/v1/models': compatibleModels,
        '/api/version': () => jsonResponse(200, { version: '0.3.1' })
      }),
      listen,
      probeTimeoutMs: 200,
      onStatus
    })
    expect(handle.status).toEqual({ mode: 'external-takeover', port: 11434, version: '0.3.1', degraded: false })
    expect(listen).not.toHaveBeenCalled()
    expect(onStatus).toHaveBeenCalledWith(handle.status)
  })

  it('degraded takeover still skips the embedded server (never kills user processes)', async () => {
    resetShutdownState()
    const handle = await startApiServer({
      fetchImpl: fetchRouter({
        '/v1/models': compatibleModels,
        '/api/version': () => jsonResponse(200, { version: '0.1.5' })
      }),
      listen: vi.fn(),
      probeTimeoutMs: 200
    })
    expect(handle.status.mode).toBe('external-takeover')
    expect(handle.status.degraded).toBe(true)
  })

  it('occupied-incompatible retries 3x then persistent conflict notice; NEVER rebinds', async () => {
    resetShutdownState()
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'not found' }))
    const notify = vi.fn()
    const listen = vi.fn()
    const sleep = vi.fn(async () => undefined)
    const handle = await startApiServer({
      fetchImpl,
      notify,
      listen,
      sleep,
      retryDelayMs: 1,
      probeTimeoutMs: 200
    })
    expect(handle.status.mode).toBe('conflict')
    expect(fetchImpl).toHaveBeenCalledTimes(4) // initial + OCCUPIED_RETRIES=3
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(listen).not.toHaveBeenCalled() // ç»ä¸æ¢å£ â€?no alternate port was ever attempted
    const notice: AppNotificationEvent = notify.mock.calls[0]?.[0]
    expect(notice.level).toBe('error')
    expect(notice.persistent).toBe(true)
    expect(notice.code).toBe('api-port-conflict')
    expect(notice.message).toMatch(/11434/)
  })

  it('free port -> embedded guarded server on 11434, stop hook registered', async () => {
    resetShutdownState()
    const closed = vi.fn(async () => undefined)
    const handle = await startApiServer({
      fetchImpl: fetchRouter({}), // all refused -> free
      listen: vi.fn(async () => ({ close: closed })),
      probeTimeoutMs: 200
    })
    expect(handle.status).toEqual({ mode: 'embedded', port: 11434 })
    await handle.stop()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('probe says free but bind races into EADDRINUSE -> conflict path, no crash', async () => {
    resetShutdownState()
    const listen = vi.fn(async () => {
      throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    })
    const handle = await startApiServer({
      fetchImpl: vi.fn(async () => {
        // first probe refused (free), every later probe sees an occupant
        if (listen.mock.calls.length === 0) {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        }
        return jsonResponse(404, {})
      }),
      listen,
      sleep: async () => undefined,
      retryDelayMs: 1,
      probeTimeoutMs: 200
    })
    expect(handle.status.mode).toBe('conflict')
  })
})

describe('Host/Origin guard (CVE-2024-28224 / Probllama middleware)', () => {
  it('pure matrix: host pinned, origin only when present', () => {
    expect(evaluateApiGuard({ headers: { host: '127.0.0.1:11434' } })).toEqual({ allow: true })
    expect(evaluateApiGuard({ headers: { host: 'localhost:11434' } })).toEqual({ allow: true })
    expect(evaluateApiGuard({ headers: { host: 'evil.example' } })).toEqual({ allow: false, reason: 'bad-host' })
    expect(evaluateApiGuard({ headers: { host: '127.0.0.1:11435' } })).toEqual({ allow: false, reason: 'bad-host' })
    expect(evaluateApiGuard({ headers: {} })).toEqual({ allow: false, reason: 'bad-host' })
    expect(evaluateApiGuard({ headers: { host: '127.0.0.1:11434', origin: 'http://localhost:5173' } })).toEqual({ allow: true })
    expect(evaluateApiGuard({ headers: { host: '127.0.0.1:11434', origin: 'http://127.0.0.1:3000' } })).toEqual({ allow: true })
    expect(evaluateApiGuard({ headers: { host: '127.0.0.1:11434', origin: 'https://evil.example' } })).toEqual({
      allow: false,
      reason: 'cross-origin'
    })
    expect(evaluateApiGuard({ headers: { host: '127.0.0.1:11434', origin: 'null' } })).toEqual({
      allow: false,
      reason: 'cross-origin'
    })
  })

  describe('against a real ephemeral guarded server (raw http.request)', () => {
    async function withGuardedServer(run: (port: number) => Promise<void>): Promise<void> {
      const server = createGuardedOpenAiServer({ port: 11434 })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        await run(addressOf(server).port)
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }

    function request(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
        })
        req.on('error', reject)
        req.end()
      })
    }

    it('hostile Host header -> 403', async () => {
      await withGuardedServer(async (port) => {
        const res = await request(port, '/v1/models', { host: 'evil.example' })
        expect(res.status).toBe(403)
        expect(JSON.parse(res.body).error.message).toMatch(/host/i)
      })
    })

    it('cross-site Origin -> 403 even with good Host', async () => {
      await withGuardedServer(async (port) => {
        const res = await request(port, '/v1/models', { host: '127.0.0.1:11434', origin: 'https://evil.example' })
        expect(res.status).toBe(403)
      })
    })

    it('missing Origin with good Host passes the guard (curl/CLI contract, plan r1 fix)', async () => {
      await withGuardedServer(async (port) => {
        // unknown path -> the untouched api/openai.ts engine answers 404:
        // proof the request crossed the guard INTO the engine unmodified.
        const res = await request(port, '/nope', { host: 'localhost:11434' })
        expect(res.status).toBe(404)
        expect(JSON.parse(res.body).error.type).toBe('invalid_request_error')
      })
    })

    it('localhost Origin passes the guard', async () => {
      await withGuardedServer(async (port) => {
        const res = await request(port, '/nope', { host: '127.0.0.1:11434', origin: 'http://localhost:5173' })
        expect(res.status).toBe(404) // through the guard, 404 from the engine
      })
    })
  })
})
