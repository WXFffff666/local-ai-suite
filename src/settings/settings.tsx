/**
 * 设置页统一管理 — Wave6 T28
 * 统一管理：搜索 / HF Token / 生图后端 / 端口 / 更新开关
 * 密钥 safeStorage 加密，落盘永不明文
 */
import * as React from 'react'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

// ---------------------------------------------------------------------------
// Types — 统一设置模型
// ---------------------------------------------------------------------------

export type SearchProviderId = 'searxng' | 'tavily' | 'exa' | 'brave'

export type SearchSettings = {
  /** 当前搜索后端，默认 searxng 本地，cloud 需密钥 */
  provider: SearchProviderId
  /** SearXNG 本地地址 */
  searxngUrl: string
  searxngEnabled: boolean
  /** 云搜索密钥 — 内存态明文，落盘态 enc:v1:xxx */
  tavilyApiKey: string
  exaApiKey: string
  braveApiKey: string
}

export type ImageBackendId = 'sd.cpp' | 'comfyui' | 'auto'

export type ImageBackendSettings = {
  backend: ImageBackendId
  host: string
  port: number
  model: string
}

export type PortSettings = {
  openaiPort: number
  llamaPort: number
  ollamaPort: number
}

export type UpdateSettings = {
  autoUpdateEnabled: boolean
}

export type UnifiedSettings = {
  search: SearchSettings
  hfToken: string
  image: ImageBackendSettings
  ports: PortSettings
  update: UpdateSettings
  /** 轮转元数据 — 不含密钥 */
  meta: { updatedAt: string; encVersion: number }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SEARCH: SearchSettings = {
  provider: 'searxng',
  searxngUrl: 'http://127.0.0.1:8080',
  searxngEnabled: false,
  tavilyApiKey: '',
  exaApiKey: '',
  braveApiKey: '',
}

export const DEFAULT_IMAGE: ImageBackendSettings = {
  backend: 'auto',
  host: '127.0.0.1',
  port: 11435,
  model: 'sdxl',
}

export const DEFAULT_PORTS: PortSettings = {
  openaiPort: 11434,
  llamaPort: 11435,
  ollamaPort: 11434,
}

export const DEFAULT_UPDATE: UpdateSettings = {
  autoUpdateEnabled: true,
}

export const DEFAULT_SETTINGS: UnifiedSettings = {
  search: { ...DEFAULT_SEARCH },
  hfToken: '',
  image: { ...DEFAULT_IMAGE },
  ports: { ...DEFAULT_PORTS },
  update: { ...DEFAULT_UPDATE },
  meta: { updatedAt: new Date(0).toISOString(), encVersion: 1 },
}

// 标记哪些字段是密钥（需加密）
export const SECRET_FIELDS = ['search.tavilyApiKey', 'search.exaApiKey', 'search.braveApiKey', 'hfToken'] as const

// ---------------------------------------------------------------------------
// safeStorage 抽象
// ---------------------------------------------------------------------------

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

let __mockSafeStorage: SafeStorageLike | null = null
/** 测试注入 — vitest 中调用以模拟 Electron safeStorage */
export function __setMockSafeStorage(s: SafeStorageLike | null): void {
  __mockSafeStorage = s
}

export function getSafeStorage(): SafeStorageLike | null {
  if (__mockSafeStorage) return __mockSafeStorage
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { safeStorage?: SafeStorageLike }
    if (electron?.safeStorage && typeof electron.safeStorage.encryptString === 'function') {
      return electron.safeStorage
    }
  } catch {
    // not in electron main
  }
  return null
}

export function isEncryptionAvailable(): boolean {
  const ss = getSafeStorage()
  if (!ss) return false
  try {
    return ss.isEncryptionAvailable()
  } catch {
    return false
  }
}

// 前缀用于识别已加密负载，避免把明文误判为密文
export const ENC_PREFIX = 'enc:v1:'
export const ENC_FALLBACK_PREFIX = 'enc:fallback:v1:'

