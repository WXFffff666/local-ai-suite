/**
 * theme.tsx — Wave7 T30
 * 主题 + i18n Provider：浅 / 深 / 跟随系统，中文默认，启动无闪烁
 * 无第三方依赖，MIT 安全
 */
import * as React from 'react'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  type Locale,
  isLocale,
  normalizeLocale,
  getStoredLocale as getStoredLocaleI18n,
  setStoredLocale as setStoredLocaleI18n,
  t as translate,
  messages,
} from './i18n'

// ---------------------------------------------------------------------------
// Theme types & storage
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'las:theme'
export const THEME_ATTR = 'data-theme'
export const SUPPORTED_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'] as const

export function isThemeMode(v: string): v is ThemeMode {
  return (SUPPORTED_MODES as readonly string[]).includes(v)
}

export function normalizeThemeMode(v: unknown): ThemeMode {
  if (typeof v !== 'string') return 'system'
  const s = v.trim().toLowerCase()
  if (s === 'light' || s === 'dark' || s === 'system') return s as ThemeMode
  return 'system'
}

// ---------------------------------------------------------------------------
// Storage helpers (SSR safe)
// ---------------------------------------------------------------------------

function canUseWindow(): boolean {
  return typeof window !== 'undefined'
}

function canUseStorage(): boolean {
  try {
    return canUseWindow() && typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

export function getStoredThemeMode(): ThemeMode {
  if (!canUseStorage()) return 'system'
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (v && isThemeMode(v)) return v
    if (v) return normalizeThemeMode(v)
  } catch {
    // ignore
  }
  return 'system'
}

export function setStoredThemeMode(mode: ThemeMode): void {
  const m = normalizeThemeMode(mode)
  if (!canUseStorage()) return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, m)
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// System preference
// ---------------------------------------------------------------------------

export function getSystemTheme(): ResolvedTheme {
  if (!canUseWindow() || typeof window.matchMedia !== 'function') return 'light'
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return getSystemTheme()
  return mode
}

// ---------------------------------------------------------------------------
// DOM apply — 同步写 <html data-theme> 与 color-scheme，保证首帧正确
// ---------------------------------------------------------------------------

export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  const el = document.documentElement
  el.setAttribute(THEME_ATTR, resolved)
  // color-scheme 影响原生控件与滚动条
  try {
    // @ts-ignore style property always exists in DOM
    el.style.colorScheme = resolved
  } catch {
    // ignore
  }
  // 同步 class，兼容 Tailwind dark 方案
  el.classList.remove('light', 'dark')
  el.classList.add(resolved)
}

/**
 * 从存储 + 系统偏好解析并立即应用（同步，无闪烁）
 * 返回解析后的 ResolvedTheme
 */
export function applyStoredTheme(): ResolvedTheme {
  const mode = getStoredThemeMode()
  const resolved = resolveTheme(mode)
  applyTheme(resolved)
  return resolved
}

// ---------------------------------------------------------------------------
// No-flash inline script
// 在 <head> 顶部同步执行，React 挂载前即设置 data-theme，避免 FOUC
// 将此脚本以 <script> 形式内联到 index.html
// ---------------------------------------------------------------------------

export const THEME_NO_FLASH_SCRIPT = `(function(){try{var k='${THEME_STORAGE_KEY}';var lk='${LOCALE_STORAGE_KEY}';var m=localStorage.getItem(k)||'system';var s=m;if(m==='system'){try{s=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){s='light'}}document.documentElement.setAttribute('${THEME_ATTR}',s);document.documentElement.style.colorScheme=s;document.documentElement.classList.remove('light','dark');document.documentElement.classList.add(s);var loc=localStorage.getItem(lk)||'${DEFAULT_LOCALE}';if(loc)document.documentElement.lang=loc;}catch(e){}})();`

export function getNoFlashScript(): string {
  return THEME_NO_FLASH_SCRIPT
}

/** 便捷：生成可直接插入 index.html 的 <script> 标签字符串 */
export function getNoFlashScriptTag(): string {
  return `<script>${THEME_NO_FLASH_SCRIPT}</script>`
}

// ---------------------------------------------------------------------------
// React — ThemeProvider + i18n 联动
// ---------------------------------------------------------------------------

