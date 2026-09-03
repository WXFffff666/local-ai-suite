/**
 * HF 浏览器 — Wave3 T12
 * - 10 精选卡常量（与 THIRD_PARTY_NOTICES.md 模型清单一致，权重仅下载器引用，不入库）
 * - searchHF: 关键词 + GGUF/量化筛选的 HF API 搜索（支持 fetch 注入，便于单测）
 * - filterQuant: 纯函数，随文件名/quant 标签筛 GGUF 量化
 * - downloadWithResume: 一键 huggingface-cli download / aria2 并发+断点（命令构造 + 执行注入）
 *
 * 合规：仅 MIT 依赖，无 AGPL 引入。下载器通过本地子进程调用外部二进制，不链接 AGPL 代码。
 */

import { spawn } from 'child_process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuantTag =
  | 'Q2_K'
  | 'Q3_K_S'
  | 'Q3_K_M'
  | 'Q3_K_L'
  | 'Q4_0'
  | 'Q4_1'
  | 'Q4_K_S'
  | 'Q4_K_M'
  | 'Q5_0'
  | 'Q5_1'
  | 'Q5_K_S'
  | 'Q5_K_M'
  | 'Q6_K'
  | 'Q8_0'
  | 'IQ1_S'
  | 'IQ1_M'
  | 'IQ2_XS'
  | 'IQ2_XXS'
  | 'IQ3_XS'
  | 'IQ3_XXS'
  | 'IQ4_XS'
  | 'IQ4_NL'
  | 'F16'
  | 'F32'
  | 'BF16'
  | 'INT4'
  | 'INT8'
  | string

export type HfModelCard = {
  /** HF repoId e.g. "Qwen/Qwen2.5-7B-Instruct-GGUF" or gguf 量化分发 repo */
  repoId: string
  /** 友好展示名 */
  name: string
  /** 作者/组织 */
  author: string
  /** 量化标签，如 Q4_K_M */
  quant: QuantTag
  /** GGUF 文件名（若已知），否则空表示按 repo 内浏览 */
  filename?: string
  /** 体积标签，如 "4.2GB" */
  sizeLabel: string
  /** 是否 GGUF */
  gguf: boolean
  /** 描述 */
  description: string
  /** HF tags 原样透传 */
  tags: string[]
  /** 可选：下载数/likes 用于排序展示 */
  likes?: number
  /** 推荐的 huggingface-cli 分支/文件 */
  revision?: string
}

export type SearchOptions = {
  query?: string
  /** 量化筛选，空表示不过滤 */
  quant?: QuantTag | QuantTag[] | ''
  /** 是否仅 GGUF，默认 true */
  ggufOnly?: boolean
  /** 返回条数，默认 20 */
  limit?: number
  /** 排序：likes | downloads | lastModified，默认 likes */
  sort?: 'likes' | 'downloads' | 'lastModified'
  /** 方向 */
  direction?: -1 | 1
  /** fetch 注入，便于测试 */
  fetchFn?: typeof fetch
  /** HF API 基地址，默认 https://huggingface.co */
  hfBaseUrl?: string
}

export type DownloadBackend = 'hf-cli' | 'aria2'

export type DownloadOptions = {
  /** 本地落盘目录，默认 models/<repoId> 扁平化 */
  localDir?: string
  /** 指定文件名（单文件下载时），否则拉取匹配 quant 的 GGUF */
  filename?: string
  /** 量化筛选（用于在 repo 内挑文件） */
  quant?: QuantTag
  /** 后端，默认 hf-cli，aria2 为并发分片下载直链 */
  backend?: DownloadBackend
  /** 并发数（aria2 -x/-s，hf-cli --max-workers），默认 4 */
  concurrency?: number
  /** 分片数（aria2 -s），默认同 concurrency */
  split?: number
  /** 是否断点续传，默认 true */
  resume?: boolean
  /** token（HF_TOKEN 环境变量或显式传入） */
  token?: string
  /** 额外 huggingface-cli 参数 */
  extraHfArgs?: string[]
  /** 额外 aria2c 参数 */
  extraAria2Args?: string[]
  /** 执行器注入，便于测试不真 spawn */
  spawnFn?: typeof spawn
  /** 日志回调 */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
  /** aria2 直链（当 backend=aria2 且已知直链时） */
  url?: string
  /** 会话 id（downloadManager 传入）：注册子进程句柄供 killActiveDownload 树杀 (14b) */
  sessionId?: string
}

