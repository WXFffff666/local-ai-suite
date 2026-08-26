/**
 * Sidecar / Provider abstractions — T4
 * Contract for T8-T10,16,20 reuse. All sidecars MUST bind 127.0.0.1.
 * No AGPL here; pure interfaces.
 */

/** Single sidecar descriptor. All fields required; healthUrl must be 127.0.0.1. */
export interface ISidecar {
  /** Logical name, also used for log file: logs/sidecar-<name>.log */
  name: string
  /** Binary to spawn (absolute or resolved). */
  bin: string
  /** CLI args, e.g. ['--port','11435','--host','127.0.0.1'] */
  args: string[]
  /** TCP port the sidecar listens on (1024-65535). */
  port: number
  /** Health endpoint, must be http://127.0.0.1:<port>/... */
  healthUrl: string
}

/** Sidecar runtime status (returned by SidecarManager.getStatus()). */
export interface SidecarStatus {
  name: string
  running: boolean
  pid?: number
  port: number
  healthUrl: string
  failures: number
  restarts: number
}

/** Model provider sidecar (T8-T10). Wraps ISidecar + model operations. */
export interface IModelProvider extends ISidecar {
  /** Optional default model path (GGUF). */
  modelPath?: string
  /** List available local models. */
  listModels?(): Promise<{ name: string; path: string }[]>
  /** Generate completion (non-stream). */
  generate?(prompt: string, opts?: Record<string, unknown>): Promise<string>
  /** Chat completion (openai-compat). */
  chat?(messages: { role: string; content: string }[], opts?: Record<string, unknown>): Promise<string>
}

/** Search adapter sidecar (T16-T18, SearXNG + cloud). */
export interface ISearchAdapter extends ISidecar {
  /** Uniform search entry — returns normalized results regardless of backend. */
  search?(query: string, opts?: { count?: number }): Promise<SearchResultItem[]>
}

/** Image backend sidecar (T20-T22, sd.cpp). */
export interface IImageBackend extends ISidecar {
  /** Generate image from prompt — returns PNG path or b64. */
  generate?(prompt: string, opts?: Record<string, unknown>): Promise<{ path?: string; b64?: string }>
}

/** Search result item (shared across adapters). */
export interface SearchResultItem {
  title: string
  url: string
  snippet: string
}

/** Log entry helper. */
export interface LogRecord {
  ts: string
  level: 'info' | 'warn' | 'error'
  msg: string
}
