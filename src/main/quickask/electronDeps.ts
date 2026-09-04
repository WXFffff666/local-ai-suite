/**
 * electronDeps.ts — the REAL Electron bindings behind the todo41 quick-ask
 * controller (overlay/electronDeps.ts precedent: lazy require('electron') so
 * the controller + its unit suite never carry electron in the value graph).
 * Invoked only from src/main/index.ts after app.whenReady.
 *
 * The mini window loads the SAME renderer bundle at '#/quickask' (todo38's
 * multi-entry reality: one index.html, hash-branched in main.tsx — no second
 * electron-vite entry). Deltas stream in on the quickask:* event channels via
 * ctx.send (invoke from this frame returns to this frame); prefill arrives via
 * the 'quickask:prefill' event push and the 'quickask:prefill:get' pull twin.
 * The blur-grace hide is RENDERER-side (QuickAskApp) — main keeps no focus
 * listeners and no timers. The LAS_E2E_FAKE_CLIPBOARD seam (testSupport)
 * swaps the real clipboard for fixed text so the e2e drives prefill
 * deterministically.
 * MIT only, no AGPL.
 */
import type { BrowserWindow } from 'electron'
import { assertAllowedEventChannel } from '../ipc/whitelist'
import {
  quickAskWindowOptions,
  type QuickAskControllerDeps,
  type QuickAskWindowLike,
  type WorkAreaRect,
} from './controller'

type ElectronRuntime = {
  screen: {
    getAllDisplays(): Array<{ workArea: WorkAreaRect }>
  }
  clipboard: { readText(): string }
  BrowserWindow: typeof BrowserWindow
}

function electronRuntime(): ElectronRuntime {
  // Lazy require: vitest node env and preload-graph consumers never execute this.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron') as unknown as ElectronRuntime
}

export type ElectronQuickAskOpts = {
  /** testSupport seam (LAS_E2E_FAKE_CLIPBOARD) — never true in production. */
  fakeClipboard: boolean
  /** fixed prefill text served when fakeClipboard is on (e2e determinism). */
  fakeClipboardText?: string
  preloadPath: string
  /** dev ELECTRON_RENDERER_URL (loaded with #/quickask) — undefined in prod. */
  rendererUrl: string | undefined
  /** built renderer index.html — prod loadFile target (hash /quickask). */
  rendererFile: string
}

export function createElectronQuickAskDeps(opts: ElectronQuickAskOpts): QuickAskControllerDeps {
  const wrapWindow = (win: BrowserWindow): QuickAskWindowLike => ({
    get webContentsId() {
      return win.isDestroyed() ? -1 : win.webContents.id
    },
    isVisible: () => !win.isDestroyed() && win.isVisible(),
    show: () => win.show(),
    hide: () => win.hide(),
    focus: () => win.focus(),
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    },
    getPosition: () => {
      const [x, y] = win.getPosition()
      return { x, y }
    },
    setPosition: (x, y) => win.setPosition(x, y),
    sendPrefill: (text) => {
      assertAllowedEventChannel('quickask:prefill')
      if (!win.isDestroyed()) win.webContents.send('quickask:prefill', { text })
    },
    onClosed: (cb) => win.on('closed', cb),
  })

  return {
    createWindow: (bounds) => {
      const { BrowserWindow: BW } = electronRuntime()
      const win = new BW(quickAskWindowOptions(bounds, opts.preloadPath))
      // Launcher posture: above ordinary windows, below the screen-saver level
      // the todo38 region overlay reserves.
      win.setAlwaysOnTop(true, 'floating')
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      if (opts.rendererUrl !== undefined) {
        void win.loadURL(`${opts.rendererUrl}#/quickask`)
      } else {
        void win.loadFile(opts.rendererFile, { hash: '/quickask' })
      }
      return wrapWindow(win)
    },
    getWorkAreas: () =>
      electronRuntime()
        .screen.getAllDisplays()
        .map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height })),
    readClipboard: () => {
      if (opts.fakeClipboard) return opts.fakeClipboardText ?? ''
      return electronRuntime().clipboard.readText()
    },
    logWarn: (_message, _error) => {
      // index.ts overrides this sink; silent default before bootstrap wires it.
    },
  }
}
