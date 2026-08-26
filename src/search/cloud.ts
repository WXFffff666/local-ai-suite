/**
 * Cloud search adapters — unified ISearchAdapter over Tavily / Exa / Brave Search.
 *
 * MIT only. No AGPL code is imported or bundled here.
 * All three providers are consumed via their public HTTPS APIs (remote, not sidecar).
 * Local SearXNG remains the offline default (see searxng.ts, AGPL isolated).
 * Cloud adapters are opt-in: keys stored in user config / env, unset => hidden in UI.
 *
 * Providers:
 * - Tavily  : POST https://api.tavily.com/search
 * - Exa     : POST https://api.exa.ai/search  (header x-api-key)
 * - Brave   : GET  https://api.search.brave.com/res/v1/web/search (header X-Subscription-Token)
 *
 * Spec (Wave4 T17):
 * - Unified ISearchAdapter { name, bin, args, port, healthUrl, search }
 * - Config page: env keys TAVILY_API_KEY / EXA_API_KEY / BRAVE_API_KEY
 * - 未填隐藏: providers with no key are hidden (see getVisibleProviders / isConfigured)
 * - 费率提示: per-provider cost hint surfaced to UI
 */

import type { ISearchAdapter, SearchResultItem } from '../core/types'

// ---------------------------------------------------------------------------
// Constants & env keys
// ---------------------------------------------------------------------------

export const TAVILY_NAME = 'tavily' as const
export const EXA_NAME = 'exa' as const
export const BRAVE_NAME = 'brave' as const

export const TAVILY_ENV_KEY = 'TAVILY_API_KEY' as const
export const EXA_ENV_KEY = 'EXA_API_KEY' as const
export const BRAVE_ENV_KEY = 'BRAVE_API_KEY' as const

export type CloudProviderId = typeof TAVILY_NAME | typeof EXA_NAME | typeof BRAVE_NAME

export const TAVILY_API_URL = 'https://api.tavily.com/search' as const
export const EXA_API_URL = 'https://api.exa.ai/search' as const
export const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search' as const

// Dummy sidecar fields — cloud adapters do not spawn a process.
// Values are valid loopback so they satisfy SidecarManager assert if ever passed,
// but SidecarManager is never instantiated for cloud adapters (remote HTTPS only).
const DUMMY_PORT_BASE = 11439 as const
const DUMMY_HEALTH = (port: number): string => `http://127.0.0.1:${port}/healthz`
const DUMMY_BIN = 'cloud' as const

// ---------------------------------------------------------------------------
// Cost / rate hints — shown in config page, not enforced in code.
// ---------------------------------------------------------------------------

export type CloudCostHint = {
  /** Short label for UI badge. */
  label: string
  /** Longer tooltip / detail line. */
  detail: string
  /** Docs / pricing URL. */
  docsUrl: string
}

export const CLOUD_COST_HINTS: Record<CloudProviderId, CloudCostHint> = {
  [TAVILY_NAME]: {
    label: '约 $0.008 / 次 (Basic)',
    detail: 'Tavily Basic $0.008/req, Advanced $0.02/req, 含 5 credits 免费额度。按量计费，超额自动计费。',
    docsUrl: 'https://docs.tavily.com/docs/pricing',
  },
  [EXA_NAME]: {
    label: '约 $0.005 / 次',
    detail: 'Exa $5 / 1000 次搜索 ($0.005/req)，实时爬取另计费。免费层 100 次/月。',
    docsUrl: 'https://docs.exa.ai/reference/pricing',
  },
  [BRAVE_NAME]: {
    label: '约 $0.003 / 次',
    detail: 'Brave Search API $3 / 1000 次 ($0.003/req)，免费层 2000 次/月。超出按阶梯计费。',
    docsUrl: 'https://brave.com/search/api/guides/pricing/',
  },
}

// ---------------------------------------------------------------------------
// Provider meta for config page
// ---------------------------------------------------------------------------

export type CloudProviderMeta = {
  id: CloudProviderId
  name: string
  envKey: typeof TAVILY_ENV_KEY | typeof EXA_ENV_KEY | typeof BRAVE_ENV_KEY
  label: string
  placeholder: string
  costHint: CloudCostHint
  /** Whether this provider is enabled (key present). */
  configured: boolean
  /** If false the UI should hide this row (未填隐藏). */
  visible: boolean
}

