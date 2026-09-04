/**
 * controller.test.ts — todo41 quick-ask lifecycle against FAKE windows/seams
 * (no Electron in the value graph — the controller is dep-injected by design,
 * overlay/controller.test.ts precedent). Plan guards pinned here:
 *  - toggle: press → show; press again while visible → hide (连按不重复建窗 —
 *    the SAME window instance is reused, createWindow runs exactly once);
 *  - hide-to-memory: hide() never destroys (history survives the hide);
 *  - position memory + workArea clamp (monitor-unplug orphan guard);
 *  - clipboard prefill gate: non-empty ≤2000 → push/pull; empty/oversized →
 *    nothing (the plan's "else nothing");
 *  - SENDER guard: a stale webContents cannot hide or pull the live window;
 *  - external close (Alt+F4) resets via the identity-guarded onClosed hook.
 */
import { describe, expect, it } from 'vitest'
import {
  QuickAskController,
  clampToWorkArea,
  prefillFromClipboard,
  quickAskWindowOptions,
  QUICKASK_CLIPBOARD_MAX_CHARS,
  QUICKASK_HOTKEY_ACCELERATOR,
  QUICKASK_WINDOW_SIZE,
  type QuickAskControllerDeps,
  type QuickAskWindowLike,
  type WorkAreaRect,
} from './controller'

let windowIdSeq = 1

class FakeWindow implements QuickAskWindowLike {
  readonly webContentsId = windowIdSeq++
  visible = false
  destroyed = 0
  focuses = 0
  position = { x: 0, y: 0 }
  prefills: string[] = []
  closedCbs: Array<() => void> = []
  isVisible(): boolean {
    return this.visible
  }
  show(): void {
    this.visible = true
  }
  hide(): void {
    this.visible = false
  }
  focus(): void {
    this.focuses += 1
  }
  destroy(): void {
    this.destroyed += 1
    for (const cb of this.closedCbs) cb()
  }
  getPosition(): { x: number; y: number } {
    return { ...this.position }
  }
  setPosition(x: number, y: number): void {
    this.position = { x, y }
  }
  sendPrefill(text: string): void {
    this.prefills.push(text)
  }
  onClosed(cb: () => void): void {
    this.closedCbs.push(cb)
  }
}

const AREA_MAIN: WorkAreaRect = { x: 0, y: 0, width: 1920, height: 1040 }
const AREA_SECOND: WorkAreaRect = { x: 1920, y: 200, width: 1280, height: 1020 }

function makeDeps(overrides: Partial<QuickAskControllerDeps> = {}) {
  const windows: FakeWindow[] = []
  const deps: QuickAskControllerDeps = {
    createWindow: (bounds) => {
      const w = new FakeWindow()
      w.setPosition(bounds.x, bounds.y)
      windows.push(w)
      return w
    },
    getWorkAreas: () => [AREA_MAIN, AREA_SECOND],
    readClipboard: () => '',
    logWarn: () => undefined,
    ...overrides,
  }
  const liveId = (): number => (windows[windows.length - 1] as FakeWindow).webContentsId
  return { deps, windows, liveId }
}

