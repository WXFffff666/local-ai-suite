/**
 * i18n — Wave7 T30
 * 中文默认，MIT 友好自研（不引入 AGPL i18n 库）
 * 约定：扁平 key，zh-CN 全量，en 回退到 zh-CN
 */

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type Locale = 'zh-CN' | 'en'

export const DEFAULT_LOCALE: Locale = 'zh-CN'
export const LOCALE_STORAGE_KEY = 'las:locale'
export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en'] as const

export function isLocale(v: string): v is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(v)
}

export function normalizeLocale(v: unknown): Locale {
  if (typeof v !== 'string') return DEFAULT_LOCALE
  const s = v.trim()
  if (isLocale(s)) return s
  // 兼容大小写 / 简写 en -> en, zh -> zh-CN, zh-CN/* 保持中文默认
  const low = s.toLowerCase()
  if (low === 'en' || low === 'en-us' || low === 'en-gb') return 'en'
  if (low.startsWith('zh')) return 'zh-CN'
  return DEFAULT_LOCALE
}

// ---------------------------------------------------------------------------
// Messages — 扁平 key，覆盖主要界面文案（后续可增量扩展）
// ---------------------------------------------------------------------------

type Messages = Record<string, string>

const zhCN: Messages = {
  // 通用
  'app.title': 'Local AI Suite',
  'app.subtitle': '本地模型一键安装与离线工作流套件',
  'common.loading': '加载中…',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.search': '搜索',
  'common.settings': '设置',
  'common.theme': '主题',
  'common.language': '语言',
  'common.light': '浅色',
  'common.dark': '深色',
  'common.system': '跟随系统',
  'common.copy': '复制',
  'common.delete': '删除',
  'common.retry': '重试',
  // 主题
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.system': '跟随系统',
  'theme.switchToLight': '切换到浅色',
  'theme.switchToDark': '切换到深色',
  'theme.switchToSystem': '跟随系统',
  // 语言
  'lang.zh-CN': '中文',
  'lang.en': 'English',
  'lang.switched': '已切换到 {locale}',
  // 导航 / 占位
  'nav.chat': '对话',
  'nav.gallery': '画廊',
  'nav.settings': '设置',
  'nav.models': '模型',
  // 聊天
  'chat.placeholder': '输入消息…（Ctrl+Enter 发送，/ 唤起生图）',
  'chat.send': '发送',
  'chat.thinking': '思考中…',
  'chat.stop': '停止',
  // 校验示例（插值演示）
  'hello': '你好，{name}！',
  'items.count': '共 {count} 项',
}

const en: Messages = {
  'app.title': 'Local AI Suite',
  'app.subtitle': 'One-click local models & offline workflows',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.search': 'Search',
  'common.settings': 'Settings',
  'common.theme': 'Theme',
  'common.language': 'Language',
  'common.light': 'Light',
  'common.dark': 'Dark',
  'common.system': 'System',
  'common.copy': 'Copy',
  'common.delete': 'Delete',
  'common.retry': 'Retry',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',
  'theme.switchToLight': 'Switch to light',
  'theme.switchToDark': 'Switch to dark',
  'theme.switchToSystem': 'Follow system',
  'lang.zh-CN': '中文',
  'lang.en': 'English',
  'lang.switched': 'Switched to {locale}',
  'nav.chat': 'Chat',
  'nav.gallery': 'Gallery',
  'nav.settings': 'Settings',
  'nav.models': 'Models',
  'chat.placeholder': 'Type a message… (Ctrl+Enter to send, / for image)',
  'chat.send': 'Send',
  'chat.thinking': 'Thinking…',
  'chat.stop': 'Stop',
  'hello': 'Hello, {name}!',
  'items.count': '{count} items',
}

export const messages: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  en,
}

// 供测试 / 调试：扁平 key 列表
export const ALL_KEYS = Object.keys(zhCN)

// ---------------------------------------------------------------------------
// Storage helpers — SSR/非浏览器安全
// ---------------------------------------------------------------------------

function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function getStoredLocale(): Locale {
  if (!canUseStorage()) return DEFAULT_LOCALE
  try {
    const v = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (v) return normalizeLocale(v)
  } catch {
    // ignore
  }
  return DEFAULT_LOCALE
}

export function setStoredLocale(locale: Locale): void {
  const l = normalizeLocale(locale)
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, l)
    // 同步 html lang，无闪烁语义
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.lang = l
    }
  } catch {
    // quota / private mode — ignore
  }
}

/**
 * 启动时决定 locale — 始终 中文默认 优先于 navigator.language
 * 只有当本地无存储且显式需要跟随系统时才读 navigator
 * 这里保持默认 zh-CN，不做自动跟随，避免首次英文闪烁
 */
export function detectInitialLocale(): Locale {
  // 显式存储优先
  if (canUseStorage()) {
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
      if (stored) return normalizeLocale(stored)
    } catch {
      // ignore
    }
  }
  return DEFAULT_LOCALE
}

// ---------------------------------------------------------------------------
// t() — 插值 & 回退
// ---------------------------------------------------------------------------

export type TParams = Record<string, string | number>

function interpolate(template: string, params?: TParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k]
    return v !== undefined ? String(v) : `{${k}}`
  })
}

/**
 * 翻译
 * @param key 扁平 key
 * @param locale 指定语言，默认 detectInitialLocale / getStoredLocale
 * @param params 插值 {name} 替换
 * 查找顺序：指定 locale -> DEFAULT_LOCALE -> key 本身
 */
export function t(key: string, locale?: Locale, params?: TParams): string
export function t(key: string, params?: TParams): string
export function t(key: string, a?: Locale | TParams, b?: TParams): string {
  let locale: Locale | undefined
  let params: TParams | undefined
  if (a && typeof a === 'object') {
    params = a as TParams
  } else if (typeof a === 'string') {
    if (isLocale(a)) locale = a
    // 允许 t('k','en',{x}) 也允许 t('k','zh-CN')
    params = b
  }
  const l = locale ?? getStoredLocale()

  // 1) 请求 locale
  const dict = messages[l]
  if (dict && dict[key] !== undefined) return interpolate(dict[key], params)
  // 2) 回退中文
  const fallback = messages[DEFAULT_LOCALE][key]
  if (fallback !== undefined) return interpolate(fallback, params)
  // 3) 回退所有 locale 线性查找（兼容增量 key 仅在 en 存在）
  for (const loc of SUPPORTED_LOCALES) {
    const v = messages[loc][key]
    if (v !== undefined) return interpolate(v, params)
  }
  // 4) 兜底返回 key
  return interpolate(key, params)
}

// 简写别名，满足不同调用习惯
export const translate = t

// 单例式 i18n 实例（供 ThemeProvider 共享）
export function createI18n(initialLocale: Locale = DEFAULT_LOCALE) {
  let cur: Locale = normalizeLocale(initialLocale)
  return {
    get locale(): Locale {
      return cur
    },
    setLocale(next: Locale): void {
      cur = normalizeLocale(next)
      setStoredLocale(cur)
    },
    t(key: string, params?: TParams): string {
      return t(key, cur, params)
    },
  }
}

export type I18nInstance = ReturnType<typeof createI18n>
