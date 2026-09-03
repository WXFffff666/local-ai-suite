import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Writable } from 'stream'
import pino from 'pino'

// Project convention (learnings.md): vi.mock('electron') must be hoisted BEFORE the
// module-under-test import; index.ts is imported dynamically per test so each case
// gets a fresh module graph (vi.resetModules in afterEach).
const mocks = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    static getAllWindows(): FakeBrowserWindow[] {
      return FakeBrowserWindow.instances
    }
    /** W1-10→todo36: capture the session permission handlers for the gate matrix. */
    permissionRequestHandler: ((wc: unknown, permission: string, cb: (allow: boolean) => void, details?: unknown) => void) | null =
      null
    permissionCheckHandler: ((wc: unknown, permission: string, details?: unknown) => boolean) | null = null
    webContents = {
      session: {
        setPermissionRequestHandler: (h: (wc: unknown, permission: string, cb: (allow: boolean) => void, details?: unknown) => void): void => {
          this.permissionRequestHandler = h
        },
        setPermissionCheckHandler: (h: (wc: unknown, permission: string, details?: unknown) => boolean): void => {
          this.permissionCheckHandler = h
        }
      },
      setWindowOpenHandler: (_: unknown): void => undefined
    }
    isMinimizedValue = false
    isVisibleValue = true
    on = (_: string, _cb: unknown): void => undefined
    restore = vi.fn(() => {
      this.isMinimizedValue = false
    })
    show = vi.fn(() => {
      this.isVisibleValue = true
    })
    focus = vi.fn()
    loadFile = vi.fn()
    loadURL = vi.fn()
    isMinimized(): boolean {
      return this.isMinimizedValue
    }
    isVisible(): boolean {
      return this.isVisibleValue
    }
    isDestroyed(): boolean {
      return false
    }
    constructor(_options?: unknown) {
      FakeBrowserWindow.instances.push(this)
    }
  }

  return {
    app: {
      enableSandbox: vi.fn(),
      whenReady: vi.fn(),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      requestSingleInstanceLock: vi.fn(),
      getPath: vi.fn((): string => 'mock-userData')
    },
    ipcMain: { handle: vi.fn() },
    // todo38: bootstrapOverlay registers the screenshot hotkey through
    // globalShortcut — the accessor mock below keeps that path side-effect
    // free (register "succeeds", nothing is ever invoked in these tests).
    globalShortcut: {
      isRegistered: vi.fn((): boolean => false),
      unregister: vi.fn(),
      register: vi.fn((): boolean => true)
    },
    dialog: { showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
    safeStorage: {
      isEncryptionAvailable: vi.fn((): boolean => false),
      encryptString: vi.fn(),
      decryptString: vi.fn()
    },
    FakeBrowserWindow,
    shutdownServices: vi.fn(),
    registerShutdownHook: vi.fn(),
    initServices: vi.fn(() => Promise.resolve(undefined)),
    // Structural stand-in for the W1-8 container surface registerIpcHandlers()
    // consumes (getServices is called synchronously inside whenReady).
    servicesStub: {
      registry: { getModels: vi.fn((): unknown[] => []) },
      imageQueue: {
        enqueue: vi.fn((): string => 'job-1'),
        getJob: vi.fn((): unknown => undefined),
        listJobs: vi.fn((): unknown[] => []),
        subscribe: vi.fn((): (() => void) => () => undefined),
        pending: 0
      },
      gallery: {
        list: vi.fn((): unknown[] => []),
        save: vi.fn(),
        copy: vi.fn(),
        insert: vi.fn(),
        reuse: vi.fn()
      },
      search: { search: vi.fn() },
      ensureSidecar: vi.fn(),
      sidecarStatuses: vi.fn((): unknown[] => []),
      onSidecarEvent: vi.fn((): (() => void) => () => undefined)
    },
    startApiServer: vi.fn(() =>
      Promise.resolve({ status: { mode: 'embedded', port: 11434 }, stop: async () => undefined })
    ),
    trayCreate: vi.fn(),
    trayRefresh: vi.fn(),
    trayDestroy: vi.fn(),
    mainLogger: {
      fatal: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      flush: vi.fn((cb: () => void): void => {
        cb()
      })
    }
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.FakeBrowserWindow,
  ipcMain: mocks.ipcMain,
  // todo38: bootstrapOverlay()'s hotkey binding (side-effect-free stub).
  globalShortcut: mocks.globalShortcut,
  dialog: mocks.dialog,
  safeStorage: mocks.safeStorage
}))