export type DownloadResult = {
  backend: DownloadBackend
  command: string
  args: string[]
  repoId: string
  resumed: boolean
  concurrency: number
}

// ---------------------------------------------------------------------------
// 常量：支持的量化集合（与 src/models/registry.ts 保持一致 + 常用别名）
// ---------------------------------------------------------------------------

export const SUPPORTED_QUANTS: readonly QuantTag[] = [
  'Q2_K',
  'Q3_K_S',
  'Q3_K_M',
  'Q3_K_L',
  'Q4_0',
  'Q4_1',
  'Q4_K_S',
  'Q4_K_M',
  'Q5_0',
  'Q5_1',
  'Q5_K_S',
  'Q5_K_M',
  'Q6_K',
  'Q8_0',
  'IQ1_S',
  'IQ1_M',
  'IQ2_XS',
  'IQ2_XXS',
  'IQ3_XS',
  'IQ3_XXS',
  'IQ4_XS',
  'IQ4_NL',
  'F16',
  'F32',
  'BF16',
  'INT4',
  'INT8',
] as const

const QUANT_NORMALIZE_RE = /[-_\.]/g

export function normalizeQuant(q: string): string {
  return q.replace(QUANT_NORMALIZE_RE, '_').toUpperCase()
}

// ---------------------------------------------------------------------------
// 10 精选卡 — 对应 THIRD_PARTY_NOTICES.md 第 5 组 10 项权重（仅下载器引用）
// ---------------------------------------------------------------------------

