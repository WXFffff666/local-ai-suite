/**
 * controller.ts — screenshot ask-overlay orchestration (todo38).
 *
 * State machine: idle → capturing (one desktopCapturer grab of the focused
 * display) → selecting (fullscreen transparent region overlay live) → idle.
 * Guards from the plan:
 *  - SINGLE overlay instance: re-trigger while open = close-and-restart;
 *  - BUSY while capture pending (a second press mid-grab is refused, not queued);
 *  - PRIVACY: the frame lives in memory only (this.frame) and is dropped on
 *    every terminal path (select / cancel / window closed) — never persisted;
 *  - Esc anywhere = 'overlay:cancel' invoke → same close path.
 *
 * Zero value-level Electron imports (handlers.test electron-mock precedent):
 * the screen/capturer/window seams arrive via OverlayControllerDeps; the real
 * bindings live in ./electronDeps.ts behind a lazy require factory. Coordinate
 * math is the unit-tested pure module ./scaleMath (shared with the renderer).
 * MIT only, no AGPL.
 */
import type {
  OverlayCancelReply,
  OverlayFrameReply,
  OverlaySelectReply,
  TestTriggerHotkeyReply,
} from '../ipc/whitelist'
import type { OverlaySelectInput } from '../ipc/schemas'
import { physicalSizeOf, pickDisplay, type DisplayGeom, type ScreenPoint } from './scaleMath'

/** Fixed combo (plan: enabled-flag configurable, combo deliberately not). */
export const SCREENSHOT_HOTKEY_ACCELERATOR = 'CommandOrControl+Shift+A'

export type OverlayControllerState = 'idle' | 'capturing' | 'selecting'

export type CapturedFrame = {
  dataURL: string
  /** DIP origin of the captured display (can be negative) — main-side only,
   *  used to position the overlay window; NEVER crosses the IPC wire. */
  bounds: { x: number; y: number }
  display: {
    width: number
    height: number
    scale: number
    physicalWidth: number
    physicalHeight: number
  }
}

export type OverlayWindowLike = {
  /** live webContents identity — every renderer-side verb must come from it
   *  (a dying overlay frame's late invoke must never tear down the restart). */
  readonly webContentsId: number
  show(): void
  focus(): void
  destroy(): void
  onClosed(cb: () => void): void
}

export type MainWindowLike = {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  sendAskSeed(payload: { image: string; prompt: string }): void
}

/** desktopCapturer source view (thumbnail is a native Image, dataURL via toDataURL). */
export type SourceLike = {
  display_id: string
  thumbnail: { toDataURL(): string }
}

export type OverlayControllerDeps = {
  getCursor(): ScreenPoint
  getDisplays(): DisplayGeom[]
  getSources(physical: { width: number; height: number }): Promise<SourceLike[]>
  /** Factory owns BrowserWindow construction + renderer load; controller owns lifecycle. */
  createOverlayWindow(frame: CapturedFrame): OverlayWindowLike
  getMainWindow(): MainWindowLike | null
  logWarn(message: string, error?: unknown): void
}

export class OverlayController {
  private readonly deps: OverlayControllerDeps
  private _state: OverlayControllerState = 'idle'
  private frame: CapturedFrame | null = null
  private win: OverlayWindowLike | null = null

  constructor(deps: OverlayControllerDeps) {
    this.deps = deps
  }

  get state(): OverlayControllerState {
    return this._state
  }

  isOpen(): boolean {
    return this.win !== null
  }

  /** Hotkey press. busy = capture in flight; while open the overlay is torn
   *  down and restarted fresh (single-instance guard). */
  async trigger(): Promise<TestTriggerHotkeyReply> {
    if (this._state === 'capturing') return { ok: false, error: 'busy' }
    this.closeWindow()
    this._state = 'capturing'
    try {
      const frame = await this.captureFrame()
      this.frame = frame
      const win = this.deps.createOverlayWindow(frame)
      this.win = win
      win.onClosed(() => {
        // External teardown (Alt+F4 / crash): the window is already gone —
        // drop the references WITHOUT destroy(). The identity guard makes the
        // closeWindow-initiated destroy (which fires this event too) a no-op.
        if (this.win === win) {
          this.win = null
          this.frame = null
          this._state = 'idle'
        }
      })
      win.show()
      win.focus()
      this._state = 'selecting'
      return { ok: true }
    } catch (error) {
      this.closeWindow()
      this.deps.logWarn('screenshot overlay capture failed', error)
      return { ok: false, error: 'capture-failed' }
    }
  }

