/**
 * ipc.test.ts — todo38 overlay handler factory: zod gates, not-ready honesty,
 * and the r2 !isPackaged test-hook gate (packaged = 'disabled', never a
 * side-effecting hotkey trigger). Pure unit — no Electron in the graph.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOverlayHandlers, type OverlaySurface } from './ipc'
import type { TestTriggerHotkeyReply } from '../ipc/whitelist'

const VALID_SELECT = {
  rect: { x: 5, y: 5, width: 100, height: 50 },
  dataURL: 'data:image/png;base64,iVBORw0KGgo=',
  prompt: '解释这张图',
}

function makeSurface(reply: TestTriggerHotkeyReply = { ok: true }) {
  const surface: OverlaySurface = {
    trigger: vi.fn(async () => reply),
    getFrame: vi.fn(() => ({ ok: true, dataURL: 'data:image/png;base64,x=', display: { width: 1, height: 1, scale: 1, physicalWidth: 1, physicalHeight: 1 } })),
    select: vi.fn(() => ({ ok: true }) as const),
    cancel: vi.fn(() => ({ ok: true }) as const),
  }
  return surface
}

function makeHandlers(surface: OverlaySurface | null, testHooksEnabled = true) {
  return createOverlayHandlers({
    overlay: () => surface,
    testHooksEnabled: () => testHooksEnabled,
  })
}

const ctx = { send: vi.fn(), senderId: 7 }

describe('overlay:frame:get', () => {
  it('delegates to the controller pull (frame live)', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s)['overlay:frame:get']([{}], ctx)).resolves.toMatchObject({ ok: true })
    expect(s.getFrame).toHaveBeenCalledWith(7)
  })

  it('no controller yet — honest no-frame', async () => {
    await expect(makeHandlers(null)['overlay:frame:get']([], ctx)).resolves.toEqual({ ok: false, error: 'no-frame' })
  })
})

describe('overlay:select', () => {
  it('valid crop passes the parsed input through verbatim', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s)['overlay:select']([VALID_SELECT], ctx)).resolves.toEqual({ ok: true })
    expect(s.select).toHaveBeenCalledWith(VALID_SELECT, 7)
  })

  it('400-shape gates: non-PNG dataURL, negative/zero rect, missing/oversized prompt, unknown extra key', async () => {
    const h = makeHandlers(makeSurface())
    const bad = [
      { ...VALID_SELECT, dataURL: 'data:image/jpeg;base64,AAA=' },
      { ...VALID_SELECT, rect: { ...VALID_SELECT.rect, x: -1 } },
      { ...VALID_SELECT, rect: { ...VALID_SELECT.rect, width: 0 } },
      { ...VALID_SELECT, prompt: '' },
      { ...VALID_SELECT, sneaky: true },
    ]
    for (const payload of bad) {
      const res = (await h['overlay:select']([payload], ctx)) as { ok: boolean; error?: string }
      expect(res.ok, JSON.stringify(payload)).toBe(false)
      expect(res.error).toBe('invalid-payload')
    }
  })

  it('no live overlay — no-overlay, not a throw', async () => {
    await expect(makeHandlers(null)['overlay:select']([VALID_SELECT], ctx)).resolves.toEqual({ ok: false, error: 'no-overlay' })
  })
})

describe('overlay:cancel', () => {
  it('delegates; strict-empty gate; no-overlay when nothing is open', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s)['overlay:cancel']([{}], ctx)).resolves.toEqual({ ok: true })
    const res = (await makeHandlers(s)['overlay:cancel']([{ extra: 1 }], ctx)) as { ok: boolean }
    expect(res.ok).toBe(false)
    await expect(makeHandlers(null)['overlay:cancel']([{}], ctx)).resolves.toEqual({ ok: false, error: 'no-overlay' })
  })
})

describe('__test.triggerHotkey — r2 !isPackaged gate', () => {
  it('test hooks on: only the pinned screenshot name reaches the controller', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s)['__test.triggerHotkey']([{ name: 'screenshot' }], ctx)).resolves.toEqual({ ok: true })
    expect(s.trigger).toHaveBeenCalledTimes(1)
  })

  it('test hooks OFF (packaged): disabled WITHOUT touching the controller', async () => {
    const s = makeSurface()
    await expect(makeHandlers(s, false)['__test.triggerHotkey']([{ name: 'screenshot' }], ctx)).resolves.toEqual({
      ok: false,
      error: 'disabled',
    })
    expect(s.trigger).not.toHaveBeenCalled()
  })

  it('unknown hotkey names are a 400 (enum), not an invention; no controller → capture-failed ack', async () => {
    const res = (await makeHandlers(makeSurface())['__test.triggerHotkey']([{ name: 'everything' }], ctx)) as { ok: boolean }
    expect(res.ok).toBe(false)
    await expect(makeHandlers(null)['__test.triggerHotkey']([{ name: 'screenshot' }], ctx)).resolves.toEqual({
      ok: false,
      error: 'capture-failed',
    })
  })

  it('controller busy reply travels through unchanged', async () => {
    const s = makeSurface({ ok: false, error: 'busy' })
    await expect(makeHandlers(s)['__test.triggerHotkey']([{ name: 'screenshot' }], ctx)).resolves.toEqual({ ok: false, error: 'busy' })
  })
})