export type ThemeContextValue = {
  /** 用户选择的模式 */
  mode: ThemeMode
  /** 解析后的实际主题（system 时跟随系统） */
  resolved: ResolvedTheme
  /** 系统当前偏好 */
  systemTheme: ResolvedTheme
  setMode: (m: ThemeMode) => void
  toggle: () => void
  // i18n
  locale: Locale
  setLocale: (l: Locale) => void
  /** 以当前 locale 翻译 */
  t: (key: string, params?: Record<string, string | number>) => string
  /** 原始 translate（可显式指定 locale） */
  translate: typeof translate
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

export function useTranslation(): {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
} {
  const { locale, setLocale, t } = useTheme()
  return { locale, setLocale, t }
}

type ThemeProviderProps = {
  children: React.ReactNode
  /** 可用于 SSR / 测试：强制初始 mode / locale */
  defaultMode?: ThemeMode
  defaultLocale?: Locale
}

export function ThemeProvider({
  children,
  defaultMode,
  defaultLocale,
}: ThemeProviderProps): React.JSX.Element {
  // 初始化：同步读取 storage（首帧前已由 inline script 应用，这里保持一致）
  const [mode, setModeState] = React.useState<ThemeMode>(() =>
    defaultMode ? normalizeThemeMode(defaultMode) : getStoredThemeMode(),
  )
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(() => getSystemTheme())
  const [locale, setLocaleState] = React.useState<Locale>(() =>
    defaultLocale ? normalizeLocale(defaultLocale) : getStoredLocaleI18n(),
  )

  const resolved: ResolvedTheme = mode === 'system' ? systemTheme : mode

  // 持久化 + DOM 应用
  React.useEffect(() => {
    setStoredThemeMode(mode)
    applyTheme(resolved)
  }, [mode, resolved])

  React.useEffect(() => {
    setStoredLocaleI18n(locale)
  }, [locale])

  // 监听系统偏好变化（仅 system 模式需要响应）
  React.useEffect(() => {
    if (!canUseWindow() || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (): void => {
      const next = mq.matches ? 'dark' : 'light'
      setSystemTheme(next)
      if (mode === 'system') applyTheme(next)
    }
    // 初始同步一次（防止首帧后系统变化）
    handler()
    // 兼容新旧 API
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      // Safari <14
      // @ts-ignore deprecated addListener
      mq.addListener(handler)
      // @ts-ignore
      return () => mq.removeListener(handler)
    }
  }, [mode])

  // 跨 tab 同步（storage 事件）
  React.useEffect(() => {
    if (!canUseWindow()) return
    const onStorage = (e: StorageEvent): void => {
      if (e.key === THEME_STORAGE_KEY && e.newValue && isThemeMode(e.newValue)) {
        setModeState(e.newValue)
      }
      if (e.key === LOCALE_STORAGE_KEY && e.newValue && isLocale(e.newValue)) {
        setLocaleState(e.newValue)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setMode = React.useCallback((m: ThemeMode) => {
    setModeState(normalizeThemeMode(m))
  }, [])

  const toggle = React.useCallback(() => {
    setModeState((prev) => {
      if (prev === 'light') return 'dark'
      if (prev === 'dark') return 'system'
      return 'light'
    })
  }, [])

  const setLocale = React.useCallback((l: Locale) => {
    setLocaleState(normalizeLocale(l))
  }, [])

  const t = React.useCallback(
    (key: string, params?: Record<string, string | number>) => translate(key, locale, params),
    [locale],
  )

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      systemTheme,
      setMode,
      toggle,
      locale,
      setLocale,
      t,
      translate,
    }),
    [mode, resolved, systemTheme, setMode, toggle, locale, setLocale, t],
  )

  return React.createElement(ThemeContext.Provider, { value }, children)
}

// ---------------------------------------------------------------------------
// Helpers / tokens — 供非 React 场景 & 样式
// ---------------------------------------------------------------------------

export const themeTokens = {
  light: {
    bg: '#ffffff',
    fg: '#0f0f0f',
    muted: '#666666',
    border: '#e5e5e5',
    card: '#f6f6f6',
  },
  dark: {
    bg: '#0f0f0f',
    fg: '#e8e8e8',
    muted: '#999999',
    border: '#222222',
    card: '#141414',
  },
} as const

// re-export i18n helpers 方便单入口
export {
  DEFAULT_LOCALE as I18N_DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY as I18N_STORAGE_KEY,
  messages as i18nMessages,
  normalizeLocale as normalizeI18nLocale,
  getStoredLocaleI18n,
  setStoredLocaleI18n,
  translate as i18nTranslate,
}
export type { Locale as I18nLocale }