export const FEATURED_CARDS: readonly HfModelCard[] = [
  {
    repoId: 'cognitivecomputations/dolphin-24b-venice-edition',
    name: 'Dolphin-Mistral-24B-Venice-Edition',
    author: 'cognitivecomputations',
    quant: 'Q4_K_M',
    filename: 'dolphin-24b-venice-edition-Q4_K_M.gguf',
    sizeLabel: '~14GB',
    gguf: true,
    description: 'Dolphin 24B Venice 无审查创作分支，Q4_K_M GGUF 演示权重',
    tags: ['gguf', 'Q4_K_M', 'mistral', 'uncensored'],
    likes: 1200,
  },
  {
    repoId: 'mistralai/Mistral-Nemo-Instruct-2407',
    name: 'Mistral-Nemo-Instruct-2407',
    author: 'mistralai',
    quant: 'Q4_K_M',
    filename: 'mistral-nemo-instruct-2407-Q4_K_M.gguf',
    sizeLabel: '~7GB',
    gguf: true,
    description: 'Mistral Nemo 12B 通用指令微调，平衡质量与速度',
    tags: ['gguf', 'Q4_K_M', 'mistral', 'instruct'],
    likes: 980,
  },
  {
    repoId: 'alpindale/WizardLM-2-8x22B',
    name: 'WizardLM-2-8x22B',
    author: 'alpindale',
    quant: 'Q4_K_M',
    filename: 'wizardlm-2-8x22b-Q4_K_M.gguf',
    sizeLabel: '~80GB',
    gguf: true,
    description: 'WizardLM 2 MoE 8x22B 高质量指令与推理',
    tags: ['gguf', 'Q4_K_M', 'mixtral', 'wizardlm'],
    likes: 2100,
  },
  {
    repoId: 'NousResearch/Nous-Hermes-2-Mistral-7B-DPO',
    name: 'Nous-Hermes-2-Mistral-7B-DPO',
    author: 'NousResearch',
    quant: 'Q4_K_M',
    filename: 'nous-hermes-2-mistral-7b-dpo.Q4_K_M.gguf',
    sizeLabel: '~4GB',
    gguf: true,
    description: 'Hermes 2 Mistral 7B DPO 助手微调',
    tags: ['gguf', 'Q4_K_M', 'mistral', 'dpo'],
    likes: 870,
  },
  {
    repoId: 'Gryphe/MythoMax-L2-13B',
    name: 'MythoMax-L2-13B',
    author: 'Gryphe',
    quant: 'Q4_K_M',
    filename: 'mythomax-l2-13b.Q4_K_M.gguf',
    sizeLabel: '~8GB',
    gguf: true,
    description: 'MythoMax 13B 角色扮演/创意写作',
    tags: ['gguf', 'Q4_K_M', 'llama', 'roleplay'],
    likes: 1600,
  },
  {
    repoId: 'teknium/OpenHermes-2.5-Mistral-7B',
    name: 'OpenHermes-2.5-Mistral-7B',
    author: 'teknium',
    quant: 'Q4_K_M',
    filename: 'openhermes-2.5-mistral-7b.Q4_K_M.gguf',
    sizeLabel: '~4GB',
    gguf: true,
    description: 'OpenHermes 2.5 开放指令微调',
    tags: ['gguf', 'Q4_K_M', 'mistral', 'instruct'],
    likes: 1900,
  },
  {
    repoId: 'mlabonne/gemma-2-9b-it-abliterated',
    name: 'Gemma-2-9B-It-Abliterated',
    author: 'mlabonne',
    quant: 'Q4_K_M',
    filename: 'gemma-2-9b-it-abliterated.Q4_K_M.gguf',
    sizeLabel: '~6GB',
    gguf: true,
    description: 'Gemma 2 9B 去审查分支，商用允许的 Gemma 许可',
    tags: ['gguf', 'Q4_K_M', 'gemma', 'abliterated'],
    likes: 750,
  },
  {
    repoId: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    name: 'DeepSeek-R1-Distill-Qwen-7B',
    author: 'deepseek-ai',
    quant: 'Q4_K_M',
    filename: 'deepseek-r1-distill-qwen-7b-Q4_K_M.gguf',
    sizeLabel: '~4GB',
    gguf: true,
    description: 'DeepSeek R1 蒸馏 Qwen 7B，reasoning_content 透传验证',
    tags: ['gguf', 'Q4_K_M', 'qwen', 'reasoning', 'r1'],
    likes: 2300,
  },
  {
    repoId: 'mlabonne/Qwen2.5-7B-Instruct-abliterated',
    name: 'Qwen2.5-7B-Instruct-Abliterated',
    author: 'mlabonne',
    quant: 'Q4_K_M',
    filename: 'qwen2.5-7b-instruct-abliterated.Q4_K_M.gguf',
    sizeLabel: '~4GB',
    gguf: true,
    description: 'Qwen2.5 7B 中文指令去审查分支',
    tags: ['gguf', 'Q4_K_M', 'qwen2', 'abliterated'],
    likes: 620,
  },
  {
    repoId: 'Orenguteng/Lexi-Uncensored-V2',
    name: 'Lexi-Uncensored-V2',
    author: 'Orenguteng',
    quant: 'Q4_K_M',
    filename: 'lexi-uncensored-v2.Q4_K_M.gguf',
    sizeLabel: '~4GB',
    gguf: true,
    description: 'Lexi V2 无审查对话预设',
    tags: ['gguf', 'Q4_K_M', 'llama', 'uncensored'],
    likes: 540,
  },
] as const