// @electron-toolkit/utils is an externalized dep: Node loads it natively and its
// `import { BrowserWindow } from 'electron'` would bypass the vi.mock registry and
// hit the real CJS electron package (named exports not statically detectable).
// Mock the only surface index.ts uses (`is`).
vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: false },
  join: (...parts: string[]): string => parts.join('/')
}))

vi.mock('./shutdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./shutdown')>()
  return {
    ...actual,
    registerShutdownHook: mocks.registerShutdownHook,
    shutdownServices: mocks.shutdownServices
  }
})

// The real container would spin chokidar + real fs watches during these tests;
// index.ts only needs to prove it calls initServices() after whenReady.
vi.mock('./services', () => ({
  initServices: mocks.initServices,
  getServices: (): unknown => mocks.servicesStub,
  SIDECAR_NAMES: ['llama', 'ollama', 'sd']
}))

vi.mock('./apiServer', () => ({
  startApiServer: mocks.startApiServer,
  ENGINE_MIN_OLLAMA_VERSION: '0.1.13'
}))

// The real tray module needs six electron surfaces the baseline mock above does
// not provide; lifecycle only proves bootstrap ordering.
vi.mock('./tray', () => ({
  TrayController: class {
    create = mocks.trayCreate
    refresh = mocks.trayRefresh
    destroy = mocks.trayDestroy
    updateTooltip = vi.fn()
  }
}))

vi.mock('./logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./logger')>()
  return {
    ...actual,
    getMainLogger: vi.fn(() => mocks.mainLogger)
  }
})

// Real logger module function (kept by the importOriginal spread above).
import { registerGlobalErrorLogging } from './logger'

type AppListener = (...args: unknown[]) => unknown

function appListener(event: string): AppListener | undefined {
  const call = mocks.app.on.mock.calls.find(([name]) => name === event)
  return call === undefined ? undefined : (call[1] as AppListener)
}

function requireAppListener(event: string): AppListener {
  const listener = appListener(event)
  if (listener === undefined) throw new Error(`app.on('${event}') was never registered`)
  return listener
}

function requireUncaughtListener(baseline: number): (error: Error) => void {
  const added = process.listeners('uncaughtException')[baseline]
  if (added === undefined) throw new Error('uncaughtException listener was not registered')
  return added
}

function requireRejectionListener(
  baseline: number
): (reason: unknown, promise: Promise<unknown> | undefined) => void {
  const added = process.listeners('unhandledRejection')[baseline]
  if (added === undefined) throw new Error('unhandledRejection listener was not registered')
  return added
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function importIndex(): Promise<void> {
  await import('./index')
  // let the app.whenReady().then(...) microtasks settle
  await flushAsync()
}

interface ProcessBaseline {
  uncaughtException: number
  unhandledRejection: number
}

let processBaseline: ProcessBaseline = { uncaughtException: 0, unhandledRejection: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.FakeBrowserWindow.instances.length = 0
  mocks.app.whenReady.mockReturnValue(Promise.resolve())
  mocks.app.requestSingleInstanceLock.mockReturnValue(true)
  mocks.shutdownServices.mockImplementation(() => Promise.resolve({ errors: [] }))
  processBaseline = {
    uncaughtException: process.listeners('uncaughtException').length,
    unhandledRejection: process.listeners('unhandledRejection').length
  }
})

afterEach(() => {
  // Detach process-level handlers registered during the test so cases never leak
  // listeners into each other.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    for (const listener of process.listeners(event).slice(processBaseline[event])) {
      process.removeListener(event, listener)
    }
  }
  vi.resetModules()
})

