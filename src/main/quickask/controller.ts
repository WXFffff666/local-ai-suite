/**
 * controller.ts — quick-ask mini chat window orchestration (todo41).
 *
 * Cherry-Studio 快捷助手 precedent: one global hotkey (Ctrl+Shift+Space)
 * conjures a frameless always-on-top 420x300 mini window. Lifecycle rules
 * mirrored from the todo38 OverlayController (same dep-injection discipline:
 * ZERO value-level electron imports — ./electronDeps.ts owns the real seams):
 *  - SINGLE window: created once, HIDDEN (never destroyed) on hide — re-show
 *    is instant and the in-memory history survives (renderer owns the list);
 *  - TOGGLE: a second hotkey press while visible hides it (连按不重复建窗);
 *  - POSITION: last window position remembered across hide/show and clamped
 *    into the current workArea (monitor unplug can never orphan the window);
 *  - PREFILL: at show time main reads clipboard text; non-empty and
 *    ≤ QUICKASK_CLIPBOARD_MAX_CHARS gates it (prefillFromClipboard, pure) —
 *    pushed as 'quickask:prefill' AND pullable via quickask:prefill:get
 *    (the mount-pull is the first-show race cover, overlay frame:get lesson);
 *  - SENDER GUARD: hide()/getPrefill() answer only for the LIVE mini window's
 *    webContents (overlay ipc.ts precedent).
 * The blur-grace hide (300ms, pointer re-enter cancels) lives in the RENDERER
 * (QuickAskApp): window blur + hover events are observable there, jsdom-fake-
 * timer testable there, and cross-platform there — main holds no timers.
 * The chat itself is EPHEMERAL: quickask:ask rides ChatRelay (same upstream as
 * chat:send) but nothing touches conversations:* — chat.db is never written.
 * MIT only, no AGPL.
 */
import type {
  QuickAskHideReply,
  QuickAskPrefillReply,
  TestTriggerHotkeyReply,
} from '../ipc/whitelist'

/** Fixed combo (plan: enabled-flag configurable, combo deliberately not). */
export const QUICKASK_HOTKEY_ACCELERATOR = 'CommandOrControl+Shift+Space'
/** Mini window size from the plan (~420x300). */
export const QUICKASK_WINDOW_SIZE = { width: 420, height: 300 } as const
/** Clipboard → prefill gate (mirrors the overlay prompt cap; oversized = ignored). */
export const QUICKASK_CLIPBOARD_MAX_CHARS = 2_000

export type WorkAreaRect = { x: number; y: number; width: number; height: number }

export type QuickAskWindowLike = {
  /** live webContents identity — hide/prefill verbs answer for it only. */
  readonly webContentsId: number
  isVisible(): boolean
  show(): void
  hide(): void
  focus(): void
  destroy(): void
  /** outer position in screen DIPs (position memory + clamp input). */
  getPosition(): { x: number; y: number }
  setPosition(x: number, y: number): void
  sendPrefill(text: string): void
  onClosed(cb: () => void): void
}

export type QuickAskControllerDeps = {
  /** Factory owns BrowserWindow construction + renderer load; controller owns lifecycle. */
  createWindow(bounds: { x: number; y: number; width: number; height: number }): QuickAskWindowLike
  /** Every display's workArea (DIP) — position clamp domain. */
  getWorkAreas(): WorkAreaRect[]
  /** electron clipboard.readText() seam; '' when the clipboard has no text. */
  readClipboard(): string
  logWarn(message: string, error?: unknown): void
}

// ---------------------------------------------------------------------------
// pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Clamp a top-left position so the window anchor stays inside some workArea:
 * if the remembered point sits in an area, clamp to that area; if no area
 * contains it (monitor unplugged), fall back to the primary area. null pos =
 * first summon → top-third horizontal center of the primary area.
 */
export function clampToWorkArea(
  pos: { x: number; y: number } | null,
  size: { width: number; height: number },
  areas: WorkAreaRect[],
): { x: number; y: number } {
  const primary = areas[0] as WorkAreaRect | undefined
  if (primary === undefined) return { x: 0, y: 0 }
  if (pos === null) {
    return {
      x: Math.round(primary.x + (primary.width - size.width) / 2),
      y: Math.round(primary.y + (primary.height - size.height) / 3),
    }
  }
  const area =
    areas.find((a) => pos.x >= a.x && pos.x <= a.x + a.width && pos.y >= a.y && pos.y <= a.y + a.height) ?? primary
  const maxX = area.x + Math.max(0, area.width - size.width)
  const maxY = area.y + Math.max(0, area.height - size.height)
  return {
    x: Math.min(Math.max(pos.x, area.x), maxX),
    y: Math.min(Math.max(pos.y, area.y), maxY),
  }
}

