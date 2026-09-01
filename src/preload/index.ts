import { contextBridge, ipcRenderer } from 'electron'
import {
  ALLOWED_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  assertAllowedChannel,
  assertAllowedEventChannel,
  isAllowedChannel,
  type AllowedEventChannel,
  type EventPayloads
} from '../main/ipc/whitelist'
import type { AllowedChannel } from '../main/ipc/whitelist'

// Preload security baseline (T3 + W1-8):
// - Invoke: only ALLOWED_CHANNELS; any other channel throws (renderer-side gate;
//   the main side re-validates at registration — 双端拒绝).
// - Events: ONLY the separate ALLOWED_EVENT_CHANNELS list is subscribable via
//   on/once/off. The renderer never receives a raw ipcRenderer.

type Listener<C extends AllowedEventChannel> = (payload: EventPayloads[C]) => void
type WrappedListener = (event: unknown, payload: unknown) => void

/** original listener -> wrapped ipcRenderer listener, per channel. */
const wrappedListeners = new Map<AllowedEventChannel, Map<object, WrappedListener>>()

// The payload cast below is the single erasure point of this registry: ipc
// payloads cross the boundary untyped, senders construct them from the
// EventPayloads contract (main-side handlers, gated by assertAllowedEventChannel).
function wrap<C extends AllowedEventChannel>(channel: C, listener: Listener<C>, once: boolean): WrappedListener {
  const wrapped: WrappedListener = (_event: unknown, payload: unknown) => {
    if (once) removeWrapped(channel, listener)
    listener(payload as EventPayloads[C])
  }
  let perChannel = wrappedListeners.get(channel)
  if (!perChannel) {
    perChannel = new Map()
    wrappedListeners.set(channel, perChannel)
  }
  perChannel.set(listener as object, wrapped)
  return wrapped
}

function removeWrapped<C extends AllowedEventChannel>(channel: C, listener: Listener<C>): void {
  const perChannel = wrappedListeners.get(channel)
  const wrapped = perChannel?.get(listener as object)
  if (perChannel && wrapped) {
    ipcRenderer.removeListener(channel, wrapped)
    perChannel.delete(listener as object)
  }
}

export type WindowApi = {
  /** Invoke a whitelisted IPC channel (args forwarded to ipcRenderer.invoke). */
  invoke: (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>
  /** Subscribe to a whitelisted main->renderer event; returns unsubscribe. */
  on: <C extends AllowedEventChannel>(channel: C, listener: Listener<C>) => () => void
  /** One-shot variant of on(). */
  once: <C extends AllowedEventChannel>(channel: C, listener: Listener<C>) => void
  /** Remove a listener previously passed to on/once. */
  off: <C extends AllowedEventChannel>(channel: C, listener: Listener<C>) => void
  /** Read-only lists (for UI/debug + e2e assertions). */
  allowedChannels: readonly string[]
  allowedEventChannels: readonly string[]
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
  on: <C extends AllowedEventChannel>(channel: C, listener: Listener<C>): (() => void) => {
    assertAllowedEventChannel(channel)
    ipcRenderer.on(channel, wrap(channel, listener, false))
    return () => removeWrapped(channel, listener)
  },
  once: <C extends AllowedEventChannel>(channel: C, listener: Listener<C>): void => {
    assertAllowedEventChannel(channel)
    ipcRenderer.on(channel, wrap(channel, listener, true))
  },
  off: <C extends AllowedEventChannel>(channel: C, listener: Listener<C>): void => {
    assertAllowedEventChannel(channel)
    removeWrapped(channel, listener)
  },
  allowedChannels: ALLOWED_CHANNELS,
  allowedEventChannels: ALLOWED_EVENT_CHANNELS,
  ping: () => 'pong',
  versions: () => process.versions
}

// Expose only the curated api — never ipcRenderer itself.
contextBridge.exposeInMainWorld('api', api)

export { ALLOWED_CHANNELS, ALLOWED_EVENT_CHANNELS }
