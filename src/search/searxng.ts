/**
 * SearXNG search adapter — ISearchAdapter over sidecars/searxng (AGPL isolated).
 *
 * AGPL 隔离说明 (AGPL Isolation):
 * - SearXNG (AGPL-3.0) 仅以独立 sidecar 进程运行 (sidecars/searxng, Docker 或源码启动)，
 *   主进程 (MIT) 不以任何形式 link / import / bundle 其源码。
 * - 唯一交互边界为本地 HTTP: 127.0.0.1:7788 GET /search?format=json
 *   属于“通过网络的独立程序通信”，不构成衍生作品，主进程保持 MIT 许可。
 * - 分发时 sidecars/searxng 按 AGPL-3.0 单独提供源码获取方式 (见 THIRD_PARTY_NOTICES.md)，
 *   禁止将 SearXNG 代码直接编译进 Electron 主进程/渲染进程。
 * - 环境变量 SEARXNG_URL / SEARXNG_PORT 可覆盖端点，但 host 必须保持 127.0.0.1。
 *
 * Spec (Wave4 T16):
 * - Endpoint: http://127.0.0.1:7788/search?format=json&q=<query>
 * - Raw response: { query, number_of_results, results: [{ title, url, content }...] }
 * - Normalized: SearchResultItem { title, url, snippet }
 * - Consumer: SidecarManager 负责拉起 sidecars/searxng，健康检查复用 healthUrl。
 */

import type { ISearchAdapter, SearchResultItem } from '../core/types'

// ---------------------------------------------------------------------------
// Constants — must be 127.0.0.1 per security baseline
// ---------------------------------------------------------------------------

export const SEARXNG_NAME = 'searxng' as const
export const SEARXNG_HOST = '127.0.0.1' as const
export const SEARXNG_PORT = 7788 as const
export const SEARXNG_SEARCH_PATH = '/search' as const
export const SEARXNG_HEALTH_PATH = '/healthz' as const
export const SEARXNG_HEALTH_URL = `http://${SEARXNG_HOST}:${SEARXNG_PORT}${SEARXNG_HEALTH_PATH}` as const
export const SEARXNG_SEARCH_URL = `http://${SEARXNG_HOST}:${SEARXNG_PORT}${SEARXNG_SEARCH_PATH}` as const
export const DEFAULT_SEARXNG_BIN = 'docker' as const

// ---------------------------------------------------------------------------
// Env / URL resolvers
// ---------------------------------------------------------------------------

export function resolveSearxngBin(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim()
  const env = (typeof process !== 'undefined' ? process.env['SEARXNG_BIN'] : undefined) as
    | string
    | undefined
  if (env && env.trim()) return env.trim()
  return DEFAULT_SEARXNG_BIN
}

export function resolveSearxngPort(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
  const env = (typeof process !== 'undefined' ? process.env['SEARXNG_PORT'] : undefined) as
    | string
    | undefined
  if (env && env.trim()) {
    const n = Number(env.trim())
    if (Number.isFinite(n) && n >= 1024 && n <= 65535) return n
  }
  return SEARXNG_PORT
}

export function getSearxngBaseUrl(port: number = resolveSearxngPort()): string {
  if (port < 1024 || port > 65535) throw new Error(`port out of range: ${port}`)
  return `http://${SEARXNG_HOST}:${port}`
}

export function getSearxngSearchUrl(port: number = resolveSearxngPort()): string {
  return `${getSearxngBaseUrl(port)}${SEARXNG_SEARCH_PATH}`
}

export function getSearxngHealthUrl(port: number = resolveSearxngPort()): string {
  return `${getSearxngBaseUrl(port)}${SEARXNG_HEALTH_PATH}`
}

// ---------------------------------------------------------------------------
// Raw SearXNG JSON types
// ---------------------------------------------------------------------------

export type SearxngRawResult = {
  title?: string
  url?: string
  content?: string
  snippet?: string
  engine?: string
  score?: number
}

export type SearxngRawResponse = {
  query?: string
  number_of_results?: number
  results?: SearxngRawResult[]
}

// ---------------------------------------------------------------------------
// Normalizer — raw -> SearchResultItem { title, url, snippet }
// ---------------------------------------------------------------------------

export function normalizeSearxngResults(raw: SearxngRawResponse): SearchResultItem[] {
  const list = Array.isArray(raw.results) ? raw.results : []
  return list
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : r.url ?? '',
      url: r.url as string,
      snippet:
        typeof r.content === 'string' && r.content.trim()
          ? r.content.trim()
          : typeof r.snippet === 'string'
            ? r.snippet.trim()
            : '',
    }))
}

// ---------------------------------------------------------------------------
// fetchSearxng — direct HTTP call to sidecar
// ---------------------------------------------------------------------------