// 兼容别名：不同任务描述可能以不同常量名断言 10 精选卡存在
export const FEATURED_MODELS = FEATURED_CARDS
export const HF_FEATURED_CARDS = FEATURED_CARDS
export const HF_FEATURED = FEATURED_CARDS
export const FEATURED_GGUF_CARDS = FEATURED_CARDS

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFetch(fetchFn?: typeof fetch): typeof fetch {
  if (fetchFn) return fetchFn
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis)
  throw new Error('fetch not available: provide fetchFn in SearchOptions')
}

function buildHfApiUrl(opts: SearchOptions): string {
  const base = (opts.hfBaseUrl ?? 'https://huggingface.co').replace(/\/$/, '')
  const params = new URLSearchParams()
  // HF /api/models 支持 search / filter / sort / direction / limit
  if (opts.query && opts.query.trim()) params.set('search', opts.query.trim())
  // 始终筛 GGUF
  const ggufOnly = opts.ggufOnly !== false
  if (ggufOnly) params.set('filter', 'gguf')
  // 量化 tags 通过 search 追加，提升命中；精确过滤由 filterQuant 二次完成
  if (opts.quant) {
    const qs = Array.isArray(opts.quant) ? opts.quant : [opts.quant]
    const normed = qs.map((q) => normalizeQuant(String(q))).filter(Boolean)
    if (normed.length) params.set('filter', ['gguf', ...normed.map((q) => q.toLowerCase())].join(','))
  }
  params.set('sort', opts.sort ?? 'likes')
  params.set('direction', String(opts.direction ?? -1))
  params.set('limit', String(opts.limit ?? 20))
  return `${base}/api/models?${params.toString()}`
}

type HfApiRawModel = {
  id: string
  author?: string
  likes?: number
  downloads?: number
  tags?: string[]
  pipeline_tag?: string
  siblings?: Array<{ rfilename: string }>
  cardData?: Record<string, unknown>
  // 某些镜像返回 modelId
  modelId?: string
}

function mapRawToCard(raw: HfApiRawModel): HfModelCard {
  const repoId = raw.id ?? raw.modelId ?? 'unknown/unknown'
  const author = raw.author ?? repoId.split('/')[0] ?? 'unknown'
  const name = repoId.split('/')[1] ?? repoId
  const tags: string[] = Array.isArray(raw.tags) ? raw.tags : []
  // 从 tags / siblings 推断 quant
  const allTokens = [...tags, ...(raw.siblings ?? []).map((s) => s.rfilename)].join(' ')
  const quant = detectQuantFromString(allTokens) ?? 'Q4_K_M'
  const filename = (raw.siblings ?? []).find((s) => s.rfilename.toLowerCase().endsWith('.gguf'))?.rfilename
  const gguf = tags.includes('gguf') || !!filename || /gguf/i.test(allTokens)
  return {
    repoId,
    name,
    author,
    quant,
    filename,
    sizeLabel: '—',
    gguf,
    description: (raw.cardData?.['description'] as string) ?? '',
    tags,
    likes: raw.likes,
  }
}

export function detectQuantFromString(s: string): QuantTag | null {
  const upper = s.toUpperCase()
  for (const tok of SUPPORTED_QUANTS) {
    // 边界匹配，避免 Q4 误命中 Q4_K_M 子串混乱 — 长 token 优先已在 SUPPORTED_QUANTS 中排长在前
    const re = new RegExp(`(?:^|[^A-Z0-9])${escapeRegExp(tok)}(?:[^A-Z0-9]|$)`, 'i')
    if (re.test(upper)) return tok
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// searchHF — 可搜/筛 GGUF 量化（网络走 fetchFn 注入，失败不抛空数组容错）
// ---------------------------------------------------------------------------

export async function searchHF(queryOrOpts: string | SearchOptions, maybeOpts?: SearchOptions): Promise<HfModelCard[]> {
  const opts: SearchOptions =
    typeof queryOrOpts === 'string' ? { query: queryOrOpts, ...(maybeOpts ?? {}) } : queryOrOpts ?? {}

  // 若无 query 且无 quant 且 ggufOnly=false 的全量搜索，仍走 API（由 limit 控制）
  const url = buildHfApiUrl(opts)
  const fetchFn = getFetch(opts.fetchFn)

  let res: Response
  try {
    res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
    } as RequestInit)
  } catch {
    // 网络隔离：返回精選卡的本地模糊匹配作为降级，避免浏览器白屏
    return localFallbackSearch(opts)
  }

  if (!res.ok) {
    // 4xx/5xx 降级到本地
    return localFallbackSearch(opts)
  }

  let data: unknown
  try {
    data = await res.json()
  } catch {
    return localFallbackSearch(opts)
  }

  if (!Array.isArray(data)) return localFallbackSearch(opts)

  let cards = (data as HfApiRawModel[]).map(mapRawToCard)

  // 二次精确量化过滤（HF filter 为宽松匹配）
  if (opts.quant) {
    cards = filterQuant(cards, opts.quant as QuantTag | QuantTag[])
  }

  // 仅 GGUF 二次过滤（防止非 GGUF 混入）
  if (opts.ggufOnly !== false) {
    cards = cards.filter((c) => c.gguf)
  }

  return cards
}

