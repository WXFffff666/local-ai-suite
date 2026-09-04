/**
 * ipc.test.ts — todo41 quickask handler factory: the SHARED-ASK proof (the
 * relay's chat:* emissions arrive re-labeled to quickask:* through the SAME
 * ChatRelay seam chat:send uses), zod gates, sender-guarded not-ready honesty,
 * and the r2 !isPackaged gate on the '__test.triggerHotkey' quickask lane.
 * Pure unit — no Electron in the graph (overlay/ipc.test.ts precedent).
 */
import { describe, expect, it, vi } from 'vitest'
import { createQuickAskHandlers, remapStreamSend } from './ipc'
import type { IpcSendFn } from '../ipc/whitelist'

const VALID_ASK = {
  id: 'a_1',
  model: 'local',
  messages: [{ role: 'user', content: '快速问题' }],
}

function makeSurface() {
  return {
    trigger: vi.fn(() => ({ ok: true }) as const),
    hide: vi.fn(() => ({ ok: true }) as const),
    getPrefill: vi.fn(() => ({ ok: true, prefill: 'clip' }) as const),
  }
}

function makeHandlers(surface: ReturnType<typeof makeSurface> | null, testHooksEnabled = true, relayStart = vi.fn(() => ({ ok: true, id: 'a_1', streaming: true }) as const)) {
  const relay = { start: relayStart }
  const handlers = createQuickAskHandlers({
    quickask: () => surface,
    relay,
    testHooksEnabled: () => testHooksEnabled,
  })
  return { handlers, relay, relayStart: relayStart }
}

const ctx = { send: vi.fn(), senderId: 7 }

describe('quickask:ask — the shared ask path (ChatRelay.start, chat:send semantics)', () => {
  it('valid chat payload reaches the relay with ctx.send stream-remapped', async () => {
    const relayStart = vi.fn(() => ({ ok: true, id: 'a_1', streaming: true }) as const)
    const { handlers } = makeHandlers(makeSurface(), true, relayStart)
    await expect(handlers['quickask:ask']([VALID_ASK], ctx)).resolves.toEqual({ ok: true, id: 'a_1', streaming: true })
    expect(relayStart).toHaveBeenCalledTimes(1)
    const [data, send] = relayStart.mock.calls[0] as [unknown, IpcSendFn]
    expect(data).toEqual(VALID_ASK)
    // the relay emits chat:* — the wrapper must re-label to quickask:* and
    // deliver through the SAME frame-bound send (mini window only).
    send('chat:delta', { id: 'a_1', delta: 'x' })
    expect(ctx.send).toHaveBeenCalledWith('quickask:delta', { id: 'a_1', delta: 'x' })
  })

  it('400-shape gates mirror chat:send exactly (empty messages, unknown role, bad id)', async () => {
    const { handlers, relayStart } = makeHandlers(makeSurface())
    const bad = [
      { ...VALID_ASK, messages: [] },
      { ...VALID_ASK, messages: [{ role: 'wizard', content: 'x' }] },
      { id: '', model: 'local', messages: [] },
      { id: 'a_2', model: '', messages: [{ role: 'user', content: 'x' }] },
    ]
    for (const payload of bad) {
      const res = (await handlers['quickask:ask']([payload], ctx)) as { ok: boolean; error?: string }
      expect(res.ok, JSON.stringify(payload)).toBe(false)
      expect(res.error).toBe('invalid-payload')
    }
    expect(relayStart).not.toHaveBeenCalled()
  })
})

describe('remapStreamSend — exhaustive chat:* → quickask:* table', () => {
  it('relabels the three stream channels; anything else passes through untouched', () => {
    const send = vi.fn() as unknown as IpcSendFn
    const mapped = remapStreamSend(send)
    mapped('chat:delta', 1)
    mapped('chat:done', 2)
    mapped('chat:error', 3)
    mapped('app:notification', 4)
    expect(send).toHaveBeenNthCalledWith(1, 'quickask:delta', 1)
    expect(send).toHaveBeenNthCalledWith(2, 'quickask:done', 2)
    expect(send).toHaveBeenNthCalledWith(3, 'quickask:error', 3)
    expect(send).toHaveBeenNthCalledWith(4, 'app:notification', 4)
  })
})

describe('quickask:hide / quickask:prefill:get — sender-guarded controller verbs', () => {
  it('hide delegates with the caller senderId (controller decides liveness)', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s).handlers['quickask:hide']([{}], ctx)).resolves.toEqual({ ok: true })
    expect(s.hide).toHaveBeenCalledWith(7)
  })

  it('prefill pull delegates with the caller senderId', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s).handlers['quickask:prefill:get']([{}], ctx)).resolves.toEqual({ ok: true, prefill: 'clip' })
    expect(s.getPrefill).toHaveBeenCalledWith(7)
  })

  it('no controller yet — honest no-window (not a throw)', async () => {
    const { handlers } = makeHandlers(null)
    await expect(handlers['quickask:hide']([{}], ctx)).resolves.toEqual({ ok: false, error: 'no-window' })
    await expect(handlers['quickask:prefill:get']([{}], ctx)).resolves.toEqual({ ok: false, error: 'no-window' })
  })

  it('strict-empty payload gates (stray key → 400-shape)', async () => {
    const { handlers } = makeHandlers(makeSurface())
    const res = (await handlers['quickask:hide']([{ extra: 1 }], ctx)) as { ok: boolean }
    expect(res.ok).toBe(false)
  })
})

describe('__test.triggerHotkey — quickask lane of the shared r2 hook', () => {
  it('test hooks on: name quickask reaches the quickask controller trigger', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s).handlers['__test.triggerHotkey']([{ name: 'quickask' }], ctx)).resolves.toEqual({ ok: true })
    expect(s.trigger).toHaveBeenCalledTimes(1)
  })

  it('test hooks OFF (packaged): disabled WITHOUT touching the controller', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s, false).handlers['__test.triggerHotkey']([{ name: 'quickask' }], ctx)).resolves.toEqual({
      ok: false,
      error: 'disabled',
    })
    expect(s.trigger).not.toHaveBeenCalled()
  })

  it('unknown names 400 (enum is the single dispatch table); no controller → create-failed', async () => {
    const res = (await makeHandlers(makeSurface()).handlers['__test.triggerHotkey']([{ name: 'everything' }], ctx)) as { ok: boolean }
    expect(res.ok).toBe(false)
    await expect(makeHandlers(null).handlers['__test.triggerHotkey']([{ name: 'quickask' }], ctx)).resolves.toEqual({
      ok: false,
      error: 'create-failed',
    })
  })
})