export function resolveCloudApiKey(
  envKey: string,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim()
  if (typeof process !== 'undefined' && process.env) {
    const v = (process.env as Record<string, string | undefined>)[envKey]
    if (v && v.trim() !== '') return v.trim()
  }
  // renderer may pass env bag explicitly; caller can use getVisibleProviders(envBag)
  return undefined
}

export function isCloudProviderConfigured(
  id: CloudProviderId,
  envBag?: Record<string, string | undefined>,
  explicitKey?: string,
): boolean {
  const envKey = providerEnvKey(id)
  if (explicitKey !== undefined) return explicitKey.trim() !== ''
  if (envBag) {
    const v = envBag[envKey]
    return !!v && v.trim() !== ''
  }
  return !!resolveCloudApiKey(envKey)
}

export function providerEnvKey(id: CloudProviderId): string {
  switch (id) {
    case TAVILY_NAME: return TAVILY_ENV_KEY
    case EXA_NAME: return EXA_ENV_KEY
    case BRAVE_NAME: return BRAVE_ENV_KEY
    default: return ''
  }
}

export function providerCostHint(id: CloudProviderId): CloudCostHint {
  return CLOUD_COST_HINTS[id]
}

/**
 * Build meta list for config page.
 * - 未填隐藏: when hideUnconfigured===true, providers without key are omitted.
 * - 费率提示: each item carries costHint.
 */
export function getCloudProviderMetas(
  envBag?: Record<string, string | undefined>,
  opts: { hideUnconfigured?: boolean } = {},
): CloudProviderMeta[] {
  const all: CloudProviderMeta[] = ([
    {
      id: TAVILY_NAME,
      name: 'Tavily',
      envKey: TAVILY_ENV_KEY,
      label: 'Tavily',
      placeholder: 'tvly-...',
    },
    {
      id: EXA_NAME,
      name: 'Exa',
      envKey: EXA_ENV_KEY,
      label: 'Exa',
      placeholder: 'exa_...',
    },
    {
      id: BRAVE_NAME,
      name: 'Brave Search',
      envKey: BRAVE_ENV_KEY,
      label: 'Brave',
      placeholder: 'BSA...',
    },
  ] as const).map((p) => {
    const raw = envBag ? envBag[p.envKey] : resolveCloudApiKey(p.envKey)
    const configured = !!raw && raw.trim() !== ''
    return {
      id: p.id as CloudProviderId,
      name: p.name,
      envKey: p.envKey,
      label: p.label,
      placeholder: p.placeholder,
      costHint: CLOUD_COST_HINTS[p.id as CloudProviderId],
      configured,
      visible: true,
    }
  })

  if (opts.hideUnconfigured) {
    return all.filter((m) => m.configured)
  }
  return all
}

/** Alias: visible providers (未填隐藏) — only configured ones. */
export function getVisibleCloudProviders(
  envBag?: Record<string, string | undefined>,
): CloudProviderMeta[] {
  return getCloudProviderMetas(envBag, { hideUnconfigured: true })
}

// ---------------------------------------------------------------------------
// Shared search options & helpers
// ---------------------------------------------------------------------------

export type CloudSearchOptions = {
  count?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
  /** Override API key for this call (overrides env). */
  apiKey?: string
}

function getFetchImpl(explicit?: typeof fetch): typeof fetch {
  if (explicit) return explicit
  const g = globalThis as unknown as { fetch?: typeof fetch }
  if (g.fetch) return g.fetch
  return (() => {
    throw new Error('fetch not available in this environment')
  }) as unknown as typeof fetch
}

function sliceCount<T>(arr: T[], count?: number): T[] {
  if (typeof count === 'number' && count >= 0) return arr.slice(0, count)
  return arr
}

function requireApiKey(
  id: CloudProviderId,
  optsApiKey: string | undefined,
  envBag?: Record<string, string | undefined>,
): string {
  // explicit optsApiKey wins, then envBag, then process.env
  if (optsApiKey && optsApiKey.trim()) return optsApiKey.trim()
  if (envBag) {
    const k = providerEnvKey(id)
    const v = envBag[k]
    if (v && v.trim()) return v.trim()
  }
  const resolved = resolveCloudApiKey(providerEnvKey(id))
  if (resolved) return resolved
  throw new Error(`[cloud-search] ${id} apiKey missing — set ${providerEnvKey(id)} in config page`)
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<Response> {
  const ctrl = outerSignal ? undefined : timeoutMs > 0 ? new AbortController() : undefined
  const signal = outerSignal ?? ctrl?.signal
  let tid: ReturnType<typeof setTimeout> | undefined
  if (ctrl && timeoutMs > 0) tid = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: signal as AbortSignal | undefined })
  } finally {
    if (tid) clearTimeout(tid)
  }
}