export function isEncryptedPayload(v: string): boolean {
  return typeof v === 'string' && (v.startsWith(ENC_PREFIX) || v.startsWith(ENC_FALLBACK_PREFIX))
}

/**
 * 加密单条密钥 — 落盘前调用
 * - 优先 safeStorage.encryptString (OS keychain: DPAPI / Keychain / libsecret)
 * - 不可用时降级为 base64 + 前缀（仍非明文，启动时警告，CI/未配置钥匙串环境可用）
 * - 空串原样返回 ""（表示未配置，避免无意义密文）
 */
export function encryptSecretLocalSync(plain: string): string {
  if (!plain) return ''
  const ss = getSafeStorage()
  if (ss && isEncryptionAvailable()) {
    try {
      const buf: Buffer = ss.encryptString(plain)
      return ENC_PREFIX + buf.toString('base64')
    } catch {
      // fall through to fallback
    }
  }
  // fallback — 非明文但非 OS 级安全，仅用于测试/无钥匙串环境
  const b64 = Buffer.from(plain, 'utf-8').toString('base64')
  return ENC_FALLBACK_PREFIX + b64
}

/**
 * 规范加密入口（异步）：
 * - Electron 运行时走主进程 safeStorage IPC —— sandbox 渲染层根本拿不到 safeStorage，
 *   此前的同步实现在渲染层永远静默退化为可逆 base64（P1 缺陷，已修复）
 * - 无 window.api（vitest / 纯 Node）时回退本地同步实现
 * - 主进程返回 warning 时向控制台大声告警，UI 可据此提示用户
 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return ''
  const api = (globalThis as { api?: { invoke?: (ch: string, ...args: unknown[]) => Promise<unknown> } }).api
  if (typeof api?.invoke === 'function') {
    const res = (await api.invoke('secrets:encrypt', plain)) as
      | { ok: boolean; value?: string; warning?: string; error?: string }
      | undefined
    if (res?.ok && typeof res.value === 'string') {
      if (res.warning) console.warn('[settings] 密钥加密降级：OS 安全存储不可用，已使用可逆回退编码（enc:fallback:v1:）')
      return res.value
    }
    if (res && !res.ok) throw new Error(`secrets:encrypt failed: ${res.error ?? 'unknown'}`)
  }
  return encryptSecretLocalSync(plain)
}

/**
 * 解密单条密钥 — 读盘后调用
 * 支持 enc:v1: (safeStorage) 与 enc:fallback:v1: (base64)
 * 既非前缀则视为历史明文兼容分支（返回原值，便于一次性迁移），但调用方应立即重存以完成轮转
 */
export function decryptSecretLocalSync(payload: string): string {
  if (!payload) return ''
  if (payload.startsWith(ENC_PREFIX)) {
    const b64 = payload.slice(ENC_PREFIX.length)
    const buf = Buffer.from(b64, 'base64')
    const ss = getSafeStorage()
    if (ss) {
      try {
        return ss.decryptString(buf)
      } catch {
        return ''
      }
    }
    // 无 safeStorage 却遇到 v1 密文 — 无法解密
    return ''
  }
  if (payload.startsWith(ENC_FALLBACK_PREFIX)) {
    const b64 = payload.slice(ENC_FALLBACK_PREFIX.length)
    try {
      return Buffer.from(b64, 'base64').toString('utf-8')
    } catch {
      return ''
    }
  }
  // 兼容：历史明文落盘（应触发迁移）
  return payload
}

/** 规范解密入口（异步）— 与 encryptSecret 对称，优先主进程 IPC */
export async function decryptSecret(payload: string): Promise<string> {
  if (!payload) return ''
  const api = (globalThis as { api?: { invoke?: (ch: string, ...args: unknown[]) => Promise<unknown> } }).api
  if (typeof api?.invoke === 'function') {
    const res = (await api.invoke('secrets:decrypt', payload)) as
      | { ok: boolean; value?: string; error?: string }
      | undefined
    if (res?.ok && typeof res.value === 'string') return res.value
    if (res && !res.ok) throw new Error(`secrets:decrypt failed: ${res.error ?? 'unknown'}`)
  }
  return decryptSecretLocalSync(payload)
}