describe('QuickAskController.trigger — toggle + single window', () => {
  it('first press creates + shows + focuses the mini window at the clamped default spot', () => {
    const { deps, windows, liveId } = makeDeps()
    const c = new QuickAskController(deps)
    expect(c.trigger()).toEqual({ ok: true })
    expect(windows).toHaveLength(1)
    const w = windows[0] as FakeWindow
    expect(w.visible).toBe(true)
    expect(w.focuses).toBe(1)
    expect(c.isOpen()).toBe(true)
    expect(liveId()).toBeGreaterThan(0)
  })

  it('second press while visible HIDES (toggle) — third press re-shows the SAME window', () => {
    const { deps, windows } = makeDeps()
    const c = new QuickAskController(deps)
    c.trigger() // show
    c.trigger() // toggle → hide
    expect((windows[0] as FakeWindow).visible).toBe(false)
    expect(c.isOpen()).toBe(false)
    c.trigger() // show again
    expect(windows).toHaveLength(1) // 连按不重复建窗 — one instance forever
    expect((windows[0] as FakeWindow).visible).toBe(true)
    expect((windows[0] as FakeWindow).destroyed).toBe(0)
  })

  it('hide-to-memory: trigger-hide never destroys the window (instant re-show, history alive)', () => {
    const { deps, windows } = makeDeps()
    const c = new QuickAskController(deps)
    c.trigger()
    c.trigger()
    const w = windows[0] as FakeWindow
    expect(w.destroyed).toBe(0)
    expect(w.visible).toBe(false)
  })

  it('position memory: remembered across hide/show and clamped into the CURRENT workAreas', () => {
    const { deps, windows } = makeDeps()
    const c = new QuickAskController(deps)
    c.trigger()
    const w = windows[0] as FakeWindow
    // user drags onto the second monitor, then Esc-hides
    w.setPosition(2500, 900)
    c.trigger() // hide (remembers 2500,900)
    c.trigger() // re-show → restored (inside second area: maxY 1220-300 → 900 fits)
    expect(w.position).toEqual({ x: 2500, y: 900 })
  })

  it('monitor unplug orphan guard: remembered offscreen position clamps back into a live area', () => {
    const { deps, windows, liveId } = makeDeps()
    const c = new QuickAskController(deps)
    c.trigger()
    const w = windows[0] as FakeWindow
    w.setPosition(9999, 9999) // beyond every area (as if the second monitor vanished)
    c.hide(liveId())
    c.trigger() // re-show clamps into the primary area
    const clamped = clampToWorkArea({ x: 9999, y: 9999 }, QUICKASK_WINDOW_SIZE, [AREA_MAIN])
    expect(w.position).toEqual(clamped)
    expect(w.position.x + QUICKASK_WINDOW_SIZE.width).toBeLessThanOrEqual(AREA_MAIN.x + AREA_MAIN.width)
  })

  it('window factory throw → honest create-failed reply, no half-held window', () => {
    const { deps } = makeDeps({
      createWindow: () => {
        throw new Error('display gone')
      },
    })
    const c = new QuickAskController(deps)
    expect(c.trigger()).toEqual({ ok: false, error: 'create-failed' })
    expect(c.isOpen()).toBe(false)
  })

  it('external close (Alt+F4) resets via the identity-guarded onClosed — a stale window close cannot clear a new one', () => {
    const { deps, windows, liveId } = makeDeps()
    const c = new QuickAskController(deps)
    c.trigger()
    const first = windows[0] as FakeWindow
    first.destroy() // fires closedCbs outside any controller path
    expect(c.isOpen()).toBe(false)
    c.trigger() // fresh window
    expect(windows).toHaveLength(2)
    const live = liveId()
    expect(c.isOpen()).toBe(true)
    // the OLD closed callback already ran; firing it again must not drop the NEW window
    expect(c.hide(live)).toEqual({ ok: true })
  })
})

describe('QuickAskController — sender guard (hide / prefill)', () => {
  it('hide from a stale webContents is refused and does NOT touch the live window', () => {
    const { deps, windows, liveId } = makeDeps()
    const c = new QuickAskController(deps)
    const stale = ((): number => {
      c.trigger()
      const id = liveId()
      c.dispose() // Alt+F4 equivalent → next trigger builds a NEW window
      c.trigger()
      return id
    })()
    expect((windows[0] as FakeWindow).destroyed).toBe(1)
    expect(c.isOpen()).toBe(true)
    expect(c.hide(stale)).toEqual({ ok: false, error: 'no-window' })
    expect(c.isOpen(), 'stale hide must not touch the live window').toBe(true)
  })

  it('undefined senderId fails closed; no window at all → no-window', () => {
    const { deps } = makeDeps()
    const c = new QuickAskController(deps)
    expect(c.hide()).toEqual({ ok: false, error: 'no-window' })
    expect(c.getPrefill()).toEqual({ ok: false, error: 'no-window' })
    c.trigger()
    expect(c.hide()).toEqual({ ok: false, error: 'no-window' })
  })

  it('getPrefill pulls fresh clipboard text only for the live window', () => {
    const { deps, liveId } = makeDeps({ readClipboard: () => '  提取这段  ' })
    const c = new QuickAskController(deps)
    c.trigger()
    expect(c.getPrefill(liveId())).toEqual({ ok: true, prefill: '提取这段' })
    expect(c.getPrefill(liveId() + 777)).toEqual({ ok: false, error: 'no-window' })
  })
})

