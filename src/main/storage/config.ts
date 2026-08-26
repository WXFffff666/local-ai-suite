import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

export type Theme = 'light' | 'dark' | 'system'

export type AppConfig = {
  /** UI theme */
  theme: Theme
  /** BCP47 locale, default zh-CN */
  locale: string
  /** Models directory (relative to project or absolute) */
  modelsDir: string
  /** OpenAI-compatible server port (127.0.0.1) */
  openaiPort: number
  /** llama.cpp sidecar port */
  llamaPort: number
  /** Ollama-compat layer port (usually same as openaiPort) */
  ollamaPort: number
  /** Auto-update check enabled */
  autoUpdateEnabled: boolean
  /** SearXNG local sidecar enabled */
  searxngEnabled: boolean
  /** Last onboarding wizard completed */
  onboardingCompleted: boolean
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  locale: 'zh-CN',
  modelsDir: 'models',
  openaiPort: 11434,
  llamaPort: 11435,
  ollamaPort: 11434,
  autoUpdateEnabled: true,
  searxngEnabled: false,
  onboardingCompleted: false,
}

/** Resolve userData/config.json path — Electron userData in prod, ./userData/config.json fallback for tests. */
export function getConfigPath(): string {
  try {
    // Dynamic require avoids bundling issue when electron is not available (vitest)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath: (name: string) => string } }
    const maybeApp = electron?.app
    if (maybeApp && typeof maybeApp.getPath === 'function') {
      try {
        const userData = maybeApp.getPath('userData')
        if (userData) return join(userData, 'config.json')
      } catch {
        // app.getPath may throw if app not ready
      }
    }
  } catch {
    // electron not available (test)
  }
  return join(process.cwd(), 'userData', 'config.json')
}

function ensureDirFor(filePath: string): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Read config from disk, merged with defaults. Never throws — returns defaults on missing/corrupt file. */
export function getConfig(): AppConfig {
  const p = getConfigPath()
  if (!existsSync(p)) return { ...DEFAULT_CONFIG }
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_CONFIG }
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Merge partial config into existing and persist to disk.
 * Returns the new full config.
 */
export function setConfig(partial: Partial<AppConfig>): AppConfig {
  const current = getConfig()
  const next: AppConfig = { ...current, ...partial }
  const p = getConfigPath()
  ensureDirFor(p)
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8')
  return next
}

/** Reset config to defaults (deletes persisted file and restores defaults). */
export function resetConfig(): AppConfig {
  const p = getConfigPath()
  ensureDirFor(p)
  writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
  return { ...DEFAULT_CONFIG }
}