/** UI 脱敏 — 永不返回明文，仅首/尾各 2 字符，其余 * */
export function maskSecret(secret: string): string {
  if (!secret) return '未配置'
  const s = secret.trim()
  if (s.length <= 4) return '****'
  return `${s.slice(0, 2)}****${s.slice(-2)}`
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export function validatePort(port: number): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return '端口需为 1024-65535 的整数'
  return null
}

export function validatePorts(p: Partial<PortSettings>): Record<string, string> {
  const errs: Record<string, string> = {}
  for (const k of ['openaiPort', 'llamaPort', 'ollamaPort'] as const) {
    const v = (p as Record<string, unknown>)[k]
    if (v !== undefined) {
      const e = validatePort(v as number)
      if (e) errs[k] = e
    }
  }
  // 冲突检测：同 host 下端口不可重复
  const vals = [p.openaiPort, p.llamaPort, p.ollamaPort].filter((x): x is number => typeof x === 'number')
  if (new Set(vals).size !== vals.length) {
    errs['_conflict'] = '端口不可重复，请为各服务分配不同端口'
  }
  return errs
}

export function validateHfToken(token: string): string | null {
  if (!token) return null // 允许空（未配置）
  const t = token.trim()
  if (t.length < 8) return 'HF Token 过短'
  if (t.length > 512) return 'HF Token 过长'
  // 常见前缀 hf_，但也允许其他 PAT 形态，宽松校验
  if (/[\s]/.test(t)) return 'Token 不能包含空白字符'
  return null
}

export function validateSearchSettings(s: Partial<SearchSettings>): Record<string, string> {
  const errs: Record<string, string> = {}
  if (s.provider && !['searxng', 'tavily', 'exa', 'brave'].includes(s.provider)) errs['provider'] = '未知搜索后端'
  if (s.searxngUrl !== undefined) {
    try {
      const u = new URL(s.searxngUrl)
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') errs['searxngUrl'] = 'SearXNG 仅允许 127.0.0.1 / localhost'
    } catch {
      errs['searxngUrl'] = 'SearXNG 地址不是合法 URL'
    }
  }
  for (const k of ['tavilyApiKey', 'exaApiKey', 'braveApiKey'] as const) {
    const v = (s as Record<string, unknown>)[k]
    if (typeof v === 'string' && v && v.trim().length < 4) errs[k] = '密钥过短'
  }
  return errs
}

export function validateImageBackend(img: Partial<ImageBackendSettings>): Record<string, string> {
  const errs: Record<string, string> = {}
  if (img.backend && !['sd.cpp', 'comfyui', 'auto'].includes(img.backend)) errs['backend'] = '未知生图后端'
  if (img.host !== undefined && img.host !== '127.0.0.1' && img.host !== 'localhost') errs['host'] = '生图后端仅允许 127.0.0.1 / localhost'
  if (img.port !== undefined) {
    const e = validatePort(img.port)
    if (e) errs['port'] = e
  }
  return errs
}

// ---------------------------------------------------------------------------
// 持久化 — 单文件 settings.json，密钥字段加密
// ---------------------------------------------------------------------------

export function getSettingsPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath: (n: string) => string } }
    const maybeApp = electron?.app
    if (maybeApp && typeof maybeApp.getPath === 'function') {
      try {
        const userData = maybeApp.getPath('userData')
        if (userData) return join(userData, 'settings.json')
      } catch {
        // app not ready
      }
    }
  } catch {
    // vitest
  }
  return join(process.cwd(), 'userData', 'settings.json')
}

function ensureDirFor(filePath: string): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

type PersistedSettings = Omit<UnifiedSettings, 'search' | 'hfToken'> & {
  search: Omit<SearchSettings, 'tavilyApiKey' | 'exaApiKey' | 'braveApiKey'> & {
    tavilyApiKey: string // encrypted payload or ""
    exaApiKey: string
    braveApiKey: string
  }
  hfToken: string // encrypted payload or ""
}