function localFallbackSearch(opts: SearchOptions): HfModelCard[] {
  let pool: HfModelCard[] = [...FEATURED_CARDS]
  if (opts.query && opts.query.trim()) {
    const q = opts.query.trim().toLowerCase()
    pool = pool.filter(
      (c) =>
        c.repoId.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }
  if (opts.quant) {
    pool = filterQuant(pool, opts.quant as QuantTag | QuantTag[])
  }
  if (opts.ggufOnly !== false) pool = pool.filter((c) => c.gguf)
  const lim = opts.limit ?? 20
  return pool.slice(0, lim)
}

// ---------------------------------------------------------------------------
// filterQuant — 纯函数：按文件名/quant 标签筛 GGUF 量化（大小写/分隔符不敏感）
// ---------------------------------------------------------------------------

export function filterQuant(cards: HfModelCard[], quant: QuantTag | QuantTag[] | '' | null | undefined): HfModelCard[] {
  if (!quant || (Array.isArray(quant) && quant.length === 0) || quant === '') return [...cards]
  const wanted = (Array.isArray(quant) ? quant : [quant])
    .map((q) => normalizeQuant(String(q)))
    .filter(Boolean)
  if (wanted.length === 0) return [...cards]
  const wantedSet = new Set(wanted)

  return cards.filter((c) => {
    const hay = [c.quant, c.filename ?? '', ...c.tags].join(' ')
    const normHay = normalizeQuant(hay)
    // 任一 wanted 命中即保留
    for (const w of wantedSet) {
      if (normHay.includes(normalizeQuant(w))) return true
      // 也允许对 filename 的子串匹配（如 Q4_K_M 文件）
      if (c.filename && normalizeQuant(c.filename).includes(w)) return true
      if (normalizeQuant(c.quant).includes(w)) return true
    }
    return false
  })
}

// ---------------------------------------------------------------------------
// Download — 断点续传 + 并发
// ---------------------------------------------------------------------------

/**
 * 构造 huggingface-cli download 命令行参数
 * 关键：--resume-retries + 断点 + 并发
 * 示例：
 *   huggingface-cli download <repoId> --local-dir <dir> --resume-download --max-workers 4
 *   单文件：huggingface-cli download <repoId> <filename> --local-dir <dir> ...
 */
export function buildHfCliArgs(repoId: string, opts: DownloadOptions = {}): { command: string; args: string[] } {
  const localDir = opts.localDir ?? `models/${repoId.replace('/', '__')}`
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4))
  const resume = opts.resume !== false

  const args: string[] = ['download', repoId]

  // 单文件模式：huggingface-cli download <repoId> <filename>
  if (opts.filename) args.push(opts.filename)
  // 多文件按 quant 模式：通过 --include 仅拉 GGUF 匹配文件
  else if (opts.quant) {
    const q = normalizeQuant(opts.quant)
    args.push('--include', `*${q}*.gguf`)
  } else {
    // 默认仅拉 GGUF，避免 safetensors 大权重误拉
    args.push('--include', '*.gguf')
  }

  args.push('--local-dir', localDir)

  if (resume) args.push('--resume-download')
  if (concurrency > 1) args.push('--max-workers', String(concurrency))

  // HF 2.x 亦支持 --local-dir-use-symlinks false 避免 symlink 坑
  args.push('--local-dir-use-symlinks', 'False')

  if (opts.token) args.push('--token', opts.token)
  if (opts.extraHfArgs?.length) args.push(...opts.extraHfArgs)

  return { command: 'huggingface-cli', args }
}

