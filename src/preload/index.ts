import { contextBridge, ipcRenderer } from 'electron'
import { ALLOWED_CHANNELS, assertAllowedChannel, isAllowedChannel } from '../main/ipc/whitelist'
import type { AllowedChannel } from '../main/ipc/whitelist'

// Preload security baseline (T3):
// - Only ALLOWED channels may be invoked. Any other channel throws.
// - Do NOT expose ipcRenderer directly (no full ipcRenderer exposure).
// - contextBridge is the sole bridge to the renderer.

export type WindowApi = {
  /** Invoke a whitelisted IPC channel (args forwarded to ipcRenderer.invoke). */
  invoke: (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>
  /** Read-only list of allowed channels (for UI/debug). */
  allowedChannels: readonly string[]
  // Legacy helpers retained for smoke test compatibility
  ping: () => string
  versions: () => NodeJS.ProcessVersions
}

const api: WindowApi = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => {
    assertAllowedChannel(channel)
    // Defense in depth: double-check before invoking
    if (!isAllowedChannel(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  allowedChannels: ALLOWED_CHANNELS,
  ping: () => 'pong',
  versions: () => process.versions
}

// Expose only the curated api — never ipcRenderer itself.
contextBridge.exposeInMainWorld('api', api)

export { ALLOWED_CHANNELS }