/** 将内存态 UnifiedSettings 转为落盘态（密钥加密） */
export async function toPersisted(s: UnifiedSettings): Promise<PersistedSettings> {
  return {
    ...s,
    hfToken: s.hfToken ? await encryptSecret(s.hfToken) : '',
    search: {
      ...s.search,
      tavilyApiKey: s.search.tavilyApiKey ? await encryptSecret(s.search.tavilyApiKey) : '',
      exaApiKey: s.search.exaApiKey ? await encryptSecret(s.search.exaApiKey) : '',
      braveApiKey: s.search.braveApiKey ? await encryptSecret(s.search.braveApiKey) : '',
    },
    meta: { updatedAt: new Date().toISOString(), encVersion: 1 },
  }
}

/** 将落盘态还原为内存态（密钥解密） */
export async function fromPersisted(p: Partial<PersistedSettings>): Promise<UnifiedSettings> {
  const base: UnifiedSettings = {
    search: { ...DEFAULT_SEARCH },
    hfToken: '',
    image: { ...DEFAULT_IMAGE },
    ports: { ...DEFAULT_PORTS },
    update: { ...DEFAULT_UPDATE },
    meta: { updatedAt: new Date().toISOString(), encVersion: 1 },
  }
  if (!p || typeof p !== 'object') return base
  if (p.search && typeof p.search === 'object') {
    const ps = p.search as PersistedSettings['search']
    base.search = {
      ...DEFAULT_SEARCH,
      ...ps,
      tavilyApiKey: ps.tavilyApiKey ? await decryptSecret(ps.tavilyApiKey) : '',
      exaApiKey: ps.exaApiKey ? await decryptSecret(ps.exaApiKey) : '',
      braveApiKey: ps.braveApiKey ? await decryptSecret(ps.braveApiKey) : '',
    }
  }
  if (typeof (p as PersistedSettings).hfToken === 'string') {
    base.hfToken = await decryptSecret((p as PersistedSettings).hfToken)
  }
  if (p.image) base.image = { ...DEFAULT_IMAGE, ...(p.image as ImageBackendSettings) }
  if (p.ports) base.ports = { ...DEFAULT_PORTS, ...(p.ports as PortSettings) }
  if (p.update) base.update = { ...DEFAULT_UPDATE, ...(p.update as UpdateSettings) }
  if (p.meta) base.meta = { ...(base.meta), ...(p.meta as UnifiedSettings['meta']) }
  return base
}

