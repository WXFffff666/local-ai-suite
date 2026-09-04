/**
 * types.ts — todo16 设置页线格式类型（镜像 src/main/storage/config.ts AppConfig
 * 与 secrets IPC 应答；不 import config.ts，避免把 fs 依赖带进渲染层包）。
 */

export type ThemeChoice = 'light' | 'dark' | 'system'
export type LocaleChoice = 'zh-CN' | 'en'

export type SecretFieldName = 'hfToken' | 'tavilyApiKey' | 'exaApiKey' | 'braveApiKey'

export type WireConfig = {
  theme: ThemeChoice
  locale: string
  modelsDir: string
  openaiPort: number
  /** todo41: quick-ask global hotkey flag (config.json; false = never binds). */
  quickaskHotkeyEnabled?: boolean
  secrets?: Partial<Record<SecretFieldName, string>>
}

export type ConfigGetReply = { ok?: boolean; config?: WireConfig }
export type ConfigSetReply = { ok?: boolean; config?: WireConfig; error?: string }

export type EncryptReply = { ok: boolean; value?: string; warning?: string; error?: string }
export type DecryptReply = { ok: boolean; value?: string; error?: string }

/** UI 脱敏 — 首/尾各 2 字符，其余 *（与 src/settings/settings.tsx maskSecret 同规则）。 */
export function maskSecret(secret: string): string {
  if (!secret) return '未配置'
  const s = secret.trim()
  if (s.length <= 4) return '****'
  return `${s.slice(0, 2)}****${s.slice(-2)}`
}
