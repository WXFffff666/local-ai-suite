import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

export type Theme = 'light' | 'dark' | 'system'

/**
 * config.json schema version (todo24, plan A9/r2). v1 files have no
 * schemaVersion field at all; readers must treat missing as v1 and merge
 * defaults over them. Writers always persist CURRENT_SCHEMA_VERSION
 * (rewrite-on-save upgrade). Unknown fields from older/newer files are
 * preserved verbatim on save.
 */
export const CURRENT_SCHEMA_VERSION = 2

/**
 * Encrypted secret payloads persisted in config.json (todo16). Values are
 * safeStorage envelopes (`enc:v1:` / `enc:fallback:v1:`) or '' (cleared) —
 * plaintext never reaches disk (config:set handler enforces the prefix).
 */
export type SecretPayloads = {
  hfToken?: string
  tavilyApiKey?: string
  exaApiKey?: string
  braveApiKey?: string
}

export type AppConfig = {
  /** config.json schema version; missing on disk = v1 (tolerant read, upgrade on save) */
  schemaVersion: number
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
  /** todo36: push-to-talk mic button visible/enabled in the composer */
  speechEnabled: boolean
  /** todo36: absolute whisper ggml/gguf model path ('' = not configured) */
  whisperModelPath: string
  /**
   * todo39: RAG query精排 via llama.cpp /v1/rerank. The endpoint is OFF by
   * default server-side too — services.launchModel adds `--rerank` when a
   * rerank-named GGUF is loaded; toggling this with no rerank instance up
   * degrades gracefully (fusion-only results + a UI notice).
   */
  rerankEnabled: boolean
  /** todo39: served reranker model name (llama.cpp --model identity at /v1/rerank) */
  rerankModel: string
  /** todo39: served embedding model name ('' = auto-detect / hash-degraded) */
  embeddingModel: string
  /**
   * todo38: global screenshot ask-overlay hotkey (fixed CommandOrControl+Shift+A).
   * Enabled-flag only — the combo is deliberately NOT configurable this round
   * (plan: keep simple); false = globalShortcut never registers.
   */
  screenshotHotkeyEnabled: boolean
  /** Encrypted secrets (todo16) — see SecretPayloads contract above */
  secrets?: SecretPayloads
  /**
   * todo40: MCP stdio servers, keyed by name. Structural mirror of
   * src/mcp/types McpServerEntry (this file must stay import-free of src/mcp
   * to avoid a cycle — the pool is the consumer). Env VALUES are plaintext on
   * disk here by design (same posture as Claude Desktop's config); IPC replies
   * expose keys only.
   */
  mcpServers?: Record<string, import('../../mcp/types').McpServerEntry>
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  theme: 'system',
  locale: 'zh-CN',
  modelsDir: 'models',
  openaiPort: 11434,
  llamaPort: 11435,
  ollamaPort: 11434,
  autoUpdateEnabled: true,
  searxngEnabled: false,
  onboardingCompleted: false,
  speechEnabled: true,
  whisperModelPath: '',
  rerankEnabled: false,
  rerankModel: 'bge-reranker-v2-m3',
  embeddingModel: '',
  screenshotHotkeyEnabled: true,
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

/**
 * Read config from disk, merged with defaults. Never throws — returns defaults on missing/corrupt file.
 * Tolerant reader (todo24): a v1 file (no schemaVersion, or a non-numeric value) is merged over
 * defaults; unknown keys are preserved for round-trip. The upgrade to the current schema version is
 * persisted on the next save (rewrite-on-save).
 */
export function getConfig(): AppConfig {
  const p = getConfigPath()
  if (!existsSync(p)) return { ...DEFAULT_CONFIG }
  try {
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_CONFIG }
    const merged: AppConfig = { ...DEFAULT_CONFIG, ...parsed }
    if (typeof merged.schemaVersion !== 'number' || !Number.isFinite(merged.schemaVersion)) {
      merged.schemaVersion = DEFAULT_CONFIG.schemaVersion
    }
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Merge partial config into existing and persist to disk.
 * Always stamps schemaVersion = CURRENT_SCHEMA_VERSION (v1 → v2 rewrite-on-save upgrade)
 * and keeps unknown fields from older files verbatim.
 * Returns the new full config.
 */
export function setConfig(partial: Partial<AppConfig>): AppConfig {
  const current = getConfig()
  const next: AppConfig = { ...current, ...partial, schemaVersion: CURRENT_SCHEMA_VERSION }
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