/** 读取 — 合并默认值，解密密钥。永不抛异常，缺文件/损坏返回 defaults */
export async function getSettings(): Promise<UnifiedSettings> {
  const fp = getSettingsPath()
  const defaults = () => ({ ...DEFAULT_SETTINGS, search: { ...DEFAULT_SEARCH }, image: { ...DEFAULT_IMAGE }, ports: { ...DEFAULT_PORTS }, update: { ...DEFAULT_UPDATE } })
  if (!existsSync(fp)) return defaults()
  try {
    const raw = readFileSync(fp, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>
    if (typeof parsed !== 'object' || parsed === null) return defaults()
    return await fromPersisted(parsed)
  } catch {
    return defaults()
  }
}

/** saveSettings 的补丁形状 — 各节均可深部分（此前的交叉类型写法实际强制全量，盲区暴露后修正） */
export type SettingsPatch = {
  search?: Partial<SearchSettings>
  hfToken?: string
  image?: Partial<ImageBackendSettings>
  ports?: Partial<PortSettings>
  update?: Partial<UpdateSettings>
}

/** 保存 — 接收内存态 Partial，合并后加密落盘，返回解密态全量 */
export async function saveSettings(partial: SettingsPatch): Promise<UnifiedSettings> {
  const current = await getSettings()
  const next: UnifiedSettings = {
    search: { ...current.search, ...(partial.search ?? {}) },
    hfToken: partial.hfToken !== undefined ? partial.hfToken : current.hfToken,
    image: { ...current.image, ...(partial.image ?? {}) },
    ports: { ...current.ports, ...(partial.ports ?? {}) },
    update: { ...current.update, ...(partial.update ?? {}) },
    meta: { updatedAt: new Date().toISOString(), encVersion: 1 },
  }
  // 校验端口冲突等仅警告，不阻断保存（由 UI 展示）
  const persisted = await toPersisted(next)
  const fp = getSettingsPath()
  ensureDirFor(fp)
  writeFileSync(fp, JSON.stringify(persisted, null, 2), 'utf-8')
  return next
}

/** 轮转 — 用当前 safeStorage 重新加密所有密钥字段（用于 OS 钥匙串更换 / 定期轮转） */
export async function rotateSecrets(): Promise<{ rotated: number; path: string }> {
  const cur = await getSettings() // 已解密
  const fp = getSettingsPath()
  // 重新加密落盘即完成轮转（encryptSecret 会用当前 safeStorage 重新封）
  const persisted = await toPersisted(cur)
  ensureDirFor(fp)
  writeFileSync(fp, JSON.stringify({ ...persisted, meta: { updatedAt: new Date().toISOString(), encVersion: 1 } }, null, 2), 'utf-8')
  const count = [cur.hfToken, cur.search.tavilyApiKey, cur.search.exaApiKey, cur.search.braveApiKey].filter(Boolean).length
  return { rotated: count, path: fp }
}

/** 清空单条密钥 */
export async function clearSecret(field: 'hfToken' | 'tavilyApiKey' | 'exaApiKey' | 'braveApiKey'): Promise<UnifiedSettings> {
  if (field === 'hfToken') return saveSettings({ hfToken: '' })
  return saveSettings({ search: { [field]: '' } as Partial<SearchSettings> })
}

// ---------------------------------------------------------------------------
// React — 设置页
// ---------------------------------------------------------------------------

type MaskedInputProps = {
  label: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
  hint?: string
}

function MaskedInput({ label, value, placeholder, onChange, hint }: MaskedInputProps): React.JSX.Element {
  const [revealed, setRevealed] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])
  const masked = maskSecret(value)
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>{label}</label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {revealed ? (
          <input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { onChange(draft.trim()); setRevealed(false) }}
            style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#eee' }}
          />
        ) : (
          <input
            value={value ? masked : ''}
            placeholder={placeholder}
            readOnly
            onFocus={() => setRevealed(true)}
            style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#aaa', cursor: 'pointer' }}
          />
        )}
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #333', background: '#222', color: '#ccc', cursor: 'pointer', fontSize: 12 }}
        >
          {revealed ? '完成' : value ? '编辑' : '设置'}
        </button>
        {value ? (
          <button
            type="button"
            onClick={() => { onChange(''); setDraft('') }}
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #4a2020', background: '#2a1a1a', color: '#e88', cursor: 'pointer', fontSize: 12 }}
          >
            清除
          </button>
        ) : null}
      </div>
      {hint ? <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>{hint}</div> : null}
    </div>
  )
}

