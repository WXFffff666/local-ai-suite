/**
 * electronDeps.ts — the REAL Electron bindings behind the todo38 overlay
 * controller. Split from controller.ts so the controller (+ its unit suite)
 * never carries electron in its value graph (learnings.md electron-mock
 * precedent: handlers.ts keeps updater behind a type-only import for the same
 * reason). Every electron access goes through the lazy require() below and is
 * only invoked from src/main/index.ts after app.whenReady.
 *
 * Capture policy (plan): ONE desktopCapturer.getSources call upfront in main
 * sized to the display's PHYSICAL pixels; the frame crosses to the overlay
 * renderer exactly once via the 'overlay:frame:get' pull and is dropped from
 * memory on every terminal path. The LAS_E2E_FAKE_CAPTURE seam (testSupport)
 * swaps in a fixed 1x1 PNG so the e2e drives the whole flow without touching
 * the real screen (plan acceptance: "e2e(mock capturer)").
 * MIT only, no AGPL.
 */
import type { BrowserWindow } from 'electron'
import { assertAllowedEventChannel } from '../ipc/whitelist'
import {
  overlayWindowOptions,
  type CapturedFrame,
  type MainWindowLike,
  type OverlayControllerDeps,
  type OverlayWindowLike,
  type SourceLike,
} from './controller'

/** 1x1 opaque PNG — the fake-capturer frame (e2e only; deterministic bytes). */
export const FAKE_CAPTURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

type ElectronRuntime = {
  screen: {
    getCursorScreenPoint(): { x: number; y: number }
    getAllDisplays(): Array<{ id: number; bounds: { x: number; y: number; width: number; height: number }; scaleFactor: number }>
  }
  desktopCapturer: {
    getSources(opts: { types: ['screen']; thumbnailSize: { width: number; height: number } }): Promise<SourceLike[]>
  }
  BrowserWindow: typeof BrowserWindow
}

function electronRuntime(): ElectronRuntime {
  // Lazy require: vitest node env and preload-graph consumers never execute this.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as unknown as ElectronRuntime
}

export type ElectronOverlayOpts = {
  /** testSupport seam (LAS_E2E_FAKE_CAPTURE) — never true in production. */
  fakeCapture: boolean
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  /** dev ELECTRON_RENDERER_URL (loaded with #/overlay) — undefined in prod. */
  rendererUrl: string | undefined
  /** built renderer index.html — prod loadFile target (hash /overlay). */
  rendererFile: string
}

export function createElectronOverlayDeps(opts: ElectronOverlayOpts): OverlayControllerDeps {
  const wrapWindow = (win: BrowserWindow): OverlayWindowLike => ({
    get webContentsId() {
      return win.isDestroyed() ? -1 : win.webContents.id
    },
    show: () => win.show(),
    focus: () => win.focus(),
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    },
    onClosed: (cb) => {
      win.on('closed', cb)
    },
  })

  const wrapMain = (win: BrowserWindow): MainWindowLike => ({
    isDestroyed: () => win.isDestroyed(),
    isMinimized: () => win.isMinimized(),
    restore: () => win.restore(),
    show: () => win.show(),
    focus: () => win.focus(),
    sendAskSeed: (payload) => {
      assertAllowedEventChannel('ask:seed')
      if (!win.isDestroyed()) win.webContents.send('ask:seed', payload)
    },
  })

  return {
    getCursor: () => electronRuntime().screen.getCursorScreenPoint(),
    getDisplays: () =>
      electronRuntime()
        .screen.getAllDisplays()
        .map((d) => ({ id: d.id, bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }, scaleFactor: d.scaleFactor })),
    getSources: async (physical) => {
      if (opts.fakeCapture) {
        // display_id '' forces the controller's documented first-source fallback.
        return [{ display_id: '', thumbnail: { toDataURL: () => FAKE_CAPTURE_PNG } }]
      }
      return electronRuntime().desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical })
    },
    createOverlayWindow: (frame: CapturedFrame): OverlayWindowLike => {
      const { BrowserWindow: BW } = electronRuntime()
      const win = new BW(
        overlayWindowOptions({ x: frame.bounds.x, y: frame.bounds.y, width: frame.display.width, height: frame.display.height }, opts.preloadPath),
      )
      // Above every ordinary window (region capture covers fullscreen apps too).
      win.setAlwaysOnTop(true, 'screen-saver')
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      if (opts.rendererUrl !== undefined) {
        void win.loadURL(`${opts.rendererUrl}#/overlay`)
      } else {
        void win.loadFile(opts.rendererFile, { hash: '/overlay' })
      }
      return wrapWindow(win)
    },
    getMainWindow: () => {
      const win = opts.getMainWindow()
      return win === null ? null : wrapMain(win)
    },
    logWarn: (_message, _error) => {
      // index.ts passes its own sink through OverlayControllerDeps override;
      // this default stays silent so nothing logs before bootstrap wires it.
    },
  }
}