export type FetchSearxngOptions = {
  /** Max results to request (passed as pageno-independent limit; client-side slice applied). */
  count?: number
  /** Override base URL, e.g. http://127.0.0.1:7788 — must still be 127.0.0.1 if provided. */
  baseUrl?: string
  /** Custom fetch impl for tests. */
  fetchImpl?: typeof fetch
  /** AbortSignal passthrough. */
  signal?: AbortSignal
  /** Request timeout ms (default 8000). 0 = no timeout. */
  timeoutMs?: number
}

/**
 * Call SearXNG sidecar: GET /search?format=json&q=<query>
 * Returns normalized SearchResultItem[].
 */
export async function fetchSearxng(
  query: string,
  opts: FetchSearxngOptions = {},
): Promise<SearchResultItem[]> {
  const q = query?.trim()
  if (!q) return []

  const fetchFn: typeof fetch =
    opts.fetchImpl ??
    ((globalThis as unknown as { fetch?: typeof fetch }).fetch as typeof fetch | undefined) ??
    (() => {
      throw new Error('fetch not available in this environment')
    }) as unknown as typeof fetch

  const base = opts.baseUrl ?? getSearxngSearchUrl()
  // Enforce 127.0.0.1 boundary when baseUrl is explicit
  if (opts.baseUrl) {
    try {
      const u = new URL(opts.baseUrl)
      if (u.hostname !== SEARXNG_HOST) {
        throw new Error(`searxng baseUrl host must be ${SEARXNG_HOST}, got ${u.hostname}`)
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('host must be')) throw e
      throw new Error(`invalid baseUrl: ${opts.baseUrl}`)
    }
  }

  const url = new URL(`${base.replace(/\/$/, '')}${SEARXNG_SEARCH_PATH}`)
  url.searchParams.set('q', q)
  url.searchParams.set('format', 'json')
  // SearXNG uses `pageno` for paging; count is applied client-side via slice

  const timeoutMs = opts.timeoutMs ?? 8000
  const controller = opts.signal ? undefined : timeoutMs > 0 ? new AbortController() : undefined
  const signal = opts.signal ?? controller?.signal
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  }

  try {
    const res = await fetchFn(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: signal as AbortSignal | undefined,
    })
    if (!res.ok) {
      throw new Error(`searxng search failed: ${res.status} ${res.statusText}`)
    }
    const data = (await res.json()) as SearxngRawResponse
    const normalized = normalizeSearxngResults(data)
    if (typeof opts.count === 'number' && opts.count >= 0) {
      return normalized.slice(0, opts.count)
    }
    return normalized
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// ---------------------------------------------------------------------------
// ISearchAdapter factory / class — for SidecarManager consumption
// ---------------------------------------------------------------------------

export type BuildSearxngArgsOptions = {
  port?: number
  host?: string
  extraArgs?: string[]
}

export function buildSearxngArgs(opts: BuildSearxngArgsOptions = {}): string[] {
  const host = opts.host ?? SEARXNG_HOST
  const port = opts.port ?? SEARXNG_PORT
  if (host !== SEARXNG_HOST) {
    throw new Error(`searxng sidecar host must be ${SEARXNG_HOST}, got ${host}`)
  }
  if (port < 1024 || port > 65535) throw new Error(`port out of range: ${port}`)
  // Typical invocation is `docker compose up searxng` or `python -m searxng`; extraArgs passthrough
  const args: string[] = []
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  return args
}

export type CreateSearxngSidecarOptions = BuildSearxngArgsOptions & {
  bin?: string
}

export function createSearxngSidecarConfig(opts: CreateSearxngSidecarOptions = {}): ISearchAdapter {
  const bin = resolveSearxngBin(opts.bin)
  const port = opts.port ?? resolveSearxngPort()
  const args = buildSearxngArgs({ ...opts, port })
  const healthUrl = getSearxngHealthUrl(port)
  return {
    name: SEARXNG_NAME,
    bin,
    args,
    port,
    healthUrl,
    search: (query: string, sopts?: { count?: number }) =>
      fetchSearxng(query, { count: sopts?.count, baseUrl: getSearxngBaseUrl(port) }),
  }
}

/**
 * Class wrapper implementing ISearchAdapter — alternative to factory for DI.
 */
export class SearxngAdapter implements ISearchAdapter {
  name = SEARXNG_NAME
  bin: string
  args: string[]
  port: number
  healthUrl: string

  constructor(opts: CreateSearxngSidecarOptions = {}) {
    const cfg = createSearxngSidecarConfig(opts)
    this.bin = cfg.bin
    this.args = cfg.args
    this.port = cfg.port
    this.healthUrl = cfg.healthUrl
  }

  search(query: string, opts?: { count?: number }): Promise<SearchResultItem[]> {
    return fetchSearxng(query, { count: opts?.count, baseUrl: getSearxngBaseUrl(this.port) })
  }
}

export default SearxngAdapter