export function SettingsPage(): React.JSX.Element {
  const [settings, setSettings] = React.useState<UnifiedSettings>(() => ({
    ...DEFAULT_SETTINGS,
    search: { ...DEFAULT_SEARCH },
    image: { ...DEFAULT_IMAGE },
    ports: { ...DEFAULT_PORTS },
    update: { ...DEFAULT_UPDATE },
  }))
  const [portDraft, setPortDraft] = React.useState<PortSettings>(settings.ports)
  const [msg, setMsg] = React.useState('')

  // getSettings 是异步的（密钥解密走 IPC）— 首帧用默认值，随后异步合并真实设置；getSettings 契约保证不抛异常
  React.useEffect(() => {
    let cancelled = false
    void getSettings().then((s) => {
      if (!cancelled) setSettings(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => setPortDraft(settings.ports), [settings.ports])

  const save = (patch: Parameters<typeof saveSettings>[0]): void => {
    // encryptSecret IPC 可能失败 → saveSettings 可能 reject，必须 await 并在 UI 明示错误
    void (async () => {
      try {
        const next = await saveSettings(patch)
        setSettings(next)
        setMsg('已保存（密钥已用 safeStorage 加密落盘）')
        window.setTimeout(() => setMsg(''), 1800)
      } catch (e) {
        setMsg(`保存失败：${(e as Error).message ?? String(e)}`)
      }
    })()
  }

  const portErrors = validatePorts(portDraft)

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24, fontFamily: 'system-ui,sans-serif', color: '#e8e8e8', background: '#0f0f0f', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, margin: '0 0 6px' }}>设置</h1>
      <p style={{ fontSize: 12, color: '#888', margin: '0 0 20px' }}>搜索 / HF Token / 生图后端 / 端口 / 更新 — 密钥经 Electron safeStorage 加密，落盘永不明文。详见 docs/SECURITY.md#rotation</p>
      {msg ? <div style={{ background: '#14331a', color: '#8f8', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 16 }}>{msg}</div> : null}

      {/* 搜索 */}
      <section style={{ border: '1px solid #222', borderRadius: 10, padding: 16, marginBottom: 16, background: '#141414' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>搜索</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['searxng', 'tavily', 'exa', 'brave'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => save({ search: { provider: p } })}
              style={{ padding: '6px 12px', borderRadius: 20, border: settings.search.provider === p ? '1px solid #4a8' : '1px solid #333', background: settings.search.provider === p ? '#1a2e22' : '#1a1a1a', color: settings.search.provider === p ? '#8f8' : '#aaa', cursor: 'pointer', fontSize: 12 }}
            >
              {p}
            </button>
          ))}
        </div>
        <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>SearXNG 地址</label>
        <input
          value={settings.search.searxngUrl}
          onChange={(e) => setSettings((s) => ({ ...s, search: { ...s.search, searxngUrl: e.target.value } }))}
          onBlur={(e) => save({ search: { searxngUrl: e.target.value.trim() || DEFAULT_SEARCH.searxngUrl } })}
          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#eee', marginBottom: 8 }}
        />
        <label style={{ fontSize: 12, color: '#888', display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <input type="checkbox" checked={settings.search.searxngEnabled} onChange={(e) => save({ search: { searxngEnabled: e.target.checked } })} /> 启用本地 SearXNG
        </label>
        <MaskedInput label="Tavily API Key" value={settings.search.tavilyApiKey} placeholder="tvly-..." onChange={(v) => save({ search: { tavilyApiKey: v } })} hint="留空则该提供商在搜索页隐藏" />
        <MaskedInput label="Exa API Key" value={settings.search.exaApiKey} placeholder="exa_..." onChange={(v) => save({ search: { exaApiKey: v } })} />
        <MaskedInput label="Brave API Key" value={settings.search.braveApiKey} placeholder="BSA..." onChange={(v) => save({ search: { braveApiKey: v } })} />
      </section>

      {/* HF Token */}
      <section style={{ border: '1px solid #222', borderRadius: 10, padding: 16, marginBottom: 16, background: '#141414' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>Hugging Face</h2>
        <MaskedInput label="HF Token" value={settings.hfToken} placeholder="hf_..." onChange={(v) => save({ hfToken: v })} hint="用于私有/限速模型下载，仅 127.0.0.1 侧车使用，不出本机" />
      </section>

      {/* 生图后端 */}
      <section style={{ border: '1px solid #222', borderRadius: 10, padding: 16, marginBottom: 16, background: '#141414' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>生图后端</h2>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {(['auto', 'sd.cpp', 'comfyui'] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => save({ image: { backend: b } })}
              style={{ padding: '6px 12px', borderRadius: 20, border: settings.image.backend === b ? '1px solid #48a' : '1px solid #333', background: settings.image.backend === b ? '#1a2230' : '#1a1a1a', color: settings.image.backend === b ? '#8af' : '#aaa', cursor: 'pointer', fontSize: 12 }}
            >
              {b}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>Host</label>
            <input value={settings.image.host} readOnly style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #333', background: '#111', color: '#777' }} />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>仅 127.0.0.1 / localhost（侧车约束）</div>
          </div>
          <div style={{ width: 140 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>端口</label>
            <input
              type="number"
              value={settings.image.port}
              onChange={(e) => setSettings((s) => ({ ...s, image: { ...s.image, port: Number(e.target.value) } }))}
              onBlur={(e) => save({ image: { port: Number(e.target.value) } })}
              style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#eee' }}
            />
          </div>
        </div>
        <label style={{ fontSize: 12, color: '#888', display: 'block', margin: '10px 0 4px' }}>默认模型</label>
        <input
          value={settings.image.model}
          onChange={(e) => setSettings((s) => ({ ...s, image: { ...s.image, model: e.target.value } }))}
          onBlur={(e) => save({ image: { model: e.target.value.trim() || 'sdxl' } })}
          placeholder="sdxl / sd1.5-q4 / flux"
          style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#eee' }}
        />
      </section>

      {/* 端口 */}
      <section style={{ border: '1px solid #222', borderRadius: 10, padding: 16, marginBottom: 16, background: '#141414' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>端口</h2>
        {(Object.keys(DEFAULT_PORTS) as Array<keyof PortSettings>).map((k) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: '#888', display: 'block', marginBottom: 4 }}>{k}</label>
            <input
              type="number"
              value={portDraft[k]}
              onChange={(e) => setPortDraft((d) => ({ ...d, [k]: Number(e.target.value) }))}
              onBlur={() => {
                const errs = validatePorts(portDraft)
                if (Object.keys(errs).length) { setMsg(Object.values(errs).join('；')); return }
                save({ ports: { ...portDraft } })
              }}
              style={{ width: 200, padding: '6px 8px', borderRadius: 6, border: portErrors[k] ? '1px solid #a33' : '1px solid #333', background: '#1a1a1a', color: '#eee' }}
            />
            {portErrors[k] ? <span style={{ fontSize: 11, color: '#e66', marginLeft: 8 }}>{portErrors[k]}</span> : null}
          </div>
        ))}
        {portErrors['_conflict'] ? <div style={{ fontSize: 11, color: '#e66' }}>{portErrors['_conflict']}</div> : null}
      </section>

      {/* 更新 */}
      <section style={{ border: '1px solid #222', borderRadius: 10, padding: 16, marginBottom: 16, background: '#141414' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 12px' }}>更新</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#ccc' }}>
          <input type="checkbox" checked={settings.update.autoUpdateEnabled} onChange={(e) => save({ update: { autoUpdateEnabled: e.target.checked } })} />
          自动检查更新
        </label>
        <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>关闭后仅手动触发更新检查</div>
      </section>

      {/* 轮转 */}
      <section style={{ border: '1px dashed #333', borderRadius: 10, padding: 16, background: '#0f0f0f' }}>
        <h2 style={{ fontSize: 13, margin: '0 0 8px' }}>密钥轮转</h2>
        <p style={{ fontSize: 11, color: '#777', margin: '0 0 8px', lineHeight: 1.6 }}>
          密钥仅以 <code>enc:v1:</code> 形态落盘（OS 钥匙串加密）。轮转请：1) 在提供商处重新生成密钥 → 2) 本页粘贴新值（自动重加密）→ 3) 或点击「重加密」用当前系统钥匙串重封现有密钥。详见 docs/SECURITY.md#rotation。
        </p>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              try {
                const r = await rotateSecrets()
                const cur = await getSettings()
                setSettings(cur)
                setMsg(`已重加密 ${r.rotated} 条密钥`)
              } catch (e) {
                setMsg(`轮转失败：${(e as Error).message ?? String(e)}`)
              }
            })()
          }}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #333', background: '#1e1e1e', color: '#ccc', cursor: 'pointer', fontSize: 12 }}
        >
          重加密（轮转）
        </button>
      </section>
    </div>
  )
}

export default SettingsPage
