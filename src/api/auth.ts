/**
 * 鉴权与 CORS — Wave6 T25
 *
 *  - 回环免鉴权，外网需 Bearer
 *  - CORS 白名单窄化为 http://localhost:11434, http://localhost:5173 显式，禁止通配
 *  - 侧车仅 127.0.0.1，禁止 wildcard host 绑定
 */

export const SIDECAR_HOST = '127.0.0.1' as const
export const OPENAI_HOST = SIDECAR_HOST

export const ALLOWED_ORIGINS = [
  'http://localhost:11434',
  'http://localhost:5173',
] as const

export type AllowedOrigin = (typeof ALLOWED_ORIGINS)[number]

// ---------------------------------------------------------------------------
// Loopback
// ---------------------------------------------------------------------------

/**
 * 判断是否为回环地址 — 回环免鉴权
 * 支持 127.0.0.0/8、::1、::ffff:127.0.0.1（含映射）
 */
export function isLoopback(ip: string | null | undefined): boolean {
  if (!ip) return false
  const v = ip.trim().toLowerCase()
  if (!v) return false
  // strip port? remoteAddress usually no port, but handle "[::1]:1234" or "127.0.0.1:1234"
  // handle bracketed ipv6
  let host = v
  // "[::1]:5173" -> "::1"
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end !== -1) host = host.slice(1, end)
  } else if (host.includes(':') && !host.includes('::')) {
    // ipv4 with port "127.0.0.1:11434"
    // only strip if single colon and last part numeric
    const lastColon = host.lastIndexOf(':')
    const after = host.slice(lastColon + 1)
    if (/^\d+$/.test(after) && host.split(':').length === 2) {
      host = host.slice(0, lastColon)
    }
  }

  if (host === '127.0.0.1') return true
  if (host === '::1') return true
  if (host === '::ffff:127.0.0.1') return true
  if (host === 'localhost') return true
  // 127.0.0.0/8 whole range is loopback — treat as loopback for auth bypass
  if (host.startsWith('127.')) {
    const parts = host.split('.')
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
      return true
    }
  }
  // ::ffff:127.x.x.x mapped range
  if (host.startsWith('::ffff:127.')) return true

  return false
}

// ---------------------------------------------------------------------------
// Sidecar host invariant — only 127.0.0.1
// ---------------------------------------------------------------------------

export function isSidecarHost(host: string): boolean {
  return host === SIDECAR_HOST
}

export function assertSidecarHost(host: string): void {
  if (host !== SIDECAR_HOST) throw new Error(`sidecar host must be ${SIDECAR_HOST}, got ${host}`)
}

// for compatibility with openai.ts naming
export const assertHost = assertSidecarHost

// ---------------------------------------------------------------------------
// Bearer extraction
// ---------------------------------------------------------------------------