describe('QuickAskController — clipboard prefill gate', () => {
  it('show with valid clipboard text pushes ONE quickask:prefill', () => {
    const { deps, windows } = makeDeps({ readClipboard: () => '剪贴板问题？' })
    const c = new QuickAskController(deps)
    c.trigger()
    expect((windows[0] as FakeWindow).prefills).toEqual(['剪贴板问题？'])
  })

  it('empty / whitespace / oversized clipboard → NOTHING pushed (plan else-nothing)', () => {
    for (const clip of ['', '   ', 'x'.repeat(QUICKASK_CLIPBOARD_MAX_CHARS + 1)]) {
      const { deps, windows } = makeDeps({ readClipboard: () => clip })
      const c = new QuickAskController(deps)
      c.trigger()
      expect((windows[0] as FakeWindow).prefills).toEqual([])
    }
  })

  it('exactly-at-cap text passes the gate', () => {
    const text = 'y'.repeat(QUICKASK_CLIPBOARD_MAX_CHARS)
    const { deps, windows } = makeDeps({ readClipboard: () => text })
    const c = new QuickAskController(deps)
    c.trigger()
    expect((windows[0] as FakeWindow).prefills).toEqual([text])
  })

  it('re-show pushes the CURRENT clipboard again (fresh read, not the stale first one)', () => {
    let clip = '第一次'
    const { deps, windows, liveId } = makeDeps({ readClipboard: () => clip })
    const c = new QuickAskController(deps)
    c.trigger()
    c.hide(liveId())
    clip = '第二次'
    c.trigger()
    expect((windows[0] as FakeWindow).prefills).toEqual(['第一次', '第二次'])
  })
})

describe('clampToWorkArea — pure geometry', () => {
  it('null position centers horizontally on the primary area, upper third', () => {
    expect(clampToWorkArea(null, QUICKASK_WINDOW_SIZE, [AREA_MAIN])).toEqual({
      x: Math.round((1920 - 420) / 2),
      y: Math.round((1040 - 300) / 3),
    })
  })

  it('clamps an overflowing point to the containing area edges', () => {
    const p = clampToWorkArea({ x: 1900, y: 1100 }, QUICKASK_WINDOW_SIZE, [AREA_MAIN])
    expect(p.x).toBe(AREA_MAIN.width - QUICKASK_WINDOW_SIZE.width)
    expect(p.y).toBe(AREA_MAIN.height - QUICKASK_WINDOW_SIZE.height)
  })

  it('a point inside the second area clamps to THAT area, not the primary', () => {
    const p = clampToWorkArea({ x: 3200, y: 1100 }, QUICKASK_WINDOW_SIZE, [AREA_MAIN, AREA_SECOND])
    expect(p.x).toBe(AREA_SECOND.x + AREA_SECOND.width - QUICKASK_WINDOW_SIZE.width)
    expect(p.y).toBe(AREA_SECOND.y + AREA_SECOND.height - QUICKASK_WINDOW_SIZE.height)
  })

  it('no areas at all → origin fallback, never a throw', () => {
    expect(clampToWorkArea({ x: 5, y: 5 }, QUICKASK_WINDOW_SIZE, [])).toEqual({ x: 0, y: 0 })
  })
})

describe('prefillFromClipboard — pure gate', () => {
  it('trims; empty/whitespace/oversized → null; cap-length passes', () => {
    expect(prefillFromClipboard('  hi \n')).toBe('hi')
    expect(prefillFromClipboard('')).toBeNull()
    expect(prefillFromClipboard(' \t')).toBeNull()
    expect(prefillFromClipboard('z'.repeat(QUICKASK_CLIPBOARD_MAX_CHARS))).toHaveLength(QUICKASK_CLIPBOARD_MAX_CHARS)
    expect(prefillFromClipboard('z'.repeat(QUICKASK_CLIPBOARD_MAX_CHARS + 1))).toBeNull()
  })
})

describe('quickAskWindowOptions — plan flags (frameless/alwaysOnTop/skipTaskbar + T3 baseline)', () => {
  const opts = quickAskWindowOptions({ x: 100, y: 200, width: 420, height: 300 }, '/p/preload.js')

  it('mini-window chrome (frame:false, skipTaskbar, alwaysOnTop, show:false)', () => {
    expect(opts).toMatchObject({
      x: 100,
      y: 200,
      width: 420,
      height: 300,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
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

  it('fixed combo (enabled-flag configurable, combo not)', () => {
    expect(QUICKASK_HOTKEY_ACCELERATOR).toBe('CommandOrControl+Shift+Space')
  })
})
