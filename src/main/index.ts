import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { assertAllowedEventChannel, isAllowedChannel, type AllowedChannel, type AllowedEventChannel } from './ipc/whitelist'
import { buildIpcHandlers, toImageQueueStatusEvent, type HandlerContext } from './ipc/handlers'
import { ChatRelay } from './ipc/chatRelay'
import { DownloadManager } from './ipc/downloadManager'
import { searchHF } from '../market/hf'
import { getMainLogger, registerGlobalErrorLogging } from './logger'
import { registerShutdownHook, shutdownServices, type ShutdownResult } from './shutdown'
import { getServices, initServices, SIDECAR_NAMES, type SidecarName } from './services'
import { createUpdater, scheduleInitialUpdateCheck, type Updater } from './updater'
import { E2E_FAKE_CAPTURE, E2E_FAKE_CLIPBOARD, E2E_FAKE_CLIPBOARD_TEXT, UPDATE_CHECK_DISABLED } from './testSupport'
import { startApiServer, ENGINE_MIN_OLLAMA_VERSION, type ApiServerStatus } from './apiServer'
import { canGrantMediaPermission, originFromDetails } from './mediaPermissions'
import { createConversationService } from './storage/conversations'
import { createAgentMain } from './agentMain'
import { TrayController } from './tray'
// todo38: screenshot ask-overlay (global hotkey → region select → VLM chat).
import { getConfig } from './storage/config'
import {
  OverlayController,
  registerScreenshotHotkey,
  unregisterScreenshotHotkey,
  SCREENSHOT_HOTKEY_ACCELERATOR,
} from './overlay/controller'
import { createElectronOverlayDeps } from './overlay/electronDeps'
// todo41: quick-ask mini chat window (global Ctrl+Shift+Space, ephemeral chat).
// Hotkey register/unregister are the todo38 generic accelerator-keyed helpers
// (imported with neutral aliases — same single-registration semantics reused).
import {
  registerScreenshotHotkey as registerGlobalHotkey,
  unregisterScreenshotHotkey as unregisterGlobalHotkey,
} from './overlay/controller'
import { QuickAskController, QUICKASK_HOTKEY_ACCELERATOR } from './quickask/controller'
import { createElectronQuickAskDeps } from './quickask/electronDeps'
import type { SidecarManager } from '../core/SidecarManager'
import type { SidecarStatus } from '../core/types'

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

// --- todo38: screenshot ask-overlay controller --------------------------------
// Constructed in bootstrapOverlay() (after whenReady — globalShortcut/screen
// require a ready app). The single-instance-lock gate above means a SECOND
// process quits before ever reaching here, so the hotkey is only ever bound
// by the lock owner. Handlers answer the honest not-ready shapes until then.
let overlayController: OverlayController | null = null

// --- todo41: quick-ask mini chat window controller ----------------------------
// Same construction discipline as the overlay: built in bootstrapQuickAsk()
// after whenReady, hotkey binding config-gated (quickaskHotkeyEnabled), the
// controller itself always live so '__test.triggerHotkey' {name:'quickask'}
// works with the user hotkey disabled (r2 e2e hook parity with todo38).
let quickAskController: QuickAskController | null = null

// --- W1-10: embedded API server state + tray ---------------------------------
// The arbitration result lives in a mutable ref so BOTH the tray (status line,
// tooltip) and the chat relay (getEngineOwnership — two-legal-source upstream
// rule) can read it lazily, long after bootstrap ordering details settle.
const apiStatusRef: { current: ApiServerStatus | null } = { current: null }
let trayController: TrayController | null = null

// --- todo32: auto-updater singleton ------------------------------------------
// Constructed lazily on first handler registration (construction only sets
// electron-updater flags + listeners — zero I/O). The first NETWORK touch is
// the 5s-deferred check scheduled after whenReady, gated by isPackaged and
// the LAS_DISABLE_UPDATE_CHECK kill switch (testSupport.ts): e2e / dev
// launches never dial out, so the zero-external-requests invariant holds.
let updaterInstance: Updater | null = null