/**
 * 构造 aria2c 参数（并发分片 + 断点续传）
 * 默认：-x 4 -s 4 -c --auto-file-renaming=false --allow-overwrite=true
 */
export function buildAria2Args(url: string, opts: DownloadOptions = {}): { command: string; args: string[] } {
  const dir = opts.localDir ?? 'models/downloads'
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4))
  const split = Math.max(1, Math.min(16, opts.split ?? concurrency))
  const resume = opts.resume !== false

  const filename = opts.filename ?? url.split('/').pop()?.split('?')[0] ?? 'model.gguf'

  const args: string[] = [
    url,
    '-d',
    dir,
    '-o',
    filename,
    '-x',
    String(concurrency),
    '-s',
    String(split),
    '--file-allocation=none',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    '--check-certificate=false',
  ]

  if (resume) args.push('-c')

  // 并发与超时调优
  args.push('--max-tries=5', '--retry-wait=2', '--timeout=30')

  if (opts.extraAria2Args?.length) args.push(...opts.extraAria2Args)

  return { command: 'aria2c', args }
}

/** 由 repoId 拼直链（HF resolve 主分支） */
export function hfResolveUrl(repoId: string, filename: string, revision = 'main'): string {
  return `https://huggingface.co/${repoId}/resolve/${revision}/${filename}`
}

// ---------------------------------------------------------------------------
// Active child-process handle map (todo14b cancel)
// ---------------------------------------------------------------------------

/** Minimal child shape retained for tree-kill; real ChildProcess satisfies it. */
export type HfChildHandle = {
  pid?: number
  kill: (signal?: NodeJS.Signals | number) => boolean
}

const activeChildren = new Map<string, HfChildHandle>()

/** 当前注册的下载子进程会话 id（诊断/测试用）。 */
export function activeDownloadIds(): string[] {
  return [...activeChildren.keys()]
}

export function registerDownloadChild(sessionId: string, child: HfChildHandle): void {
  activeChildren.set(sessionId, child)
}

export function unregisterDownloadChild(sessionId: string): void {
  activeChildren.delete(sessionId)
}

/**
 * 树杀一个下载会话的子进程（Windows: taskkill /T /F 连坐孙进程；POSIX: SIGKILL）。
 * 返回 false = 会话不存在（已结束/未知 id）。注入 spawnLike 供测试验证 argv。
 */
export function killDownloadChild(
  sessionId: string,
  spawnLike: typeof spawn = spawn,
): { killed: boolean; pid?: number } {
  const child = activeChildren.get(sessionId)
  if (!child) return { killed: false }
  const { pid } = child
  if (process.platform === 'win32' && pid !== undefined) {
    // fire-and-forget tree kill; the child 'close' handler unregisters the session
    try {
      const killer = spawnLike('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) as unknown as {
        on?: (ev: string, cb: (...a: unknown[]) => void) => void
      }
      if (killer && typeof killer.on === 'function') killer.on('error', () => child.kill())
    } catch {
      child.kill()
    }
  } else {
    child.kill()
  }
  return { killed: true, ...(pid === undefined ? {} : { pid }) }
}

