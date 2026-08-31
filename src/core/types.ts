/**
 * Sidecar / Provider abstractions — T4, extended by audit fix W0-2.
 * Contract for T8-T10,16,20 reuse. All sidecars MUST bind 127.0.0.1.
 * No AGPL here: interfaces, the config guard protecting them, and the shared
 * lifecycle vocabulary (state, events, manager DI options).
 */

import type { ChildProcess } from 'child_process'

import type { LogFsDeps } from './sidecarLogs'

/** All sidecars bind the loopback interface — no exceptions. */
export const SIDECAR_HOST = '127.0.0.1' as const

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

/**
 * Lifecycle state machine of a SidecarManager (audit fix W0-2).
 * - stopped:  not spawned (initial / after stop())
 * - running:  child spawned, health pulse active
 * - backoff:  waiting out an exponential-backoff delay before respawn
 * - failed:   terminal — restart budget exhausted, no further auto-restart;
 *             a new SidecarManager instance is required to recover
 */
export type SidecarState = 'stopped' | 'running' | 'backoff' | 'failed'

/** Sidecar runtime status (returned by SidecarManager.getStatus()). */
export interface SidecarStatus {
  name: string
  running: boolean
  pid?: number
  /** Resolved listen port (equals config port unless preflight reallocated it). */
  port: number
  healthUrl: string
  failures: number
  restarts: number
  state: SidecarState
}

/** Lifecycle events emitted by SidecarManager.onSidecarEvent. */
export type SidecarEventType = 'restarting' | 'failed'
export type SidecarEventListener = (event: SidecarEventType, status: SidecarStatus) => void

/** Returns true when host:port is currently bindable (free). */
export type PortProbe = (host: string, port: number) => Promise<boolean>

/** Injection surface for SidecarManager (spawner/fetcher/probePort/fsDeps for Vitest). */
export type SidecarManagerOptions = {
  healthIntervalMs?: number
  maxFailures?: number
  maxRestarts?: number
  restartBaseMs?: number
  logDir?: string
  logMaxBytes?: number
  /** Dynamic reallocation range, default [20000, 30000]. */
  dynamicPortRange?: readonly [min: number, max: number]
  /** Override spawn for tests. Signature matches child_process.spawn. */
  spawner?: (bin: string, args: string[], opts: Record<string, unknown>) => ChildProcess
  /** Override fetch for tests. Return true if healthy. */
  fetcher?: (url: string) => Promise<boolean>
  /** Override port preflight probe for tests. Return true if the port is free. */
  probePort?: PortProbe
  /** Override fs deps for tests. */
  fsDeps?: LogFsDeps
}

function assertLocalHealthUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`healthUrl must be a valid URL, got: ${url}`)
  }
  if (u.hostname !== SIDECAR_HOST) {
    throw new Error(`healthUrl must be on ${SIDECAR_HOST}, got hostname=${u.hostname} url=${url}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`healthUrl must be http(s), got ${url}`)
  }
}

/** Boundary guard for ISidecar: throws on any contract violation. */
export function assertValidSidecarConfig(c: ISidecar): void {
  if (!c.name || !c.bin || !Array.isArray(c.args) || !c.port || !c.healthUrl) {
    throw new Error('ISidecar requires name, bin, args, port, healthUrl')
  }
  if (c.port < 1024 || c.port > 65535) throw new Error(`port out of range: ${c.port}`)
  assertLocalHealthUrl(c.healthUrl)
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
