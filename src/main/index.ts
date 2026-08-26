import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { isAllowedChannel, type AllowedChannel } from './ipc/whitelist'
import { createDestructiveConfirmHandler } from './utils/dialogConfirm'
import { createDeleteWorkspaceHandler } from './handlers/deleteWorkspace'
import { createOverwriteCoverageHandler } from './handlers/overwriteCoverage'
import { createPublishReleaseHandler } from './handlers/publishRelease'
import { createClearCacheHandler } from './handlers/clearCache'

/**
 * Sidecar host — all local sidecars (LLM / embedding / image / search)
 * MUST bind to 127.0.0.1 only, never 0.0.0.0. This constant and the comments
 * below serve as the in-code contract for that invariant.
 */
export const SIDECAR_HOST = '127.0.0.1' as const

app.enableSandbox()

let mainWindow: BrowserWindow | null = null

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

// Whitelisted IPC handlers — only ALLOWED channels are registered.
// Each handler validates the channel again via isAllowedChannel for defense in depth.
// Sidecar calls originating from these handlers must use SIDECAR_HOST (127.0.0.1).
function registerIpcHandlers(): void {
  const handlers: Record<AllowedChannel, (args: unknown[]) => Promise<unknown>> = {
    'health:pulse': async () => ({ ok: true, host: SIDECAR_HOST }),
    'models:list': async () => ({ models: [] }),
    'models:download': async () => ({ ok: true }),
    'chat:send': async () => ({ ok: true }),
    'image:generate': async () => ({ ok: true }),
    'dialog:confirmDestructive': createDestructiveConfirmHandler(dialog),
    'workspace:delete': createDeleteWorkspaceHandler(dialog, async (_id: string) => {
      // destructive: delete workspace files — guarded by dialogConfirm above
    }),
    'coverage:overwrite': createOverwriteCoverageHandler(dialog, async (_opts: unknown) => {
      // destructive: overwrite coverage report
    }),
    'release:publish': createPublishReleaseHandler(dialog, async (_opts: unknown) => {
      // destructive: publish release (irreversible)
    }),
    'cache:clear': createClearCacheHandler(dialog, async (_opts: unknown) => {
      // destructive: clear cache files
    }),
    // 密钥加解密必须在主进程完成：safeStorage 在 sandbox 渲染层不可达（P1 修复，
    // 原 settings.tsx 的 require('electron').safeStorage 永远为 null，静默退化为可逆 base64）。
    'secrets:encrypt': async (args: unknown[]) => {
      const plain = typeof args[0] === 'string' ? args[0] : ''
      if (!plain) return { ok: true, value: '' }
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return { ok: true, value: `enc:v1:${safeStorage.encryptString(plain).toString('base64')}` }
        }
        console.warn('[secrets] OS secure storage unavailable — falling back to REVERSIBLE encoding. Configure a system keyring to avoid this.')
        return {
          ok: true,
          warning: 'os-storage-unavailable',
          value: `enc:fallback:v1:${Buffer.from(plain, 'utf-8').toString('base64')}`
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    'secrets:decrypt': async (args: unknown[]) => {
      const payload = typeof args[0] === 'string' ? args[0] : ''
      if (!payload) return { ok: true, value: '' }
      try {
        if (payload.startsWith('enc:v1:')) {
          if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encrypted with safeStorage but OS storage unavailable' }
          return { ok: true, value: safeStorage.decryptString(Buffer.from(payload.slice('enc:v1:'.length), 'base64')) }
        }
        if (payload.startsWith('enc:fallback:v1:')) {
          return { ok: true, warning: 'fallback-payload', value: Buffer.from(payload.slice('enc:fallback:v1:'.length), 'base64').toString('utf-8') }
        }
        // 历史明文：原样返回（与渲染层旧逻辑一致）
        return { ok: true, value: payload }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }

  for (const [channel, fn] of Object.entries(handlers) as [AllowedChannel, typeof handlers[AllowedChannel]][]) {
    // Defensive: skip if somehow not in whitelist (should never happen)
    if (!isAllowedChannel(channel)) continue
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      // Re-validate channel at invoke time as well
      if (!isAllowedChannel(channel)) throw new Error(`IPC channel not allowed: ${channel}`)
      return fn(args)
    })
  }
}

app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