function getUpdater(): Updater {
  updaterInstance ??= createUpdater({
    emit: (state) => broadcastEvent('update:state', state),
    log: getMainLogger()
  })
  return updaterInstance
}

/** One-line human description of the 11434 ownership state (tray + logs). */
export function describeApiStatus(s: ApiServerStatus | null): string {
  if (s === null) return 'API :11434 仲裁中…'
  switch (s.mode) {
    case 'embedded':
      return 'API :11434 内置服务运行中'
    case 'external-takeover':
      return s.degraded
        ? `API :11434 外部引擎 ${s.version ?? '未知版本'} 低于安全基线 ${ENGINE_MIN_OLLAMA_VERSION} — 请升级`
        : `API :11434 外部引擎接管${s.version ? ` (${s.version})` : ''}`
    case 'conflict':
      return 'API :11434 端口冲突，服务未启动（端口固定，绝不换口）'
    default: {
      const unreachable: never = s.mode
      throw new Error(`unknown api mode: ${String(unreachable)}`)
    }
  }
}

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

  // W1-10 baseline was deny-all. todo36 widens it ONLY for microphone
  // capture (getUserMedia audio) from the app's own origin — the decision
  // table is the unit-tested pure function in ./mediaPermissions. Everything
  // else (geolocation, clipboard, display-capture, foreign origins) keeps the
  // deny, and the media toggle-off in Settings additionally hides the UI entry
  // point (defense in depth: the permission gate is origin-scoped, not a
  // feature switch).
  const targetSession = mainWindow.webContents.session
  targetSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const d = details as { requestingOrigin?: string; mediaTypes?: readonly string[] } | undefined
    callback(
      canGrantMediaPermission({
        permission,
        requestingOrigin: d?.requestingOrigin,
        mediaTypes: d?.mediaTypes,
        rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      })
    )
  })
  // Permission CHECKS (navigator.permissions.query etc.) carry no mediaTypes:
  // same origin gate, same deny-by-default.
  targetSession.setPermissionCheckHandler((_wc, permission, details) =>
    canGrantMediaPermission({
      permission,
      requestingOrigin: originFromDetails(details),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
    })
  )

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

// Deliver a main->renderer event to the focused window, falling back to the
// primary window (permission prompts + streamed shell output follow the UI
// that is actually visible — plan 29 "no unattended background" posture).

// Whitelisted IPC handlers — only ALLOWED channels are registered. Each handler
// validates the channel again via isAllowedChannel for defense in depth, and is
// given a per-frame `send` gated by the event whitelist (chat relay streaming).
// Sidecar calls originating from these handlers must use SIDECAR_HOST (127.0.0.1).
function registerIpcHandlers(): void {
  const services = getServices()

  const relay = new ChatRelay({
    services: () => ({ ensureSidecar: (name) => services.ensureSidecar(name) }),
    // W1-10 arbitration: 'external-takeover' is the ONLY situation where the
    // relay dials 11434; otherwise the internal llama-server on its resolved
    // dynamic port. The embedded facade is never self-called (no loop).
    getEngineOwnership: () => {
      const s = apiStatusRef.current
      // carry the arbitrated port so a relocated e2e dial (testSupport) matches
      // the probe; in production s.port === API_PORT (11434 fixed promise).
      return s === null ? undefined : { mode: s.mode, port: s.port }
    }
  })
  const downloads = new DownloadManager({ emit: (event) => broadcastEvent('download:progress', event) })

  // todo17: real sqlite-backed conversations replace the honest not-ready seam.
  // The service is IO-free until its first verb runs (getDb opens chat.db lazily),
  // so a db failure surfaces as a rejected invoke the renderer reports honestly.
  const conversations = createConversationService()

  // todo29: agent + permission deps via the lazy index-layer factory
  // (src/main/agentMain.ts). services.ts stays untouched (lane-30 owner).
  const agentMain = createAgentMain({
    getMainWindow: () => mainWindow,
    getApiStatus: () => apiStatusRef.current,
    ensureSidecar: (name) => services.ensureSidecar(name),
  })

  const handlers = buildIpcHandlers({
    services,
    relay,
    downloads,
    hfSearch: searchHF,
    dialog,
    safeStorage,
    conversations: () => conversations,
    agent: () => agentMain()?.agent ?? null,
    permission: () => agentMain()?.permission ?? null,
    // todo40: the MCP pool lives inside the agent wiring (shared PermissionPort).
    mcp: () => agentMain()?.mcp ?? null,
    // todo32: thin ack handlers delegate here (state streams via update:state)
    updater: getUpdater,
    // todo38: overlay:* + '__test.triggerHotkey' (r2 gate: packaged → 'disabled').
    overlay: () => overlayController,
    // todo41: quickask:* + the '__test.triggerHotkey' quickask lane (same gate).
    quickask: () => quickAskController,
    testHooks: () => !app.isPackaged
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
        },
        // todo38: overlay:* liveness guard (see HandlerContext.senderId)
        senderId: event.sender.id
      }
      return fn(args, ctx)
    })
  }

  // image:queue:status EVENT variant — pump the queue's own events to all frames.
  services.imageQueue.subscribe((ev) => {
    broadcastEvent('image:queue:status', toImageQueueStatusEvent(ev))
  })
}

