/**
 * W1-8 preload tests — the renderer bridge surface. vi.mock('electron') is
 * hoisted per project convention: contextBridge capture + fake ipcRenderer.
 * Proves 双端拒绝 (renderer-side gate mirrors the main-side one) and that
 * on/once/off are gated by the EVENT allowlist, never exposing ipcRenderer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const captured: { api?: Record<string, unknown> } = {}
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()
  return {
    captured,
    listeners,
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, obj: unknown) => {
        if (name === 'api') captured.api = obj as Record<string, unknown>
      })
    },
    ipcRenderer: {
      invoke: vi.fn(async (_channel: string, ..._args: unknown[]): Promise<unknown> => ({ from: 'main' })),
      on: vi.fn((channel: string, cb: (event: unknown, payload: unknown) => void) => {
        const set = listeners.get(channel) ?? new Set()
        listeners.set(channel, set)
        set.add(cb)
      }),
      removeListener: vi.fn((channel: string, cb: (event: unknown, payload: unknown) => void) => {
        listeners.get(channel)?.delete(cb)
      })
    }
  }
})

vi.mock('electron', () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer
}))

import { ALLOWED_EVENT_CHANNELS } from '../main/ipc/whitelist'

type EventApi = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (payload: never) => void) => () => void
  once: (channel: string, listener: (payload: never) => void) => void
  off: (channel: string, listener: (payload: never) => void) => void
  allowedChannels: readonly string[]
  allowedEventChannels: readonly string[]
}

let api: EventApi

function fire(channel: string, payload: unknown): void {
  for (const cb of mocks.listeners.get(channel) ?? []) cb({ sender: {} }, payload)
}

beforeEach(async () => {
  vi.resetModules()
  mocks.listeners.clear()
  vi.clearAllMocks()
  await import('./index')
  api = mocks.captured.api as unknown as EventApi
})

describe('preload invoke gate', () => {
  it('allowed channel forwards to ipcRenderer.invoke', async () => {
    await expect(api.invoke('models:list')).resolves.toEqual({ from: 'main' })
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('models:list')
  })

  it('channel outside the invoke whitelist throws (never reaches main)', () => {
    expect(() => api.invoke('shell:exec', 'calc.exe')).toThrow(/not allowed/)
    expect(mocks.ipcRenderer.invoke).not.toHaveBeenCalled()
  })

  it('event channels are NOT invokable — separate lists', () => {
    expect(() => api.invoke('chat:delta', { id: 'x', delta: 'y' })).toThrow(/not allowed/)
  })

  it('allowedChannels includes the W1-8 additions + todo30b engine channels (auto passthrough)', () => {
    for (const ch of [
      'gallery:list',
      'search:run',
      'hf:search',
      'image:queue:status',
      'chat:abort',
      'conversations:list',
      // todo30b: whitelist is the single source — new channels pass through with no preload edits
      'engines:status',
      'engines:gpuDownload',
      'models:launch',
    ]) {
      expect(api.allowedChannels).toContain(ch)
    }
    // invoke passthrough reaches ipcRenderer for the new channels
    void api.invoke('engines:status', {})
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('engines:status', {})
  })
})

describe('preload event subscription gate', () => {
  it('exposes the exact event whitelist and never raw ipcRenderer', () => {
    expect(api.allowedEventChannels).toEqual(ALLOWED_EVENT_CHANNELS)
    expect(mocks.captured.api).not.toHaveProperty('ipcRenderer')
  })

  it('on() rejects unlisted event channels on the renderer side too', () => {
    expect(() => api.on('evil:event', () => undefined)).toThrow(/not allowed/)
    expect(mocks.ipcRenderer.on).not.toHaveBeenCalled()
  })

  it('on() delivers payloads and the returned unsubscribe removes the listener', () => {
    const seen: unknown[] = []
    const off = api.on('chat:delta', ((p: unknown) => seen.push(p)) as (payload: never) => void)
    fire('chat:delta', { id: 's1', delta: 'tok' })
    expect(seen).toEqual([{ id: 's1', delta: 'tok' }])
    off()
    fire('chat:delta', { id: 's1', delta: 'again' })
    expect(seen).toHaveLength(1)
  })

  it("todo30b: 'engines:progress' is subscribable (event whitelist passthrough)", () => {
    const seen: unknown[] = []
    api.on('engines:progress', ((p: unknown) => seen.push(p)) as (payload: never) => void)
    fire('engines:progress', { engine: 'llama', variant: 'cuda', received: 1, total: 2, state: 'downloading' })
    expect(seen).toEqual([{ engine: 'llama', variant: 'cuda', received: 1, total: 2, state: 'downloading' }])
  })

  it('once() fires exactly one delivery', () => {
    const seen: unknown[] = []
    api.once('download:progress', ((p: unknown) => seen.push(p)) as (payload: never) => void)
    fire('download:progress', { id: 'd' })
    fire('download:progress', { id: 'd' })
    expect(seen).toEqual([{ id: 'd' }])
  })

  it('off() removes a previously registered listener', () => {
    const listener = (() => undefined) as (payload: never) => void
    api.on('image:queue:status', listener)
    api.off('image:queue:status', listener)
    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith('image:queue:status', expect.any(Function))
    expect(mocks.listeners.get('image:queue:status')?.size ?? 0).toBe(0)
  })
})
