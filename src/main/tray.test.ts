import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildTrayTemplate, switchModel, TrayController } from "./tray"
import type { ModelEntry } from "../models/registry"

function mockManager(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    name: "llama",
    bin: "llama-server",
    args: ["--model", "/old/model.gguf", "--port", "11435", "--host", "127.0.0.1"],
    port: 11435,
    healthUrl: "http://127.0.0.1:11435/health",
  }
  let config: Record<string, unknown> = { ...base, modelPath: "/old/model.gguf", ...overrides.config as object }
  // allow override modelPath directly
  if (overrides.modelPath) config.modelPath = overrides.modelPath
  return {
    config,
    restart: vi.fn(),
    getStatus: vi.fn(() => ({
      name: (config.name as string) ?? "llama",
      running: (overrides.running as boolean) ?? true,
      pid: 1234,
      port: (config.port as number) ?? 11435,
      healthUrl: config.healthUrl as string,
      failures: (overrides.failures as number) ?? 0,
      restarts: (overrides.restarts as number) ?? 0,
    })),
    logPath: "/tmp/logs/sidecar-llama.log",
  } as unknown as import("../core/SidecarManager").SidecarManager
}

function modelEntry(name: string, p: string, quant = "Q4_K_M", arch = "qwen2"): ModelEntry {
  return { name, file: p.split("/").pop()!, path: p, size: 2048, quant, arch, format: "gguf", mtimeMs: Date.now() }
}