// 11434 arbitration + embedded server (todo10). Fire-and-forget: every outcome
// is surfaced through onStatus (tray/relay) and notify (persistent toast on
// conflict); a hard failure only ever logs — the desktop shell stays usable.
function bootstrapApiServer(): void {
  void startApiServer({
    notify: (event) => broadcastEvent('app:notification', event),
    onStatus: (status) => {
      apiStatusRef.current = status
      getMainLogger().info({ api: status }, 'api server status')
      trayController?.refresh()
      if (status.mode === 'external-takeover' && status.degraded) {
        // r2: takeover continues (never kill user processes) but the
        // sub-baseline warning is loud — tray tooltip + renderer banner.
        broadcastEvent('app:notification', {
          level: 'warning',
          title: '外部引擎低于安全基线',
          message: `11434 上的外部引擎 ${status.version ?? '版本未知'} 低于安全基线 ${ENGINE_MIN_OLLAMA_VERSION}，建议升级后继续使用。`,
          code: 'external-engine-degraded'
        })
      }
    }
  }).catch((error: unknown) => {
    getMainLogger().error({ err: error }, 'api server bootstrap failed')
  })
}

// Tray wiring (todo10): sidecar statuses live through the services container
// (lazy managers appear as they spawn; a stopped-adapter covers absent ones).
// Model switching stays inert until the engine resolver lands (todo30/31).
function bootstrapTray(): void {
  const services = getServices()
  const statusAdapters = SIDECAR_NAMES.map((name: SidecarName): SidecarManager => {
    const fallback: SidecarStatus = {
      name,
      running: false,
      port: 0,
      healthUrl: `http://${SIDECAR_HOST}:0/health`,
      failures: 0,
      restarts: 0,
      state: 'stopped'
    }
    return {
      getStatus: () => services.sidecarStatuses().find((s) => s.name === name) ?? fallback
    } as unknown as SidecarManager
  })

  const controller = new TrayController({
    managers: statusAdapters,
    getModels: () => services.registry.getModels(),
    getWindow: () => mainWindow,
    getStatusLines: () => [describeApiStatus(apiStatusRef.current)],
    getTooltip: () => `Local AI Suite — ${describeApiStatus(apiStatusRef.current)}`,
    onSwitchModel: () => undefined
  })
  controller.create()
  trayController = controller
  for (const name of SIDECAR_NAMES) {
    services.onSidecarEvent(name, () => controller.refresh())
  }
  // Destroy the tray first on quit (LIFO — registered after the container hooks).
  registerShutdownHook(() => {
    controller.destroy()
    if (trayController === controller) trayController = null
  })
}