  /** 'overlay:frame:get' — the renderer PULLS the frame on mount (deterministic;
   *  a webContents.send push could race its listener attach). Only the LIVE
   *  overlay frame may read the capture (sender guard). */
  getFrame(senderId?: number): OverlayFrameReply {
    if (!this.isOverlaySender(senderId)) return { ok: false, error: 'no-frame' }
    const frame = this.frame
    if (this._state !== 'selecting' || frame === null) return { ok: false, error: 'no-frame' }
    return {
      ok: true,
      dataURL: frame.dataURL,
      display: {
        width: frame.display.width,
        height: frame.display.height,
        scale: frame.display.scale,
        physicalWidth: frame.display.physicalWidth,
        physicalHeight: frame.display.physicalHeight,
      },
    }
  }

  /** Confirmed selection: drop the frame (privacy), close the overlay, then
   *  surface the main window and seed the VLM ask turn there. */
  select(input: OverlaySelectInput, senderId?: number): OverlaySelectReply {
    if (!this.isOverlaySender(senderId)) return { ok: false, error: 'no-overlay' }
    this.closeWindow()
    const main = this.deps.getMainWindow()
    if (main !== null && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore()
      main.show()
      main.focus()
      main.sendAskSeed({ image: input.dataURL, prompt: input.prompt })
    }
    return { ok: true }
  }

  /** Esc / stray-click cancel — frame and window both gone, nothing queued. */
  cancel(senderId?: number): OverlayCancelReply {
    if (!this.isOverlaySender(senderId)) return { ok: false, error: 'no-overlay' }
    this.closeWindow()
    return { ok: true }
  }

  /** Quit path: drop the overlay without touching the main window. */
  dispose(): void {
    this.closeWindow()
  }

  // --- internals -------------------------------------------------------------

  /** The sender guard: renderer verbs are only honored from the window the
   *  controller currently holds (kills stale-invoke races on restart). */
  private isOverlaySender(senderId: number | undefined): boolean {
    return this.win !== null && senderId !== undefined && this.win.webContentsId === senderId
  }

  private closeWindow(): void {
    const win = this.win
    this.win = null
    this.frame = null
    this._state = 'idle'
    win?.destroy()
  }

  private async captureFrame(): Promise<CapturedFrame> {
    const cursor = this.deps.getCursor()
    const display = pickDisplay(this.deps.getDisplays(), cursor)
    if (display === null) throw new Error('no display under cursor')
    const physical = physicalSizeOf(display)
    const sources = await this.deps.getSources(physical)
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
    if (source === undefined) throw new Error('desktopCapturer returned no screen source')
    return {
      dataURL: source.thumbnail.toDataURL(),
      bounds: { x: display.bounds.x, y: display.bounds.y },
      display: {
        width: display.bounds.width,
        height: display.bounds.height,
        scale: display.scaleFactor,
        physicalWidth: physical.width,
        physicalHeight: physical.height,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// pure window-options helper (unit-tested; the BrowserWindow itself is built
// in electronDeps.ts with these exact flags)
// ---------------------------------------------------------------------------

export type OverlayWindowOptions = {
  x: number
  y: number
  width: number
  height: number
  frame: false
  transparent: true
  alwaysOnTop: true
  resizable: false
  movable: false
  minimizable: false
  maximizable: false
  fullscreenable: false
  skipTaskbar: true
  show: false
  hasShadow: false
  backgroundColor: '#00000000'
  webPreferences: {
    preload: string
    sandbox: true
    contextIsolation: true
    nodeIntegration: false
    webSecurity: true
    allowRunningInsecureContent: false
  }
}

/** Fullscreen-over-one-display overlay geometry + the T3 security baseline. */
export function overlayWindowOptions(
  bounds: { x: number; y: number; width: number; height: number },
  preload: string,
): OverlayWindowOptions {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
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

// ---------------------------------------------------------------------------
// globalShortcut registration (deps-injected so unit tests never load electron)
// ---------------------------------------------------------------------------

export type HotkeyRegistry = {
  isRegistered(accelerator: string): boolean
  unregister(accelerator: string): void
  register(accelerator: string, action: () => void): boolean
}

/** Second-instance safety: index.ts only reaches here on the lock owner. */
export function registerScreenshotHotkey(
  registry: HotkeyRegistry,
  accelerator: string,
  onTrigger: () => void,
): boolean {
  try {
    if (registry.isRegistered(accelerator)) registry.unregister(accelerator)
    return registry.register(accelerator, onTrigger)
  } catch {
    return false
  }
}

export function unregisterScreenshotHotkey(registry: HotkeyRegistry, accelerator: string): void {
  try {
    if (registry.isRegistered(accelerator)) registry.unregister(accelerator)
  } catch {
    // best-effort teardown
  }
}