/** Clipboard → prefill gate: trimmed, non-empty, ≤ max chars — else null. */
export function prefillFromClipboard(clip: string, max: number = QUICKASK_CLIPBOARD_MAX_CHARS): string | null {
  const text = clip.trim()
  if (text.length === 0 || text.length > max) return null
  return text
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

export class QuickAskController {
  private readonly deps: QuickAskControllerDeps
  private win: QuickAskWindowLike | null = null
  /** remembered top-left across hide/show (position memory). */
  private lastPos: { x: number; y: number } | null = null

  constructor(deps: QuickAskControllerDeps) {
    this.deps = deps
  }

  isOpen(): boolean {
    return this.win !== null && this.win.isVisible()
  }

  /** Hotkey press — TOGGLE: visible hides, hidden/absent shows. A single
   *  BrowserWindow instance is reused forever (连按不重复建窗). */
  trigger(): TestTriggerHotkeyReply {
    try {
      if (this.win !== null && this.win.isVisible()) {
        this.hideWindow()
      } else {
        this.showWindow()
      }
      return { ok: true }
    } catch (error) {
      this.deps.logWarn('quick-ask window failed', error)
      return { ok: false, error: 'create-failed' }
    }
  }

  /** 'quickask:hide' — renderer Esc / blur-grace expiry. Sender-guarded. */
  hide(senderId?: number): QuickAskHideReply {
    if (!this.isQuickAskSender(senderId)) return { ok: false, error: 'no-window' }
    this.hideWindow()
    return { ok: true }
  }

  /** 'quickask:prefill:get' — the renderer PULLS the clipboard gate on mount
   *  (a freshly-created window's listener does not exist yet for the push;
   *  overlay frame:get pull precedent). Fresh read, sender-guarded. */
  getPrefill(senderId?: number): QuickAskPrefillReply {
    if (!this.isQuickAskSender(senderId)) return { ok: false, error: 'no-window' }
    return { ok: true, prefill: prefillFromClipboard(this.deps.readClipboard()) }
  }

  /** Quit path. */
  dispose(): void {
    const win = this.win
    this.win = null
    win?.destroy()
  }

  // --- internals -------------------------------------------------------------

  /** The sender guard: renderer verbs are only honored from the window the
   *  controller currently holds (kills stale-invoke races after Alt+F4). */
  private isQuickAskSender(senderId: number | undefined): boolean {
    return this.win !== null && senderId !== undefined && this.win.webContentsId === senderId
  }

  private showWindow(): void {
    if (this.win === null) {
      const pos = clampToWorkArea(this.lastPos, QUICKASK_WINDOW_SIZE, this.deps.getWorkAreas())
      const win = this.deps.createWindow({ ...pos, ...QUICKASK_WINDOW_SIZE })
      this.win = win
      win.onClosed(() => {
        // External teardown (Alt+F4 / crash): drop the reference WITHOUT
        // destroy(); the identity guard makes hideWindow's paths no-op here.
        if (this.win === win) this.win = null
      })
    } else {
      // Re-show: restore the remembered position, clamped into the CURRENT
      // workAreas (display topology may have changed since the last hide).
      const clamped = clampToWorkArea(this.lastPos, QUICKASK_WINDOW_SIZE, this.deps.getWorkAreas())
      this.win.setPosition(clamped.x, clamped.y)
    }
    this.win.show()
    this.win.focus()
    // Prefill on every show (the mount-pull covers the first-show race; this
    // push serves the re-show path where the renderer is long mounted).
    // Oversized/empty clipboard → no event at all (the plan's "else nothing").
    const prefill = prefillFromClipboard(this.deps.readClipboard())
    if (prefill !== null) this.win.sendPrefill(prefill)
  }

  private hideWindow(): void {
    const win = this.win
    if (win === null) return
    this.lastPos = win.getPosition()
    win.hide()
  }
}

// ---------------------------------------------------------------------------
// pure window-options helper (unit-tested; the BrowserWindow itself is built
// in electronDeps.ts with these exact flags)
// ---------------------------------------------------------------------------

export type QuickAskWindowOptions = {
  x: number
  y: number
  width: number
  height: number
  minWidth: number
  minHeight: number
  frame: false
  transparent: false
  alwaysOnTop: true
  resizable: true
  minimizable: false
  maximizable: false
  fullscreenable: false
  skipTaskbar: true
  show: false
  backgroundColor: '#0f0f0f'
  webPreferences: {
    preload: string
    sandbox: true
    contextIsolation: true
    nodeIntegration: false
    webSecurity: true
    allowRunningInsecureContent: false
  }
}

/** Mini-window chrome + the T3 security baseline (overlayWindowOptions parity). */
export function quickAskWindowOptions(
  bounds: { x: number; y: number; width: number; height: number },
  preload: string,
): QuickAskWindowOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 320,
    minHeight: 200,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  }
}