// todo38: overlay bootstrap. The controller is ALWAYS constructed (overlay:*
// handlers + the e2e __test.triggerHotkey hook must work even when the user
// hotkey is disabled — the hook calls the controller action directly, never
// globalShortcut). The hotkey binding itself is config-gated
// (screenshotHotkeyEnabled, default true) and best-effort: a combo already
// taken by another app downgrades to a warn, never a crash.
function bootstrapOverlay(): void {
  const base = createElectronOverlayDeps({
    fakeCapture: E2E_FAKE_CAPTURE,
    getMainWindow: () => mainWindow,
    preloadPath: join(__dirname, '../preload/index.js'),
    rendererUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    rendererFile: join(__dirname, '../renderer/index.html'),
  })
  const controller = new OverlayController({
    ...base,
    logWarn: (message, error) => getMainLogger().warn({ err: error }, message),
  })
  overlayController = controller
  registerShutdownHook(() => {
    unregisterScreenshotHotkey(globalShortcut, SCREENSHOT_HOTKEY_ACCELERATOR)
    controller.dispose()
    if (overlayController === controller) overlayController = null
  })
  if (!getConfig().screenshotHotkeyEnabled) {
    getMainLogger().info({}, 'screenshot hotkey disabled by config')
    return
  }
  const bound = registerScreenshotHotkey(globalShortcut, SCREENSHOT_HOTKEY_ACCELERATOR, () => {
    void controller.trigger().catch((error: unknown) => {
      getMainLogger().error({ err: error }, 'screenshot overlay trigger failed')
    })
  })
  if (!bound) {
    getMainLogger().warn({ accelerator: SCREENSHOT_HOTKEY_ACCELERATOR }, 'screenshot hotkey already taken by another app')
  }
}

// todo41: quick-ask bootstrap. Mirrors bootstrapOverlay exactly: the controller
// is ALWAYS constructed (quickask:* handlers + the e2e hook must work with the
// user hotkey off); the Ctrl+Shift+Space binding is config-gated
// (quickaskHotkeyEnabled, default true) and best-effort — a taken combo (IME
// switch collisions are real for Space chords) downgrades to a warn, never a
// crash. Toggle semantics live in the controller (second press = hide).
function bootstrapQuickAsk(): void {
  const controller = new QuickAskController({
    ...createElectronQuickAskDeps({
      fakeClipboard: E2E_FAKE_CLIPBOARD,
      fakeClipboardText: E2E_FAKE_CLIPBOARD_TEXT,
      preloadPath: join(__dirname, '../preload/index.js'),
      rendererUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
      rendererFile: join(__dirname, '../renderer/index.html'),
    }),
    logWarn: (message, error) => getMainLogger().warn({ err: error }, message),
  })
  quickAskController = controller
  registerShutdownHook(() => {
    unregisterGlobalHotkey(globalShortcut, QUICKASK_HOTKEY_ACCELERATOR)
    controller.dispose()
    if (quickAskController === controller) quickAskController = null
  })
  if (!getConfig().quickaskHotkeyEnabled) {
    getMainLogger().info({}, 'quick-ask hotkey disabled by config')
    return
  }
  const bound = registerGlobalHotkey(globalShortcut, QUICKASK_HOTKEY_ACCELERATOR, () => {
    controller.trigger()
  })
  if (!bound) {
    getMainLogger().warn({ accelerator: QUICKASK_HOTKEY_ACCELERATOR }, 'quick-ask hotkey already taken by another app')
  }
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
  bootstrapOverlay()
  bootstrapQuickAsk()
  bootstrapApiServer()
  bootstrapTray()

  // todo32: deferred post-launch update check (plan: 启动后延迟检查). Packaged
  // builds only — unpackaged dev/e2e has no app-update.yml and must stay
  // network-silent; the explicit kill switch additionally covers offline CI.
  const updateCheckDisabled = !app.isPackaged || UPDATE_CHECK_DISABLED
  const scheduled = scheduleInitialUpdateCheck({
    check: () => getUpdater().check(),
    ...(updateCheckDisabled ? { disabled: true } : {})
  })
  getMainLogger().info({ updateCheckScheduled: scheduled, disabled: updateCheckDisabled }, 'updater bootstrap')

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