describe('lifecycle — src/main/index.ts 生命周期接线', () => {
  it('二次启动：requestSingleInstanceLock 返回 false → app.quit，不注册 second-instance', async () => {
    mocks.app.requestSingleInstanceLock.mockReturnValue(false)

    await importIndex()

    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(appListener('second-instance')).toBeUndefined()
  })

  it('持有锁：注册 second-instance，触发时聚焦主窗口（最小化先 restore、隐藏先 show）', async () => {
    await importIndex()

    const onSecondInstance = requireAppListener('second-instance')
    expect(mocks.app.quit).not.toHaveBeenCalled()

    const win = mocks.FakeBrowserWindow.instances[0]
    if (win === undefined) throw new Error('whenReady did not create the main window')
    expect(mocks.ipcMain.handle).toHaveBeenCalled()
    expect(mocks.initServices).toHaveBeenCalledTimes(1)
    // W1-10 boot ordering: arbitration starts and the tray is created once
    // the window exists (window getter + tooltip need it).
    expect(mocks.startApiServer).toHaveBeenCalledTimes(1)
    expect(mocks.trayCreate).toHaveBeenCalledTimes(1)

    win.isMinimizedValue = true
    win.isVisibleValue = false
    onSecondInstance({}, [], 'cwd')

    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('before-quit：preventDefault + 调用 shutdownServices 一次，清理完成后重新 quit', async () => {
    await importIndex()

    const onBeforeQuit = requireAppListener('before-quit')
    const event = { preventDefault: vi.fn() }

    onBeforeQuit(event)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(mocks.shutdownServices).toHaveBeenCalledTimes(1)

    await flushAsync()
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
  })

  it('清理完成后的再次 before-quit 幂等：不再调 shutdownServices、不再 preventDefault', async () => {
    await importIndex()

    const onBeforeQuit = requireAppListener('before-quit')
    const event = { preventDefault: vi.fn() }
    onBeforeQuit(event)
    await flushAsync()

    onBeforeQuit(event)
    await flushAsync()

    expect(mocks.shutdownServices).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
  })

  it('shutdownServices 记录的 hook 失败被写入 main logger', async () => {
    const reason = new Error('hook blew up')
    mocks.shutdownServices.mockImplementation(() =>
      Promise.resolve({ errors: [{ hookIndex: 0, timeoutMs: 3000, reason }] })
    )
    await importIndex()

    requireAppListener('before-quit')({ preventDefault: vi.fn() })
    await flushAsync()

    expect(mocks.mainLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: reason, hookIndex: 0, timeoutMs: 3000 }),
      'shutdown hook failed'
    )
  })

  it('shutdownServices reject 时 quit 流程不悬挂：finally 仍重新 app.quit', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.shutdownServices.mockImplementation(() => Promise.reject(new Error('stuck')))
    await importIndex()

    requireAppListener('before-quit')({ preventDefault: vi.fn() })
    await flushAsync()

    expect(mocks.app.quit).toHaveBeenCalledTimes(1)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('will-quit：兜底再调一次 shutdownServices（真实实现幂等）', async () => {
    await importIndex()

    requireAppListener('will-quit')()

    expect(mocks.shutdownServices).toHaveBeenCalledTimes(1)
  })

  it('导入 index.ts 即注册 uncaughtException / unhandledRejection 进程处理器', async () => {
    await importIndex()

    expect(requireUncaughtListener(processBaseline.uncaughtException)).toBeTypeOf('function')
    expect(requireRejectionListener(processBaseline.unhandledRejection)).toBeTypeOf('function')
  })
})

// W1-10→todo36: the deny-all session handler became a selective gate. These
// cases drive the handlers actually registered on the (fake) main window.
describe('session permission gate (todo36 media selective-allow matrix)', () => {
  function windowWithHandlers(): {
    request: (permission: string, details?: unknown) => boolean
    check: (permission: string, details?: unknown) => boolean
  } {
    const win = mocks.FakeBrowserWindow.instances[0]
    if (win === undefined || win.permissionRequestHandler === null || win.permissionCheckHandler === null) {
      throw new Error('permission handlers were not registered on the main window session')
    }
    const request = (permission: string, details?: unknown): boolean => {
      let allowed = false
      win.permissionRequestHandler?.({} as unknown, permission, (v) => {
        allowed = v
      }, details)
      return allowed
    }
    const check = (permission: string, details?: unknown): boolean =>
      win.permissionCheckHandler?.({} as unknown, permission, details) ?? true
    return { request, check }
  }

  it('media + audioCapture from the app origin (file:// under test) -> ALLOW', async () => {
    await importIndex()
    const { request } = windowWithHandlers()
    expect(request('media', { requestingOrigin: 'file://', mediaTypes: ['audioCapture'] })).toBe(true)
  })

  it('geolocation STILL DENIED (historical W1-10 baseline pinned from the handler side)', async () => {
    await importIndex()
    const { request, check } = windowWithHandlers()
    expect(request('geolocation', { requestingOrigin: 'file://' })).toBe(false)
    expect(check('geolocation', 'file://')).toBe(false)
  })

  it('media from a foreign origin DENIED; display-capture flavors DENIED', async () => {
    await importIndex()
    const { request } = windowWithHandlers()
    expect(request('media', { requestingOrigin: 'https://evil.example', mediaTypes: ['audioCapture'] })).toBe(false)
    expect(request('media', { requestingOrigin: 'file://', mediaTypes: ['displayMedia'] })).toBe(false)
  })

  it('handlers are registered on the session (not left deny-all constants)', async () => {
    await importIndex()
    const win = mocks.FakeBrowserWindow.instances[0]
    expect(win?.permissionRequestHandler).toBeTypeOf('function')
    expect(win?.permissionCheckHandler).toBeTypeOf('function')
  })
})

describe('logger — registerGlobalErrorLogging 行为（真实函数 + 真 pino 内存 sink）', () => {  function memorySinkLogger(lines: string[]): ReturnType<typeof pino> {
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        lines.push(chunk.toString('utf-8'))
        callback()
      }
    })
    return pino({ level: 'info' }, sink)
  }

  it('uncaughtException：写 fatal 日志（含 err 字段）后保留默认退出语义 exit(1)', async () => {
    const lines: string[] = []
    const exit = vi.fn()

    const unregister = registerGlobalErrorLogging({
      getLogger: () => memorySinkLogger(lines),
      exit
    })
    try {
      requireUncaughtListener(processBaseline.uncaughtException)(new Error('kaboom'))

      // exit fires via logger.flush(cb); the hard-bounded fallback timer is the
      // backstop — waitFor tolerates either timing without an arbitrary sleep.
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
      const record = JSON.parse(lines[0] ?? '{}') as {
        level: number
        msg: string
        err: { message: string }
        event: string
      }
      expect(record.level).toBe(60)
      expect(record.err.message).toBe('kaboom')
      expect(record.event).toBe('process.uncaughtException')
    } finally {
      unregister()
    }
  })

  it('unhandledRejection：仅记录 error 不退出；非 Error reason 被包装为 Error', () => {
    const lines: string[] = []
    const exit = vi.fn()

    const unregister = registerGlobalErrorLogging({
      getLogger: () => memorySinkLogger(lines),
      exit
    })
    try {
      const handler = requireRejectionListener(processBaseline.unhandledRejection)

      handler(new Error('floaty'), undefined)
      handler('bare string reason', undefined)

      expect(exit).not.toHaveBeenCalled()
      const [first, second] = lines.map((line) =>
        JSON.parse(line) as { level: number; err: { message: string }; event: string }
      )
      expect(first?.level).toBe(50)
      expect(first?.err.message).toBe('floaty')
      expect(first?.event).toBe('process.unhandledRejection')
      expect(second?.err.message).toContain('bare string reason')
    } finally {
      unregister()
    }
  })

  it('unregister 之后处理器不再挂在 process 上', () => {
    const unregister = registerGlobalErrorLogging({
      getLogger: () => memorySinkLogger([]),
      exit: vi.fn()
    })
    expect(process.listeners('uncaughtException').length).toBe(processBaseline.uncaughtException + 1)

    unregister()

    expect(process.listeners('uncaughtException').length).toBe(processBaseline.uncaughtException)
    expect(process.listeners('unhandledRejection').length).toBe(processBaseline.unhandledRejection)
  })
})