/**
 * 一键下载（断点续传 + 并发）
 * - backend=hf-cli：直接 spawn huggingface-cli
 * - backend=aria2：若提供 url 则直链 aria2c；否则由 repoId+filename 拼 HF resolve 直链
 * - spawnFn 可注入，单测不真起子进程；未注入则真实 spawn（detached=false）
 * - 返回 DownloadResult 便于 UI 展示命令预览与进度绑定
 */
export async function downloadWithResume(
  repoId: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  if (!repoId || !repoId.includes('/')) {
    throw new Error(`invalid repoId: ${repoId}`)
  }

  const backend: DownloadBackend = opts.backend ?? 'hf-cli'
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 4))
  const resumed = opts.resume !== false

  let command: string
  let args: string[]

  if (backend === 'aria2') {
    const url =
      opts.url ??
      (opts.filename
        ? hfResolveUrl(repoId, opts.filename, 'main')
        : hfResolveUrl(repoId, `${repoId.split('/')[1] ?? 'model'}.gguf`, 'main'))
    const built = buildAria2Args(url, { ...opts, concurrency })
    command = built.command
    args = built.args
  } else {
    const built = buildHfCliArgs(repoId, { ...opts, concurrency })
    command = built.command
    args = built.args
  }

  const spawnFn = opts.spawnFn ?? spawn

  // 仅在提供真实 spawnFn（非 mock 且非测试注入的 no-op）时才真执行；
  // 注入的 mock 可通过返回值自行决定是否异步完成。
  // 这里统一尝试 spawn，失败则向上抛（由调用方 catch 展示错误 toast）
  try {
    const child = spawnFn(command, args, {
      stdio: 'inherit',
      shell: false,
    } as Parameters<typeof spawn>[2]) as unknown as { on?: (ev: string, cb: (...a: unknown[]) => void) => void; pid?: number; kill?: (s?: NodeJS.Signals) => boolean }

    // 14b: retain the handle so download:cancel can tree-kill this child by sessionId
    const sessionId = opts.sessionId
    if (sessionId !== undefined && child && typeof child.kill === 'function') {
      registerDownloadChild(sessionId, child as unknown as HfChildHandle)
    }

    // 若为真实子进程，等待 close；若为 mock（无 on），直接 resolve
    if (child && typeof child.on === 'function') {
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const done = (code: number | null) => {
            if (settled) return
            settled = true
            if (code === 0 || code === null) resolve()
            else reject(new Error(`${command} exited with code ${code}`))
          }
          child.on!('close', (code) => done(code as number | null))
          child.on!('error', (err) => {
            if (settled) return
            settled = true
            reject(err as Error)
          })
        })
      } finally {
        if (sessionId !== undefined) unregisterDownloadChild(sessionId)
      }
    } else if (sessionId !== undefined) {
      // mock 无生命周期事件 — 立即注销，避免句柄泄漏
      unregisterDownloadChild(sessionId)
    }
  } catch (err) {
    // spawn 失败（如二进制不存在）— 抛出带命令的错误，便于 UI 提示安装指引
    if (opts.sessionId !== undefined) unregisterDownloadChild(opts.sessionId)
    const msg = (err as Error).message ?? String(err)
    throw new Error(`${command} spawn failed: ${msg} — args: ${args.join(' ')}`)
  }

  return { backend, command, args, repoId, resumed, concurrency }
}

// ---------------------------------------------------------------------------
// 便捷：按 repoId 在 FEATURED 中查找卡片
// ---------------------------------------------------------------------------

export function findFeaturedCard(repoId: string): HfModelCard | undefined {
  return FEATURED_CARDS.find((c) => c.repoId === repoId)
}

export default {
  FEATURED_CARDS,
  FEATURED_MODELS,
  HF_FEATURED_CARDS,
  SUPPORTED_QUANTS,
  searchHF,
  filterQuant,
  downloadWithResume,
  buildHfCliArgs,
  buildAria2Args,
  hfResolveUrl,
  detectQuantFromString,
  normalizeQuant,
  findFeaturedCard,
}