describe("tray — 系统托盘", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("switchModel 秒切：更新 modelPath/args 并调用 restart", () => {
    const mgr = mockManager()
    const m = modelEntry("qwen3-4b-Q8_0", "/models/qwen3-4b-Q8_0.gguf", "Q8_0", "qwen3")
    switchModel(mgr as never, m)
    expect((mgr.config as unknown as Record<string, unknown>).modelPath).toBe(m.path)
    const args = (mgr.config as unknown as { args: string[] }).args
    expect(args[args.indexOf("--model") + 1]).toBe(m.path)
    expect(mgr.restart).toHaveBeenCalledTimes(1)
  })

  it("buildTrayTemplate 含 显示/隐藏、模型切换、服务状态、日志目录、退出", () => {
    const mgr = mockManager()
    const models = [modelEntry("qwen2-7b-Q4_K_M", "/models/a.gguf"), modelEntry("llama-8b-F16", "/models/b.gguf")]
    let winVisible = false
    const fakeWin = { isVisible: () => winVisible, isDestroyed: () => false, hide: vi.fn(() => { winVisible = false }), show: vi.fn(() => { winVisible = true }), focus: vi.fn() } as unknown as InstanceType<typeof import("electron").BrowserWindow>
    const template = buildTrayTemplate({
      manager: mgr as never,
      getModels: () => models,
      currentModelPath: "/models/a.gguf",
      getWindow: () => fakeWin,
      logDir: "/tmp/logs",
    })
    const labels = template.map((t) => (t as { label?: string; type?: string }).label ?? (t as { type?: string }).type)
    expect(labels).toContain("显示窗口")
    expect(labels).toContain("模型切换")
    expect(labels).toContain("服务状态")
    expect(labels).toContain("打开日志目录")
    expect(labels).toContain("退出")
    const sepCount = template.filter((t) => (t as { type?: string }).type === "separator").length
    expect(sepCount).toBe(3)

    const modelItem = template.find((t) => (t as { label?: string }).label === "模型切换") as { submenu: { label: string; type: string; checked: boolean }[] }
    expect(modelItem.submenu).toHaveLength(2)
    expect(modelItem.submenu[0].checked).toBe(true)
    expect(modelItem.submenu[1].checked).toBe(false)

    const statusItem = template.find((t) => (t as { label?: string }).label === "服务状态") as { submenu: { label: string }[] }
    expect(statusItem.submenu[0].label).toContain("llama")
    expect(statusItem.submenu[0].label).toContain("运行中")

    // 隐藏窗口状态
    winVisible = true
    const t2 = buildTrayTemplate({ manager: mgr as never, getModels: () => models, getWindow: () => fakeWin })
    expect(t2[0].label).toBe("隐藏窗口")
  })

  it("模型切换 click 触发 restart（默认行为）", () => {
    const mgr = mockManager()
    const models = [modelEntry("a-Q4_K_M", "/models/a.gguf")]
    const template = buildTrayTemplate({ manager: mgr as never, getModels: () => models } as never)
    const sub = (template.find((t) => (t as { label?: string }).label === "模型切换") as { submenu: { label: string; click: () => void }[] }).submenu
    sub[0].click()
    expect(mgr.restart).toHaveBeenCalledTimes(1)
  })

  it("自定义 onSwitchModel 优先于默认 restart", () => {
    const mgr = mockManager()
    const onSwitch = vi.fn()
    const models = [modelEntry("a-Q4_K_M", "/models/a.gguf")]
    const template = buildTrayTemplate({ manager: mgr as never, getModels: () => models, onSwitchModel: onSwitch })
    const sub = (template.find((t) => (t as { label?: string }).label === "模型切换") as { submenu: { click: () => void }[] }).submenu
    sub[0].click()
    expect(onSwitch).toHaveBeenCalledWith(models[0])
    expect(mgr.restart).not.toHaveBeenCalled()
  })

  it("无模型时显示 暂无模型；无服务时显示 无服务", () => {
    const t = buildTrayTemplate({ getModels: () => [] })
    const modelSub = (t.find((x) => (x as { label?: string }).label === "模型切换") as { submenu: { label: string; enabled: boolean }[] }).submenu
    expect(modelSub[0].label).toBe("暂无模型")
    expect(modelSub[0].enabled).toBe(false)
    const statusSub = (t.find((x) => (x as { label?: string }).label === "服务状态") as { submenu: { label: string }[] }).submenu
    expect(statusSub[0].label).toBe("无服务")
  })

  it("显示/隐藏 click 切换窗口可见性", () => {
    let visible = false
    const win = { isVisible: () => visible, isDestroyed: () => false, hide: vi.fn(() => { visible = false }), show: vi.fn(() => { visible = true }), focus: vi.fn() } as unknown as InstanceType<typeof import("electron").BrowserWindow>
    const mgr = mockManager()
    let t = buildTrayTemplate({ manager: mgr as never, getWindow: () => win })
    ;(t[0] as { click: () => void }).click()
    expect(win.show).toHaveBeenCalled()
    visible = true
    t = buildTrayTemplate({ manager: mgr as never, getWindow: () => win })
    ;(t[0] as { click: () => void }).click()
    expect(win.hide).toHaveBeenCalled()
  })

  it("打开日志目录 调用 shell.openPath，未运行服务显示 未运行", () => {
    const openPath = vi.fn()
    const mgr = mockManager({ running: false } as never)
    const t = buildTrayTemplate({ manager: mgr as never, logDir: "/custom/logs", getWindow: () => null, deps: { shell: { openPath } as never } })
    const logItem = t.find((x) => (x as { label?: string }).label === "打开日志目录") as { click: () => void }
    logItem.click()
    expect(openPath).toHaveBeenCalledWith("/custom/logs")
    const statusSub = (t.find((x) => (x as { label?: string }).label === "服务状态") as { submenu: { label: string }[] }).submenu
    expect(statusSub[0].label).toContain("未运行")
  })

  it("退出 调用 app.quit", () => {
    const quit = vi.fn()
    const t = buildTrayTemplate({ getWindow: () => null, deps: { app: { quit } as never } })
    const quitItem = t.find((x) => (x as { label?: string }).label === "退出") as { click: () => void }
    quitItem.click()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it("TrayController create/refresh/destroy 流程（注入 mock electron）", () => {
    const setContextMenu = vi.fn()
    const setToolTip = vi.fn()
    const on = vi.fn()
    const destroy = vi.fn()
    class FakeTray { constructor(_i: unknown) {} setContextMenu = setContextMenu; setToolTip = setToolTip; on = on; destroy = destroy }
    const buildFromTemplate = vi.fn(() => ({}) as Electron.Menu)
    const createEmpty = vi.fn(() => ({}) as Electron.NativeImage)
    const createFromPath = vi.fn(() => ({}) as Electron.NativeImage)
    const mgr = mockManager()
    const ctrl = new TrayController(
      { manager: mgr as never, getModels: () => [], logDir: "/tmp/logs", tooltip: "Test" },
      { Tray: FakeTray as unknown as typeof import("electron").Tray, Menu: { buildFromTemplate } as unknown as typeof import("electron").Menu, nativeImage: { createEmpty, createFromPath } as unknown as typeof import("electron").nativeImage, shell: { openPath: vi.fn() } as unknown as typeof import("electron").shell, app: { quit: vi.fn() } as unknown as typeof import("electron").app, BrowserWindow: {} as never },
    )
    const tray = ctrl.create()
    expect(tray).toBeTruthy()
    expect(setToolTip).toHaveBeenCalledWith("Test")
    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    ctrl.refresh()
    expect(buildFromTemplate).toHaveBeenCalledTimes(2)
    ctrl.destroy()
    expect(destroy).toHaveBeenCalled()
    expect(ctrl.getTray()).toBeNull()
  })

  // ---- 双击主用 + 平台守卫 ----
  function createMockTrayHarness(platform: NodeJS.Platform) {
    const setContextMenu = vi.fn()
    const setToolTip = vi.fn()
    const destroy = vi.fn()
    const handlers = new Map<string, () => void>()
    const on = vi.fn((event: string, cb: () => void) => { handlers.set(event, cb) })
    class FakeTray { constructor(_i: unknown) {} setContextMenu = setContextMenu; setToolTip = setToolTip; on = on; destroy = destroy }
    const buildFromTemplate = vi.fn(() => ({}) as Electron.Menu)
    const createEmpty = vi.fn(() => ({}) as Electron.NativeImage)
    const createFromPath = vi.fn(() => ({}) as Electron.NativeImage)
    let visible = false
    const win = {
      isVisible: () => visible,
      isDestroyed: () => false,
      hide: vi.fn(() => { visible = false }),
      show: vi.fn(() => { visible = true }),
      focus: vi.fn(),
    } as unknown as InstanceType<typeof import("electron").BrowserWindow>
    const mgr = mockManager()
    const ctrl = new TrayController(
      { manager: mgr as never, getModels: () => [], logDir: "/tmp/logs", getWindow: () => win, platform },
      { Tray: FakeTray as unknown as typeof import("electron").Tray, Menu: { buildFromTemplate } as unknown as typeof import("electron").Menu, nativeImage: { createEmpty, createFromPath } as unknown as typeof import("electron").nativeImage, shell: { openPath: vi.fn() } as unknown as typeof import("electron").shell, app: { quit: vi.fn() } as unknown as typeof import("electron").app, BrowserWindow: {} as never },
    )
    ctrl.create()
    return { handlers, on, win, ctrl, setContextMenu, buildFromTemplate, visible: () => visible, setVisible: (v: boolean) => { visible = v } }
  }

  it("win32：仅 double-click 有效，300ms debounce", () => {
    const h = createMockTrayHarness("win32")
    expect(h.on).toHaveBeenCalledWith("double-click", expect.any(Function))
    expect(h.handlers.has("click")).toBe(false)
    // right-click 菜单保留
    expect(h.setContextMenu).toHaveBeenCalled()
    expect(h.buildFromTemplate).toHaveBeenCalled()

    const dbl = h.handlers.get("double-click")!
    const nowSpy = vi.spyOn(Date, "now")
    let t = 1000000
    nowSpy.mockImplementation(() => t)

    dbl()
    expect(h.win.show).toHaveBeenCalledTimes(1)
    // 100ms 内再次双击被 debounce
    t += 100
    dbl()
    expect(h.win.show).toHaveBeenCalledTimes(1)
    // 300ms 后再次双击生效（此时窗口 visible=true 应 hide）
    t += 300
    dbl()
    expect(h.win.hide).toHaveBeenCalledTimes(1)

    nowSpy.mockRestore()
    h.ctrl.destroy()
  })

  it("linux：仅 double-click 有效，300ms debounce", () => {
    const h = createMockTrayHarness("linux")
    expect(h.on).toHaveBeenCalledWith("double-click", expect.any(Function))
    expect(h.handlers.has("click")).toBe(false)
    expect(h.setContextMenu).toHaveBeenCalled()

    const dbl = h.handlers.get("double-click")!
    const nowSpy = vi.spyOn(Date, "now")
    let t = 2000000
    nowSpy.mockImplementation(() => t)
    dbl()
    expect(h.win.show).toHaveBeenCalledTimes(1)
    t += 50
    dbl()
    expect(h.win.show).toHaveBeenCalledTimes(1)
    t += 300
    dbl()
    expect(h.win.hide).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
    h.ctrl.destroy()
  })

  it("darwin：click 立即生效，无 debounce", () => {
    const h = createMockTrayHarness("darwin")
    expect(h.on).toHaveBeenCalledWith("click", expect.any(Function))
    expect(h.handlers.has("double-click")).toBe(false)
    expect(h.setContextMenu).toHaveBeenCalled()

    const click = h.handlers.get("click")!
    click()
    expect(h.win.show).toHaveBeenCalledTimes(1)
    click()
    expect(h.win.hide).toHaveBeenCalledTimes(1)
    // 立即连续点击无 debounce 限制
    h.setVisible(false)
    click()
    expect(h.win.show).toHaveBeenCalledTimes(2)
    h.ctrl.destroy()
  })
})

