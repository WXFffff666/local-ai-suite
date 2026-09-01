import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { assertAllowedEventChannel, isAllowedChannel, type AllowedChannel, type AllowedEventChannel } from './ipc/whitelist'
import { buildIpcHandlers, toImageQueueStatusEvent, type HandlerContext } from './ipc/handlers'
import { ChatRelay } from './ipc/chatRelay'
import { DownloadManager } from './ipc/downloadManager'
import { searchHF } from '../market/hf'
import { getMainLogger, registerGlobalErrorLogging } from './logger'
import { shutdownServices, type ShutdownResult } from './shutdown'
import { getServices, initServices } from './services'

/**
 * Sidecar host — all local sidecars (LLM / embedding / image / search)
 * MUST bind to 127.0.0.1 only, never 0.0.0.0. This constant and the comments
 * below serve as the in-code contract for that invariant.
 */
export const SIDECAR_HOST = '127.0.0.1' as const

app.enableSandbox()

// --- Lifecycle hardening (audit W0-1) --------------------------------------
// Fatal process errors must land in the rolling main log before the default
// terminal semantics run (uncaughtException -> flush -> exit(1); see logger.ts).
registerGlobalErrorLogging({
  getLogger: getMainLogger,
  exit: (code: number): void => {
    app.exit(code)
  }
})

// Single-instance lock: a second launch asks the FIRST instance to surface its
// window via 'second-instance' and this duplicate process quits immediately.
const ownsInstanceLock = app.requestSingleInstanceLock()
if (!ownsInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })
}

let mainWindow: BrowserWindow | null = null

/** Restore/show/focus the primary window (used by second-instance + activate). */
function focusMainWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security baseline (T3): 5 flags
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })

  // Deny all permission requests (camera, mic, geolocation, etc.)
  // Must be set on the window's session after BrowserWindow creation.
  const targetSession = mainWindow.webContents.session
  targetSession.setPermissionRequestHandler(() => false)
  // Also deny permission checks (e.g. navigator.permissions.query)
  targetSession.setPermissionCheckHandler(() => false)

  // Window open handler: deny popups / new windows (prevent window.open abuse)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Broadcast an allow-listed event to every live renderer frame (app-wide events:
// download progress, image-queue status, notifications). Per-session chat
// events are NOT broadcast here — they go only to the sending frame via ctx.send.
export function broadcastEvent(channel: AllowedEventChannel, payload: unknown): void {
  assertAllowedEventChannel(channel)
  for (const win of BrowserWindow.getAllWindows()) {
    const contents = win.webContents
    if (!contents.isDestroyed()) contents.send(channel, payload)
  }
}

// Whitelisted IPC handlers — only ALLOWED channels are registered. Each handler
// validates the channel again via isAllowedChannel for defense in depth, and is
// given a per-frame `send` gated by the event whitelist (chat relay streaming).
// Sidecar calls originating from these handlers must use SIDECAR_HOST (127.0.0.1).
function registerIpcHandlers(): void {
  const services = getServices()

  const relay = new ChatRelay({
    services: () => ({ ensureSidecar: (name) => services.ensureSidecar(name) })
    // getEngineOwnership is wired by todo10; absent ⇒ internal llama-server only
    // (the embedded 11434 facade does not exist yet, so there is no self-loop).
  })
  const downloads = new DownloadManager({ emit: (event) => broadcastEvent('download:progress', event) })

  const handlers = buildIpcHandlers({
    services,
    relay,
    downloads,
    hfSearch: searchHF,
    dialog,
    safeStorage
  })

  for (const [channel, fn] of Object.entries(handlers) as [AllowedChannel, (typeof handlers)[AllowedChannel]][]) {
    // Defensive: skip if somehow not in whitelist (should never happen)
    if (!isAllowedChannel(channel)) continue
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      // Re-validate channel at invoke time as well
      if (!isAllowedChannel(channel)) throw new Error(`IPC channel not allowed: ${channel}`)
      const ctx: HandlerContext = {
        send: (eventChannel, payload) => {
          assertAllowedEventChannel(eventChannel)
          const sender = event.sender
          if (!sender.isDestroyed()) sender.send(eventChannel, payload)
        }
      }
      return fn(args, ctx)
    })
  }

  // image:queue:status EVENT variant — pump the queue's own events to all frames.
  services.imageQueue.subscribe((ev) => {
    broadcastEvent('image:queue:status', toImageQueueStatusEvent(ev))
  })
}

app.whenReady().then(() => {
  // Service container (todo7): lazy — spawns nothing; watch + handshake start
  // here. Created BEFORE the handlers so the singleton carries the logger sink
  // (initServices returns the same instance getServices() will hand out).
  initServices({
    warn: (message, error) => {
      getMainLogger().warn({ err: error }, `[services] ${message}`)
    }
  }).catch((error: unknown) => {
    getMainLogger().error({ err: error }, 'services container init failed')
  })
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitCleanupComplete = false

function recordShutdownFailures(result: ShutdownResult): void {
  for (const failure of result.errors) {
    getMainLogger().error(
      { err: failure.reason, hookIndex: failure.hookIndex, timeoutMs: failure.timeoutMs },
      'shutdown hook failed'
    )
  }
}

// Quit cleanup: hold the first quit long enough to stop every registered service
// (shutdownServices bounds each hook with a 3s timeout, so this can never hang
// forever), then re-quit. will-quit is the safety net for exotic quit paths.
app.on('before-quit', (event) => {
  if (quitCleanupComplete) return
  event.preventDefault()
  void shutdownServices()
    .then(recordShutdownFailures)
    .catch((error: unknown) => {
      // Last-resort sink: if the file logger itself failed while quitting,
      // stderr is all that is left (matches this file's console.* precedent).
      console.error('[shutdown] cleanup did not complete cleanly:', error)
    })
    .finally(() => {
      quitCleanupComplete = true
      app.quit()
    })
})

app.on('will-quit', () => {
  // Idempotent: on the normal path the hooks already ran and this is a no-op.
  void shutdownServices()
    .then(recordShutdownFailures)
    .catch((error: unknown) => {
      console.error('[shutdown] cleanup did not complete cleanly:', error)
    })
})
