import { describe, it, expect, vi } from 'vitest'
import * as fs from 'fs'

import {
  SIDECAR_HOST,
  OPENAI_HOST,
  ALLOWED_ORIGINS,
  isLoopback,
  isSidecarHost,
  assertSidecarHost,
  assertHost,
  extractBearerToken,
  isAllowedOrigin,
  getCorsHeaders,
  buildCorsHeaders,
  cors,
  handleCorsPreflight,
  applyCorsHeaders,
  checkAuth,
  checkAuthForRequest,
  createAuthMiddleware,
  createCorsMiddleware,
} from './auth'

// ---------------------------------------------------------------------------
// invariant: sidecar only 127.0.0.1, no 0.0.0.0, no wildcard
// ---------------------------------------------------------------------------
describe('invariant — 侧车仅 127.0.0.1，禁止 0.0.0.0 与 wildcard', () => {
  it('常量为 127.0.0.1', () => {
    expect(SIDECAR_HOST).toBe('127.0.0.1')
    expect(OPENAI_HOST).toBe('127.0.0.1')
  })
  it('源码不包含 0.0.0.0', () => {
    const src = fs.readFileSync('src/api/auth.ts', 'utf-8')
    expect(src).not.toMatch(/0\.0\.0\.0/)
  })
  it('源码不包含 localhost:* 通配', () => {
    const src = fs.readFileSync('src/api/auth.ts', 'utf-8')
    // 禁止出现 localhost:* / localhost: * wildcard 写法
    expect(src).not.toMatch(/localhost:\*/)
    // 也不应出现通用通配正则如 /localhost:\.\*/
  })
  it('CORS 白名单仅两项显式', () => {
    expect([...ALLOWED_ORIGINS]).toEqual(['http://localhost:11434', 'http://localhost:5173'])
  })
  it('assertSidecarHost 仅 127.0.0.1 通过', () => {
    expect(() => assertSidecarHost('127.0.0.1')).not.toThrow()
    expect(() => assertSidecarHost('0.0.0.0')).toThrow(/127\.0\.0\.1/)
    expect(() => assertSidecarHost('127.0.0.2')).toThrow(/127\.0\.0\.1/)
    expect(() => assertSidecarHost('localhost')).toThrow(/127\.0\.0\.1/)
    expect(() => assertHost('0.0.0.0')).toThrow(/127\.0\.0\.1/)
  })
  it('isSidecarHost', () => {
    expect(isSidecarHost('127.0.0.1')).toBe(true)
    expect(isSidecarHost('0.0.0.0')).toBe(false)
    expect(isSidecarHost('::1')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isLoopback
// ---------------------------------------------------------------------------
describe('isLoopback — 回环判定', () => {
  it('127.0.0.1 / 127.0.0.0/8 为回环', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('127.0.0.2')).toBe(true)
    expect(isLoopback('127.255.255.255')).toBe(true)
    expect(isLoopback('127.0.0.1:11434')).toBe(true)
  })
  it('::1 与映射为回环', () => {
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopback('::ffff:127.0.0.2')).toBe(true)
    expect(isLoopback('[::1]')).toBe(true)
    expect(isLoopback('[::1]:5173')).toBe(true)
  })
  it('localhost 视为回环', () => {
    expect(isLoopback('localhost')).toBe(true)
  })
  it('外网地址非回环', () => {
    expect(isLoopback('192.168.1.1')).toBe(false)
    expect(isLoopback('10.0.0.1')).toBe(false)
    expect(isLoopback('8.8.8.8')).toBe(false)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('::ffff:192.168.1.1')).toBe(false)
    expect(isLoopback('172.16.0.1')).toBe(false)
  })
  it('空/非法返回 false', () => {
    expect(isLoopback(null)).toBe(false)
    expect(isLoopback(undefined)).toBe(false)
    expect(isLoopback('')).toBe(false)
    expect(isLoopback('   ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CORS — explicit whitelist only
// ---------------------------------------------------------------------------
describe('CORS — 白名单显式，禁止通配', () => {
  it('仅两显式 origin 通过', () => {
    expect(isAllowedOrigin('http://localhost:11434')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
  })
  it('其他端口/通配/大小写/尾斜杠均拒绝', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(false)
    expect(isAllowedOrigin('http://localhost:11434/')).toBe(false)
    expect(isAllowedOrigin('http://localhost:*')).toBe(false)
    expect(isAllowedOrigin('http://localhost:5173 ')).toBe(true) // trim 后通过
    expect(isAllowedOrigin('http://LOCALHOST:11434')).toBe(false) // case sensitive
    expect(isAllowedOrigin('https://localhost:11434')).toBe(false)
    expect(isAllowedOrigin('http://127.0.0.1:11434')).toBe(false)
    expect(isAllowedOrigin(null)).toBe(false)
    expect(isAllowedOrigin(undefined)).toBe(false)
    expect(isAllowedOrigin('')).toBe(false)
  })
  it('禁止 localhost:* 正则匹配', () => {
    // 若实现为正则 /http:\/\/localhost:\d+/ 会错误放行 3000，这里必须拒绝
    expect(isAllowedOrigin('http://localhost:9999')).toBe(false)
    expect(isAllowedOrigin('http://localhost:8080')).toBe(false)
  })
  it('getCorsHeaders / buildCorsHeaders 白名单返回头，非白名单 null', () => {
    const h = getCorsHeaders('http://localhost:11434')
    expect(h).not.toBeNull()
    expect(h!['Access-Control-Allow-Origin']).toBe('http://localhost:11434')
    expect(h!['Vary']).toBe('Origin')
    expect(h!['Access-Control-Allow-Methods']).toContain('GET')
    expect(getCorsHeaders('http://localhost:3000')).toBeNull()
    expect(buildCorsHeaders('http://localhost:5173')!['Access-Control-Allow-Origin']).toBe('http://localhost:5173')
    expect(buildCorsHeaders('http://evil.com')).toBeNull()
  })
  it('cors() 包装', () => {
    expect(cors('http://localhost:11434').allowed).toBe(true)
    expect(cors('http://localhost:3000').allowed).toBe(false)
    expect(cors('http://localhost:11434').headers!['Access-Control-Allow-Origin']).toBe('http://localhost:11434')
  })
  it('applyCorsHeaders 写入', () => {
    const setHeader = vi.fn()
    expect(applyCorsHeaders('http://localhost:11434', setHeader)).toBe(true)
    expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:11434')
    const set2 = vi.fn()
    expect(applyCorsHeaders('http://localhost:3000', set2)).toBe(false)
    expect(set2).not.toHaveBeenCalled()
  })
  it('handleCorsPreflight — OPTIONS 白名单 204，非白名单 null', () => {
    expect(handleCorsPreflight({ method: 'OPTIONS', headers: { origin: 'http://localhost:11434' } })!.status).toBe(204)
    expect(handleCorsPreflight({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } })).toBeNull()
    expect(handleCorsPreflight({ method: 'GET', headers: { origin: 'http://localhost:11434' } })).toBeNull()
    // Headers 对象
    const h = new Headers({ origin: 'http://localhost:5173' })
    expect(handleCorsPreflight({ method: 'OPTIONS', headers: h })!.status).toBe(204)
  })
  it('createCorsMiddleware — 白名单注入头，OPTIONS 204', () => {
    const mw = createCorsMiddleware()
    const setHeader = vi.fn()
    const status = vi.fn((c: number) => ({ end: vi.fn() }) as never)
    const next = vi.fn()
    mw({ method: 'GET', headers: { origin: 'http://localhost:11434' } }, { setHeader, status } as never, next)
    expect(setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:11434')
    expect(next).toHaveBeenCalled()

    const set2 = vi.fn()
    const end = vi.fn()
    const status2 = vi.fn(() => ({ end }) as never)
    const next2 = vi.fn()
    mw({ method: 'OPTIONS', headers: { origin: 'http://localhost:11434' } }, { setHeader: set2, status: status2 } as never, next2)
    expect(status2).toHaveBeenCalledWith(204)
    expect(end).toHaveBeenCalled()
    expect(next2).not.toHaveBeenCalled()

    const set3 = vi.fn()
    const end3 = vi.fn()
    const status3 = vi.fn(() => ({ end: end3 }) as never)
    mw({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }, { setHeader: set3, status: status3 } as never, vi.fn())
    expect(status3).toHaveBeenCalledWith(403)
  })
})

// ---------------------------------------------------------------------------
// Bearer extraction
// ---------------------------------------------------------------------------
describe('extractBearerToken', () => {
  it('解析 Bearer 字符串', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123')
    expect(extractBearerToken('bearer ABC')).toBe('ABC')
    expect(extractBearerToken('Bearer  ollama  ')).toBe('ollama')
    expect(extractBearerToken('Basic abc')).toBeUndefined()
    expect(extractBearerToken('')).toBeUndefined()
  })
  it('解析 headers 对象/Headers', () => {
    expect(extractBearerToken({ authorization: 'Bearer token1' })).toBe('token1')
    expect(extractBearerToken({ Authorization: 'Bearer token2' })).toBe('token2')
    expect(extractBearerToken(new Headers({ authorization: 'Bearer htoken' }))).toBe('htoken')
    expect(extractBearerToken({ 'x-api-key': 'ollama' } as Record<string, string>)).toBeUndefined()
    expect(extractBearerToken(null)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// checkAuth — 回环免鉴权，外网需 Bearer
// ---------------------------------------------------------------------------
describe('checkAuth — 回环免鉴权，外网需 Bearer', () => {
  it('回环无 token 直接通过', () => {
    expect(checkAuth({ remoteAddr: '127.0.0.1', headers: {} }).ok).toBe(true)
    expect(checkAuth({ remoteAddr: '127.0.0.1', headers: {} }).loopback).toBe(true)
    expect(checkAuth({ remoteAddr: '::1', headers: {} }).ok).toBe(true)
    expect(checkAuth({ remoteAddr: '::ffff:127.0.0.1', headers: {} }).ok).toBe(true)
    expect(checkAuth({ remoteAddr: '127.0.0.2', headers: {} }).ok).toBe(true)
    // 回环即使带错误 token 也放行
    expect(checkAuth({ remoteAddr: '127.0.0.1', headers: { authorization: 'Bearer wrong' } }).ok).toBe(true)
  })
  it('外网无 token 401', () => {
    const r = checkAuth({ remoteAddr: '192.168.1.10', headers: {} })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(401)
    expect(r.loopback).toBe(false)
  })
  it('外网有 Bearer 通过', () => {
    const r = checkAuth({ remoteAddr: '192.168.1.10', headers: { authorization: 'Bearer secret' } })
    expect(r.ok).toBe(true)
    expect(r.token).toBe('secret')
  })
  it('外网 Bearer via Headers 对象', () => {
    const r = checkAuth({ remoteAddr: '8.8.8.8', headers: new Headers({ authorization: 'Bearer tok' }) })
    expect(r.ok).toBe(true)
  })
  it('外网 Bearer via authorization 字符串参数', () => {
    const r = checkAuth({ remoteAddr: '10.0.0.1', authorization: 'Bearer mytok' })
    expect(r.ok).toBe(true)
    expect(r.token).toBe('mytok')
  })
  it('expectedToken 校验', () => {
    expect(checkAuth({ remoteAddr: '8.8.8.8', headers: { authorization: 'Bearer ollama' }, expectedToken: 'ollama' }).ok).toBe(true)
    expect(checkAuth({ remoteAddr: '8.8.8.8', headers: { authorization: 'Bearer wrong' }, expectedToken: 'ollama' }).ok).toBe(false)
    expect(checkAuth({ remoteAddr: '8.8.8.8', headers: { authorization: 'Bearer wrong' }, expectedToken: 'ollama' }).status).toBe(401)
  })
  it('裸 ip 字段与 remoteIp/ip 别名', () => {
    expect(checkAuth({ ip: '127.0.0.1', headers: {} }).ok).toBe(true)
    expect(checkAuth({ remoteIp: '192.168.1.1', headers: {} }).ok).toBe(false)
    expect(checkAuth({ remoteIp: '192.168.1.1', headers: { authorization: 'Bearer x' } }).ok).toBe(true)
  })
  it('无 ip 视为外网需鉴权', () => {
    expect(checkAuth({ headers: {} }).ok).toBe(false)
    expect(checkAuth({ headers: { authorization: 'Bearer x' } }).ok).toBe(true)
  })
  it('checkAuthForRequest 包装', () => {
    const req = new Request('http://127.0.0.1:11434/v1/models', { headers: { authorization: 'Bearer tok' } })
    expect(checkAuthForRequest(req, '192.168.1.1').ok).toBe(true)
    expect(checkAuthForRequest(req, '127.0.0.1').ok).toBe(true)
    const req2 = new Request('http://127.0.0.1:11434/v1/models')
    expect(checkAuthForRequest(req2, '192.168.1.1').ok).toBe(false)
    expect(checkAuthForRequest(req2, '127.0.0.1').ok).toBe(true)
  })
  it('createAuthMiddleware — 回环 next，外网 401', () => {
    const mw = createAuthMiddleware()
    const next = vi.fn()
    const json = vi.fn()
    const status = vi.fn(() => ({ json }) as never)
    mw({ ip: '127.0.0.1', headers: {} } as never, { status } as never, next)
    expect(next).toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()

    const next2 = vi.fn()
    const json2 = vi.fn()
    const status2 = vi.fn(() => ({ json: json2 }) as never)
    mw({ ip: '192.168.1.1', headers: {} } as never, { status: status2 } as never, next2)
    expect(next2).not.toHaveBeenCalled()
    expect(status2).toHaveBeenCalledWith(401)

    const next3 = vi.fn()
    const json3 = vi.fn()
    const status3 = vi.fn(() => ({ json: json3 }) as never)
    mw({ ip: '192.168.1.1', headers: { authorization: 'Bearer ok' } } as never, { status: status3 } as never, next3)
    expect(next3).toHaveBeenCalled()
  })
  it('socket.remoteAddress 回落', () => {
    const mw = createAuthMiddleware()
    const next = vi.fn()
    const status = vi.fn(() => ({ json: vi.fn() }) as never)
    mw({ socket: { remoteAddress: '::1' }, headers: {} } as never, { status } as never, next)
    expect(next).toHaveBeenCalled()
  })
})