export function extractBearerToken(
  input: string | Record<string, string> | Headers | null | undefined,
): string | undefined {
  if (!input) return undefined
  if (typeof input === 'string') {
    const m = input.match(/^Bearer\s+(.+)$/i)
    if (m?.[1]) {
      const v = m[1].trim()
      if (v) return v
    }
    return undefined
  }
  let auth: string | undefined
  if (input instanceof Headers) {
    auth = input.get('authorization') ?? (input.get('Authorization') as string | null) ?? undefined
  } else {
    const lower = Object.fromEntries(
      Object.entries(input as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    )
    auth = lower['authorization']
  }
  if (!auth) return undefined
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (m?.[1]) {
    const v = m[1].trim()
    if (v) return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// CORS — explicit whitelist, no wildcard
// ---------------------------------------------------------------------------

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  const v = origin.trim()
  if (!v) return false
  // explicit match only — forbid wildcard logic
  return (ALLOWED_ORIGINS as readonly string[]).includes(v)
}

/** CORS 预检/普通响应头；非白名单返回 null */
export function getCorsHeaders(origin: string | null | undefined): Record<string, string> | null {
  if (!isAllowedOrigin(origin ?? undefined)) return null
  const o = (origin as string).trim()
  return {
    'Access-Control-Allow-Origin': o,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Requested-With',
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Max-Age': '86400',
  }
}

export function buildCorsHeaders(origin: string | null | undefined): Record<string, string> | null {
  return getCorsHeaders(origin)
}

export type CorsResult = {
  headers: Record<string, string> | null
  allowed: boolean
}

export function cors(origin: string | null | undefined): CorsResult {
  const headers = getCorsHeaders(origin)
  return { headers, allowed: headers !== null }
}

/** 处理 CORS 预检 OPTIONS：白名单则 204，否则 403 或 null */
export function handleCorsPreflight(req: {
  method: string
  headers: Record<string, string> | Headers
}): { status: number; headers: Record<string, string> } | null {
  const method = req.method.toUpperCase()
  if (method !== 'OPTIONS') return null
  let origin: string | undefined
  if (req.headers instanceof Headers) origin = req.headers.get('origin') ?? undefined
  else {
    const lower = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
    )
    origin = lower['origin']
  }
  const h = getCorsHeaders(origin)
  if (h) return { status: 204, headers: h }
  // not allowed — return null so caller can 403, or return empty to signal deny
  return null
}

export function applyCorsHeaders(
  origin: string | null | undefined,
  setHeader: (k: string, v: string) => void,
): boolean {
  const h = getCorsHeaders(origin)
  if (!h) return false
  for (const [k, v] of Object.entries(h)) setHeader(k, v)
  return true
}

// ---------------------------------------------------------------------------
// Auth — loopback bypass, external requires Bearer
// ---------------------------------------------------------------------------

export type CheckAuthParams = {
  remoteAddr?: string | null
  remoteIp?: string | null
  ip?: string | null
  headers?: Record<string, string> | Headers
  authorization?: string
  expectedToken?: string
  url?: string
}

export type CheckAuthResult = {
  ok: boolean
  loopback: boolean
  status?: number
  message?: string
  token?: string
}

export function checkAuth(params: CheckAuthParams): CheckAuthResult {
  const ip = params.remoteAddr ?? params.remoteIp ?? params.ip ?? null
  const loopback = isLoopback(ip ?? undefined)
  if (loopback) return { ok: true, loopback: true }

  // external — require Bearer
  let token: string | undefined
  if (params.authorization) {
    token = extractBearerToken(params.authorization)
  }
  if (!token && params.headers) {
    token = extractBearerToken(params.headers as Record<string, string> | Headers)
  }
  // also try url query? spec says Bearer only for external, but we also support api_key query for compat
  // strict: external must provide Bearer, not query — so we do NOT accept query here to keep narrow

  if (!token) {
    return { ok: false, loopback: false, status: 401, message: 'Unauthorized: Bearer token required for non-loopback' }
  }
  if (params.expectedToken !== undefined) {
    if (token !== params.expectedToken) {
      return { ok: false, loopback: false, status: 401, message: 'Unauthorized: invalid token', token }
    }
  }
  return { ok: true, loopback: false, token }
}

/** Fetch Request 便捷封装 */
export function checkAuthForRequest(
  req: Request,
  remoteAddr?: string | null,
  expectedToken?: string,
): CheckAuthResult {
  // try to infer remoteAddr from x-forwarded-for if explicitly passed? we don't trust it — caller must provide socket addr
  return checkAuth({
    remoteAddr: remoteAddr ?? null,
    headers: req.headers as unknown as Headers,
    expectedToken,
    url: req.url,
  })
}

// Express-like middleware helper
export function createAuthMiddleware(opts: { expectedToken?: string } = {}) {
  return (
    req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, string>; url?: string },
    res: { status: (c: number) => { json: (o: unknown) => void } },
    next: () => void,
  ) => {
    const addr = req.ip ?? req.socket?.remoteAddress ?? null
    const result = checkAuth({ remoteAddr: addr, headers: req.headers, expectedToken: opts.expectedToken })
    if (result.ok) {
      next()
      return
    }
    res.status(result.status ?? 401).json({ error: { message: result.message, type: 'invalid_request_error', code: 'unauthorized' } })
  }
}

export function createCorsMiddleware() {
  return (
    req: { method: string; headers: Record<string, string> },
    res: { setHeader: (k: string, v: string) => void; status: (c: number) => { end: () => void } },
    next: () => void,
  ) => {
    const origin = (() => {
      const lower = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]))
      return lower['origin']
    })()
    const headers = getCorsHeaders(origin)
    if (headers) {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
    }
    if (req.method.toUpperCase() === 'OPTIONS') {
      if (headers) {
        res.status(204).end()
        return
      }
      // not allowed origin preflight -> 403
      res.status(403).end()
      return
    }
    // For non-OPTIONS, if origin present but not allowed, we still continue but without CORS headers
    // Optionally block? Spec says narrow whitelist, so non-whitelisted origins simply get no CORS header
    next()
  }
}

export default {
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
}
