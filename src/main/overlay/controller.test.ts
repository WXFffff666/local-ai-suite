/**
 * controller.test.ts — todo38 overlay lifecycle against FAKE windows/seams
 * (no Electron in the value graph — the controller is dep-injected by design).
 * Covers the plan guards: single instance (double-trigger = close-and-restart),
 * busy-during-capture, Esc/cancel teardown, min-rect is the renderer's gate
 * (schema-tested separately), frames never persist (memory-only + dropped),
 * and the SENDER guard: a dying overlay frame's late invoke must never tear
 * down the restarted overlay (e2e-caught race, pinned here).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OverlayController,
  overlayWindowOptions,
  registerScreenshotHotkey,
  unregisterScreenshotHotkey,
  SCREENSHOT_HOTKEY_ACCELERATOR,
  type OverlayControllerDeps,
  type OverlayWindowLike,
} from './controller'
import type { OverlaySelectInput } from '../ipc/schemas'

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let windowIdSeq = 1

class FakeWindow implements OverlayWindowLike {
  readonly webContentsId = windowIdSeq++
  destroyed = 0
  shown = 0
  focused = 0
  closedCbs: Array<() => void> = []
  show(): void {
    this.shown += 1
  }
  focus(): void {
    this.focused += 1
  }
  destroy(): void {
    this.destroyed += 1
    for (const cb of this.closedCbs) cb()
  }
  onClosed(cb: () => void): void {
    this.closedCbs.push(cb)
  }
}

class FakeMain {
  minimized = false
  destroyed = false
  focuses = 0
  seeds: Array<{ image: string; prompt: string }> = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  show(): void {}
  focus(): void {
    this.focuses += 1
  }
  sendAskSeed(payload: { image: string; prompt: string }): void {
    this.seeds.push(payload)
  }
}

const DISPLAY_125 = { id: 2, bounds: { x: -1536, y: -100, width: 1536, height: 864 }, scaleFactor: 1.25 }

function makeDeps(overrides: Partial<OverlayControllerDeps> = {}) {
  const windows: FakeWindow[] = []
  const main = new FakeMain()
  let captureHold: (() => void) | null = null
  const deps: OverlayControllerDeps = {
    getCursor: () => ({ x: -1000, y: 0 }),
    getDisplays: () => [DISPLAY_125],
    getSources: async () => {
      if (captureHold !== null) {
        await new Promise<void>((resolve) => {
          captureHold = resolve
        })
      }
      return [{ display_id: '2', thumbnail: { toDataURL: () => TINY_PNG } }]
    },
    createOverlayWindow: () => {
      const w = new FakeWindow()
      windows.push(w)
      return w
    },
    getMainWindow: () => main as unknown as ReturnType<OverlayControllerDeps['getMainWindow']>,
    logWarn: () => undefined,
    ...overrides,
  }
  const liveId = (): number => (windows[windows.length - 1] as FakeWindow).webContentsId
  return {
    deps,
    windows,
    main,
    liveId,
    holdCapture: (): void => {
      captureHold = () => undefined
    },
    releaseCapture: (): void => {
      const g = captureHold
      captureHold = null
      g?.()
    },
  }
}

const SELECT_INPUT: OverlaySelectInput = {
  rect: { x: 10, y: 20, width: 200, height: 100 },
  dataURL: TINY_PNG,
  prompt: '解释这张图',
}

describe('OverlayController.trigger', () => {
  it('happy path — captures the display under the cursor, opens the overlay, frame is pullable with 125% display info', async () => {
    const { deps, liveId } = makeDeps()
    const c = new OverlayController(deps)
    await expect(c.trigger()).resolves.toEqual({ ok: true })
    expect(c.state).toBe('selecting')
    expect(c.isOpen()).toBe(true)
    expect(c.getFrame(liveId())).toEqual({
      ok: true,
      dataURL: TINY_PNG,
      display: { width: 1536, height: 864, scale: 1.25, physicalWidth: 1920, physicalHeight: 1080 },
    })
  })

  it('busy guard — second press while capture pending is refused, first one still completes', async () => {
    const { deps, windows, holdCapture, releaseCapture } = makeDeps()
    holdCapture()
    const c = new OverlayController(deps)
    const first = c.trigger()
    await expect(c.trigger()).resolves.toEqual({ ok: false, error: 'busy' })
    expect(c.state).toBe('capturing')
    expect(windows).toHaveLength(0)
    releaseCapture()
    await expect(first).resolves.toEqual({ ok: true })
    expect(windows).toHaveLength(1)
  })

  it('single instance — re-trigger while open destroys the old window and restarts fresh', async () => {
    const { deps, windows } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    const first = windows[0] as FakeWindow
    await c.trigger()
    expect(first.destroyed).toBe(1)
    expect(windows).toHaveLength(2)
    expect(c.isOpen()).toBe(true)
    expect(c.state).toBe('selecting')
  })

  it('capture failure (no screen source) — state resets to idle, nothing left open, honest error', async () => {
    const { deps } = makeDeps({ getSources: async () => [] })
    const c = new OverlayController(deps)
    await expect(c.trigger()).resolves.toEqual({ ok: false, error: 'capture-failed' })
    expect(c.state).toBe('idle')
    expect(c.isOpen()).toBe(false)
    expect(c.getFrame(1)).toEqual({ ok: false, error: 'no-frame' })
  })

  it('capture failure (no display at all) — same reset path', async () => {
    const { deps } = makeDeps({ getDisplays: () => [] })
    const c = new OverlayController(deps)
    await expect(c.trigger()).resolves.toEqual({ ok: false, error: 'capture-failed' })
    expect(c.state).toBe('idle')
  })

  it('source display_id mismatch falls back to the first source (single-screen quirk)', async () => {
    const { deps, liveId } = makeDeps({
      getSources: async () => [{ display_id: '999', thumbnail: { toDataURL: () => TINY_PNG } }],
    })
    const c = new OverlayController(deps)
    await c.trigger()
    expect(c.getFrame(liveId()).ok).toBe(true)
  })
})

describe('OverlayController.select / cancel — teardown, seeding, sender guard', () => {
  it('select closes the overlay, focuses the (restored) main window and emits ONE ask:seed', async () => {
    const { deps, windows, main, liveId } = makeDeps()
    main.minimized = true
    const c = new OverlayController(deps)
    await c.trigger()
    expect(c.select(SELECT_INPUT, liveId())).toEqual({ ok: true })
    const win = windows[0] as FakeWindow
    expect(win.destroyed).toBe(1)
    expect(main.minimized).toBe(false)
    expect(main.focuses).toBe(1)
    expect(main.seeds).toEqual([{ image: TINY_PNG, prompt: '解释这张图' }])
    expect(c.state).toBe('idle')
    expect(c.isOpen()).toBe(false)
  })

  it('privacy — after select the frame is dropped from memory (getFrame no-frame; no persistence seam exists at all)', async () => {
    const { deps, liveId } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    expect((c.getFrame(liveId()) as { dataURL?: string }).dataURL).toBe(TINY_PNG)
    c.select(SELECT_INPUT, liveId())
    expect(c.getFrame(liveId())).toEqual({ ok: false, error: 'no-frame' })
  })

  it('cancel closes the overlay WITHOUT seeding', async () => {
    const { deps, windows, main, liveId } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    expect(c.cancel(liveId())).toEqual({ ok: true })
    expect((windows[0] as FakeWindow).destroyed).toBe(1)
    expect(main.seeds).toHaveLength(0)
    expect(c.state).toBe('idle')
  })

  it('SENDER guard — a stale overlay frame cannot pull, select or cancel the live one (close-and-restart race, e2e-caught)', async () => {
    const { deps, windows, liveId } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    const staleId = (windows[0] as FakeWindow).webContentsId
    await c.trigger() // close-and-restart → windows[1] is live
    const live = liveId()
    expect(staleId).not.toBe(live)
    expect(c.getFrame(staleId)).toEqual({ ok: false, error: 'no-frame' })
    expect(c.select(SELECT_INPUT, staleId)).toEqual({ ok: false, error: 'no-overlay' })
    expect(c.cancel(staleId)).toEqual({ ok: false, error: 'no-overlay' })
    // the live overlay survived the stale barrage — and its own cancel works
    expect(c.isOpen()).toBe(true)
    expect(c.getFrame(live).ok).toBe(true)
    expect(c.cancel(live)).toEqual({ ok: true })
  })

  it('undefined senderId (no ctx plumbing) fails closed — never a privileged default', async () => {
    const { deps } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    expect(c.getFrame()).toEqual({ ok: false, error: 'no-frame' })
    expect(c.select(SELECT_INPUT)).toEqual({ ok: false, error: 'no-overlay' })
    expect(c.cancel()).toEqual({ ok: false, error: 'no-overlay' })
  })

  it('select/cancel with no live overlay — honest no-overlay, no phantom seed', () => {
    const { deps, main } = makeDeps()
    const c = new OverlayController(deps)
    expect(c.select(SELECT_INPUT, 999)).toEqual({ ok: false, error: 'no-overlay' })
    expect(c.cancel(999)).toEqual({ ok: false, error: 'no-overlay' })
    expect(main.seeds).toHaveLength(0)
  })

  it('destroyed main window — select still closes the overlay, seed skipped without throwing', async () => {
    const { deps, windows, main, liveId } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    main.destroyed = true
    expect(c.select(SELECT_INPUT, liveId())).toEqual({ ok: true })
    expect((windows[0] as FakeWindow).destroyed).toBe(1)
    expect(main.seeds).toHaveLength(0)
  })

  it('external window close (Alt+F4) resets state via the onClosed hook (identity-guarded)', async () => {
    const { deps, windows, liveId } = makeDeps()
    const c = new OverlayController(deps)
    await c.trigger()
    const win = windows[0] as FakeWindow
    const id = liveId()
    win.destroy() // fires closedCbs outside closeWindow — the controller must adopt it
    expect(c.state).toBe('idle')
    expect(c.isOpen()).toBe(false)
    expect(c.getFrame(id)).toEqual({ ok: false, error: 'no-frame' })
    // and a stale select afterwards is the honest no-overlay, not a double destroy
    expect(c.select(SELECT_INPUT, id)).toEqual({ ok: false, error: 'no-overlay' })
    expect(win.destroyed).toBe(1)
  })

  it('dispose is idempotent — repeat calls after teardown change nothing', async () => {
    const { deps } = makeDeps()
    const c = new OverlayController(deps)
    c.dispose()
    await c.trigger()
    c.dispose()
    c.dispose()
    expect(c.state).toBe('idle')
  })
})

describe('overlayWindowOptions — plan flags (frameless/transparent/alwaysOnTop/skipTaskbar + T3 baseline)', () => {
  const opts = overlayWindowOptions({ x: -1536, y: -100, width: 1536, height: 864 }, '/p/preload.js')

  it('covers the display bounds including negative origins', () => {
    expect(opts.x).toBe(-1536)
    expect(opts.y).toBe(-100)
    expect(opts.width).toBe(1536)
    expect(opts.height).toBe(864)
  })

  it('overlay chrome flags', () => {
    expect(opts).toMatchObject({
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      show: false,
    })
  })

  it('inherits the T3 webPreferences baseline (sandbox + contextIsolation, no node)', () => {
    expect(opts.webPreferences).toMatchObject({
      preload: '/p/preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    })
  })
})

describe('hotkey registration (injected registry)', () => {
  it('fixed accelerator default is Ctrl+Shift+A', () => {
    expect(SCREENSHOT_HOTKEY_ACCELERATOR).toBe('CommandOrControl+Shift+A')
  })

  it('replaces a stale registration before binding the trigger action', () => {
    const calls: string[] = []
    const ok = registerScreenshotHotkey(
      {
        isRegistered: () => true,
        unregister: (a) => calls.push(`unregister:${a}`),
        register: (a) => {
          calls.push(`register:${a}`)
          return true
        },
      },
      SCREENSHOT_HOTKEY_ACCELERATOR,
      () => undefined,
    )
    expect(ok).toBe(true)
    expect(calls).toEqual(['unregister:CommandOrControl+Shift+A', 'register:CommandOrControl+Shift+A'])
  })

  it('register false (combo taken by another app) is surfaced, not swallowed; throwing registry degrades to false', () => {
    const taken = registerScreenshotHotkey(
      { isRegistered: () => false, unregister: vi.fn(), register: () => false },
      SCREENSHOT_HOTKEY_ACCELERATOR,
      () => undefined,
    )
    expect(taken).toBe(false)
    const boom = registerScreenshotHotkey(
      {
        isRegistered: () => {
          throw new Error('not ready')
        },
        unregister: vi.fn(),
        register: vi.fn(),
      },
      'x',
      () => undefined,
    )
    expect(boom).toBe(false)
    expect(() =>
      unregisterScreenshotHotkey(
        {
          isRegistered: () => true,
          unregister: () => {
            throw new Error('gone')
          },
          register: vi.fn(),
        },
        'x',
      ),
    ).not.toThrow()
  })
})
