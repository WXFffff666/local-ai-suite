/**
 * promptLibrary（阶段2）— prompt-weaver 提示词库的共享加载层。
 *
 * 数据源：src/shared/prompt-data/**（织词全量数据，仓库已转私有）：
 *   - zh2en.json        12k 中文→danbooru tag 映射（AI 润色的查表兜底）
 *   - tags/*.json       按维度分类的标签（主体/服装/构图/光影/质量/负面…）
 *   - presets/*.json    场景预设（sfw + h 两册，一键整段填充）
 *   - characters.json   1393 个角色的中文/英文名 + 特征标签
 *   - media-zh.json     305 个作品/媒介的中文映射
 *
 * 全部 dynamic import：16MB 数据按需分包加载，不进首屏 bundle；
 * 主进程（enhance 查表）与渲染层（PromptPicker）共用同一模块。
 *
 * MIT, 无 AGPL.
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type TagItem = {
  zh: string
  en: string
  sfw?: boolean
  weight?: number
}

export type PresetItem = {
  id: string
  name: string
  desc: string
  category: string
  tags: string[]
  prompt: string
}

export type CharacterItem = {
  id: number
  enName: string
  zhName?: string
  media?: string
  gender?: string
  popularityRank?: number
  features?: Array<{ tag: string; zh?: string; dimension?: string; confidence?: string }>
}

export type PromptCategory = {
  id: string
  label: string
}

/** 标签分类（Picker 顶栏 tab；nsfw 目录单独一档由开关控制） */
export const TAG_CATEGORIES: readonly PromptCategory[] = [
  { id: 'quality', label: '画质' },
  { id: 'subject', label: '主体' },
  { id: 'appearance', label: '外观' },
  { id: 'clothing', label: '服装' },
  { id: 'expression', label: '表情' },
  { id: 'action', label: '动作' },
  { id: 'pose', label: '姿势' },
  { id: 'composition', label: '构图' },
  { id: 'environment', label: '环境' },
  { id: 'lighting', label: '光影' },
  { id: 'style', label: '画风' },
  { id: 'material', label: '材质' },
  { id: 'food', label: '食物' },
  { id: 'negative', label: '负面' },
  { id: 'nsfw', label: '限制级' },
]

// ---------------------------------------------------------------------------
// 惰性加载 + 缓存
// ---------------------------------------------------------------------------

type Zh2enEntry = { en: string[]; priority: number }
let zh2enCache: Record<string, Zh2enEntry> | null = null
const tagCache = new Map<string, TagItem[]>()
let sfwPresetsCache: PresetItem[] | null = null
let hPresetsCache: PresetItem[] | null = null
let charactersCache: CharacterItem[] | null = null

/** zh2en.json → { 中文: { en: [tags], priority } } */
export async function loadZh2en(): Promise<Record<string, Zh2enEntry>> {
  if (zh2enCache === null) {
    const mod = await import('./prompt-data/zh2en.json')
    zh2enCache = mod.default as Record<string, Zh2enEntry>
  }
  return zh2enCache
}

/**
 * 查表直译：中文短语 → 英文 tag 串（", " 连接）。整句未命中时由调用方
 * 自行分词重试（enhance.ts 已做）。未命中返回 undefined。
 */
export async function lookupZh(zh: string): Promise<string | undefined> {
  const table = await loadZh2en()
  const hit = table[zh.trim()]
  if (hit === undefined || hit.en.length === 0) return undefined
  return hit.en.join(', ')
}

/** 某一维度标签（'nsfw' 聚合 tags/nsfw/ 全部子册） */
export async function loadTagCategory(id: string): Promise<TagItem[]> {
  const cached = tagCache.get(id)
  if (cached !== undefined) return cached
  let items: TagItem[]
  if (id === 'nsfw') {
    const files = ['nsfw_base', 'nsfw_action', 'nsfw_clothing', 'nsfw_environment', 'nsfw_fantasy', 'nsfw_interaction', 'nsfw_pose', 'nsfw_reaction', 'nsfw_restraint'] as const
    const mods = await Promise.all(files.map((f) => import(`./prompt-data/tags/nsfw/${f}.json`)))
    items = mods.flatMap((m) => m.default as TagItem[]).filter((t) => typeof t.zh === 'string' && typeof t.en === 'string')
  } else {
    const mod = await import(`./prompt-data/tags/${id}.json`)
    items = (mod.default as TagItem[]).filter((t) => typeof t.zh === 'string' && typeof t.en === 'string')
  }
  tagCache.set(id, items)
  return items
}

/** 场景预设：includeNsfw=false 只给 SFW 册 */
export async function loadPresets(includeNsfw: boolean): Promise<PresetItem[]> {
  if (sfwPresetsCache === null) {
    const mod = await import('./prompt-data/presets/sfw-presets.json')
    sfwPresetsCache = mod.default as PresetItem[]
  }
  if (includeNsfw && hPresetsCache === null) {
    const mod = await import('./prompt-data/presets/h-presets.json')
    hPresetsCache = mod.default as PresetItem[]
  }
  return includeNsfw ? [...(sfwPresetsCache ?? []), ...(hPresetsCache ?? [])] : (sfwPresetsCache ?? [])
}

/** 角色库（中文名/作品/特征标签） */
export async function loadCharacters(): Promise<CharacterItem[]> {
  if (charactersCache === null) {
    const mod = await import('./prompt-data/characters.json')
    const raw = mod.default as { characters?: CharacterItem[] }
    charactersCache = raw.characters ?? []
  }
  return charactersCache
}

// ---------------------------------------------------------------------------
// 检索
// ---------------------------------------------------------------------------

/** 简单子串检索：中文/英文不区分大小写，按权重降序，取前 limit 条 */
export function searchTags(items: readonly TagItem[], query: string, limit = 60): TagItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items.slice(0, limit)
  const scored: Array<{ t: TagItem; s: number }> = []
  for (const t of items) {
    const zh = t.zh.toLowerCase()
    const en = t.en.toLowerCase()
    let s = -1
    if (zh === q || en === q) s = 3
    else if (zh.startsWith(q) || en.startsWith(q)) s = 2
    else if (zh.includes(q) || en.includes(q)) s = 1
    if (s >= 0) scored.push({ t, s: s + (t.weight ?? 0) * 0.01 })
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.t)
}

/** 角色检索：中文名/英文名/作品名 */
export function searchCharacters(items: readonly CharacterItem[], query: string, limit = 60): CharacterItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items.slice(0, limit)
  const hits: CharacterItem[] = []
  for (const c of items) {
    const hay = `${c.zhName ?? ''} ${c.enName} ${c.media ?? ''}`.toLowerCase()
    if (hay.includes(q)) hits.push(c)
    if (hits.length >= limit) break
  }
  return hits
}

/** 预设检索：名称/描述/标签 */
export function searchPresets(items: readonly PresetItem[], query: string, limit = 60): PresetItem[] {
  const q = query.trim().toLowerCase()
  if (q === '') return items.slice(0, limit)
  const hits: PresetItem[] = []
  for (const p of items) {
    const hay = `${p.name} ${p.desc} ${p.tags.join(' ')}`.toLowerCase()
    if (hay.includes(q)) hits.push(p)
    if (hits.length >= limit) break
  }
  return hits
}

/** 角色特征 → danbooru 串（点击角色时插入） */
export function characterToPrompt(c: CharacterItem): string {
  const base = c.enName
  const feats = (c.features ?? [])
    .map((f) => f.tag)
    .filter((t): t is string => typeof t === 'string' && t !== '')
  return feats.length > 0 ? `${base}, ${feats.join(', ')}` : base
}