// ---------------------------------------------------------------------------
// Tavily
// ---------------------------------------------------------------------------

export type TavilyRawResult = {
  title?: string
  url?: string
  content?: string
  snippet?: string
  score?: number
}

export type TavilyRawResponse = {
  answer?: string
  query?: string
  results?: TavilyRawResult[]
  response_time?: number
}

export function normalizeTavilyResults(raw: TavilyRawResponse): SearchResultItem[] {
  const list = Array.isArray(raw.results) ? raw.results : []
  return list
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : (r.url as string),
      url: r.url as string,
      snippet:
        typeof r.content === 'string' && r.content.trim()
          ? r.content.trim()
          : typeof r.snippet === 'string'
            ? r.snippet.trim()
            : '',
    }))
}

export async function fetchTavily(
  query: string,
  opts: CloudSearchOptions & { envBag?: Record<string, string | undefined> } = {},
): Promise<SearchResultItem[]> {
  const q = query?.trim()
  if (!q) return []
  const apiKey = requireApiKey(TAVILY_NAME, opts.apiKey, opts.envBag)
  const fetchImpl = getFetchImpl(opts.fetchImpl)
  const timeoutMs = opts.timeoutMs ?? 8000
  const res = await fetchWithTimeout(
    fetchImpl,
    TAVILY_API_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        max_results: opts.count ?? 5,
        search_depth: 'basic',
        include_answer: false,
      }),
    },
    timeoutMs,
    opts.signal,
  )
  if (!res.ok) throw new Error(`tavily search failed: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as TavilyRawResponse
  return sliceCount(normalizeTavilyResults(data), opts.count)
}

// ---------------------------------------------------------------------------
// Exa
// ---------------------------------------------------------------------------

export type ExaRawResult = {
  title?: string
  url?: string
  text?: string
  snippet?: string
  publishedDate?: string
  score?: number
}

export type ExaRawResponse = {
  results?: ExaRawResult[]
  requestId?: string
}

export function normalizeExaResults(raw: ExaRawResponse): SearchResultItem[] {
  const list = Array.isArray(raw.results) ? raw.results : []
  return list
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : (r.url as string),
      url: r.url as string,
      snippet:
        typeof r.text === 'string' && r.text.trim()
          ? r.text.trim().slice(0, 500)
          : typeof r.snippet === 'string'
            ? r.snippet.trim()
            : '',
    }))
}

export async function fetchExa(
  query: string,
  opts: CloudSearchOptions & { envBag?: Record<string, string | undefined> } = {},
): Promise<SearchResultItem[]> {
  const q = query?.trim()
  if (!q) return []
  const apiKey = requireApiKey(EXA_NAME, opts.apiKey, opts.envBag)
  const fetchImpl = getFetchImpl(opts.fetchImpl)
  const timeoutMs = opts.timeoutMs ?? 8000
  const res = await fetchWithTimeout(
    fetchImpl,
    EXA_API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: q,
        numResults: opts.count ?? 5,
        type: 'auto',
      }),
    },
    timeoutMs,
    opts.signal,
  )
  if (!res.ok) throw new Error(`exa search failed: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as ExaRawResponse
  return sliceCount(normalizeExaResults(data), opts.count)
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------

export type BraveRawResult = {
  title?: string
  url?: string
  description?: string
  snippet?: string
  age?: string
}

export type BraveRawResponse = {
  web?: { results?: BraveRawResult[] }
  results?: BraveRawResult[]
}

export function normalizeBraveResults(raw: BraveRawResponse): SearchResultItem[] {
  const list = raw.web?.results ?? raw.results ?? []
  const arr = Array.isArray(list) ? list : []
  return arr
    .filter((r) => typeof r.url === 'string' && r.url.length > 0)
    .map((r) => ({
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : (r.url as string),
      url: r.url as string,
      snippet:
        typeof r.description === 'string' && r.description.trim()
          ? r.description.trim()
          : typeof r.snippet === 'string'
            ? r.snippet.trim()
            : '',
    }))
}

export async function fetchBrave(
  query: string,
  opts: CloudSearchOptions & { envBag?: Record<string, string | undefined> } = {},
): Promise<SearchResultItem[]> {
  const q = query?.trim()
  if (!q) return []
  const apiKey = requireApiKey(BRAVE_NAME, opts.apiKey, opts.envBag)
  const fetchImpl = getFetchImpl(opts.fetchImpl)
  const timeoutMs = opts.timeoutMs ?? 8000
  const url = new URL(BRAVE_API_URL)
  url.searchParams.set('q', q)
  url.searchParams.set('count', String(opts.count ?? 5))
  const res = await fetchWithTimeout(
    fetchImpl,
    url.toString(),
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
    timeoutMs,
    opts.signal,
  )
  if (!res.ok) throw new Error(`brave search failed: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as BraveRawResponse
  return sliceCount(normalizeBraveResults(data), opts.count)
}

// ---------------------------------------------------------------------------
// ISearchAdapter implementations — unified interface
// ---------------------------------------------------------------------------

export type CloudAdapterOptions = CloudSearchOptions & {
  /** Explicit API key (overrides env). */
  apiKey?: string
  /** Env bag for renderer (since process.env may not be available). */
  envBag?: Record<string, string | undefined>
}

function cloudAdapterBase(
  id: CloudProviderId,
  portOffset: number,
): Pick<ISearchAdapter, 'name' | 'bin' | 'args' | 'port' | 'healthUrl'> {
  const port = DUMMY_PORT_BASE + portOffset
  return {
    name: id === BRAVE_NAME ? 'brave-search' : id,
    bin: `${DUMMY_BIN}-${id}`,
    args: [],
    port,
    healthUrl: DUMMY_HEALTH(port),
  }
}

/** Tavily — ISearchAdapter */
export class TavilyAdapter implements ISearchAdapter {
  name: string
  bin: string
  args: string[]
  port: number
  healthUrl: string
  private readonly apiKey?: string
  private readonly envBag?: Record<string, string | undefined>
  private readonly defaultCount?: number

  constructor(opts: CloudAdapterOptions = {}) {
    const base = cloudAdapterBase(TAVILY_NAME, 0)
    this.name = base.name
    this.bin = base.bin
    this.args = base.args
    this.port = base.port
    this.healthUrl = base.healthUrl
    this.apiKey = opts.apiKey ?? resolveCloudApiKey(TAVILY_ENV_KEY)
    this.envBag = opts.envBag
    this.defaultCount = opts.count
  }

  /** Whether key is present (for UI hide/show). */
  get isConfigured(): boolean {
    return isCloudProviderConfigured(TAVILY_NAME, this.envBag, this.apiKey)
  }

  get costHint(): CloudCostHint {
    return CLOUD_COST_HINTS[TAVILY_NAME]
  }

  async search(query: string, opts?: { count?: number }): Promise<SearchResultItem[]> {
    return fetchTavily(query, {
      count: opts?.count ?? this.defaultCount,
      apiKey: this.apiKey,
      envBag: this.envBag,
    })
  }
}

/** Exa — ISearchAdapter */
export class ExaAdapter implements ISearchAdapter {
  name: string
  bin: string
  args: string[]
  port: number
  healthUrl: string
  private readonly apiKey?: string
  private readonly envBag?: Record<string, string | undefined>
  private readonly defaultCount?: number

  constructor(opts: CloudAdapterOptions = {}) {
    const base = cloudAdapterBase(EXA_NAME, 1)
    this.name = base.name
    this.bin = base.bin
    this.args = base.args
    this.port = base.port
    this.healthUrl = base.healthUrl
    this.apiKey = opts.apiKey ?? resolveCloudApiKey(EXA_ENV_KEY)
    this.envBag = opts.envBag
    this.defaultCount = opts.count
  }

  get isConfigured(): boolean {
    return isCloudProviderConfigured(EXA_NAME, this.envBag, this.apiKey)
  }

  get costHint(): CloudCostHint {
    return CLOUD_COST_HINTS[EXA_NAME]
  }

  async search(query: string, opts?: { count?: number }): Promise<SearchResultItem[]> {
    return fetchExa(query, {
      count: opts?.count ?? this.defaultCount,
      apiKey: this.apiKey,
      envBag: this.envBag,
    })
  }
}

/** Brave Search — ISearchAdapter */
export class BraveAdapter implements ISearchAdapter {
  name: string
  bin: string
  args: string[]
  port: number
  healthUrl: string
  private readonly apiKey?: string
  private readonly envBag?: Record<string, string | undefined>
  private readonly defaultCount?: number

  constructor(opts: CloudAdapterOptions = {}) {
    const base = cloudAdapterBase(BRAVE_NAME, 2)
    this.name = base.name
    this.bin = base.bin
    this.args = base.args
    this.port = base.port
    this.healthUrl = base.healthUrl
    this.apiKey = opts.apiKey ?? resolveCloudApiKey(BRAVE_ENV_KEY)
    this.envBag = opts.envBag
    this.defaultCount = opts.count
  }

  get isConfigured(): boolean {
    return isCloudProviderConfigured(BRAVE_NAME, this.envBag, this.apiKey)
  }

  get costHint(): CloudCostHint {
    return CLOUD_COST_HINTS[BRAVE_NAME]
  }

  async search(query: string, opts?: { count?: number }): Promise<SearchResultItem[]> {
    return fetchBrave(query, {
      count: opts?.count ?? this.defaultCount,
      apiKey: this.apiKey,
      envBag: this.envBag,
    })
  }
}

// ---------------------------------------------------------------------------
// Factory helpers — for app wiring & config page
// ---------------------------------------------------------------------------

export type CreateCloudAdaptersOptions = {
  envBag?: Record<string, string | undefined>
  /** Explicit keys override envBag / process.env */
  tavilyApiKey?: string
  exaApiKey?: string
  braveApiKey?: string
  /** Hide unconfigured providers (default true for search, false for config page). */
  hideUnconfigured?: boolean
  defaultCount?: number
}

/**
 * Create all cloud adapters that have a key (未填隐藏 when hideUnconfigured=true).
 * Returns ISearchAdapter[] ready to be tried in order or registered.
 */
export function createCloudAdapters(opts: CreateCloudAdaptersOptions = {}): ISearchAdapter[] {
  const bag = opts.envBag
  const adapters: ISearchAdapter[] = []

  const tavilyKey = opts.tavilyApiKey ?? (bag ? bag[TAVILY_ENV_KEY] : resolveCloudApiKey(TAVILY_ENV_KEY))
  const exaKey = opts.exaApiKey ?? (bag ? bag[EXA_ENV_KEY] : resolveCloudApiKey(EXA_ENV_KEY))
  const braveKey = opts.braveApiKey ?? (bag ? bag[BRAVE_ENV_KEY] : resolveCloudApiKey(BRAVE_ENV_KEY))

  const hide = opts.hideUnconfigured ?? true

  if (tavilyKey && tavilyKey.trim()) {
    adapters.push(new TavilyAdapter({ apiKey: tavilyKey.trim(), envBag: bag, count: opts.defaultCount }))
  } else if (!hide) {
    adapters.push(new TavilyAdapter({ apiKey: undefined, envBag: bag, count: opts.defaultCount }))
  }

  if (exaKey && exaKey.trim()) {
    adapters.push(new ExaAdapter({ apiKey: exaKey.trim(), envBag: bag, count: opts.defaultCount }))
  } else if (!hide) {
    adapters.push(new ExaAdapter({ apiKey: undefined, envBag: bag, count: opts.defaultCount }))
  }

  if (braveKey && braveKey.trim()) {
    adapters.push(new BraveAdapter({ apiKey: braveKey.trim(), envBag: bag, count: opts.defaultCount }))
  } else if (!hide) {
    adapters.push(new BraveAdapter({ apiKey: undefined, envBag: bag, count: opts.defaultCount }))
  }

  return adapters
}

/** Create a single adapter by provider id. */
export function createCloudAdapter(
  id: CloudProviderId,
  opts: CloudAdapterOptions = {},
): ISearchAdapter {
  switch (id) {
    case TAVILY_NAME: return new TavilyAdapter(opts)
    case EXA_NAME: return new ExaAdapter(opts)
    case BRAVE_NAME: return new BraveAdapter(opts)
    default: throw new Error(`unknown cloud provider: ${id}`)
  }
}

/** Whether any cloud provider is configured (for UI empty-state / fallback to SearXNG). */
export function isAnyCloudConfigured(envBag?: Record<string, string | undefined>): boolean {
  return getVisibleCloudProviders(envBag).length > 0
}

export default {
  TavilyAdapter,
  ExaAdapter,
  BraveAdapter,
  createCloudAdapters,
  createCloudAdapter,
  getCloudProviderMetas,
  getVisibleCloudProviders,
  isCloudProviderConfigured,
  isAnyCloudConfigured,
  CLOUD_COST_HINTS,
}
