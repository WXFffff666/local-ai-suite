import { Tray, Menu, shell, app, BrowserWindow, nativeImage } from "electron"
import * as path from "path"
import type { SidecarManager } from "../core/SidecarManager"
import type { ModelEntry } from "../models/registry"

export type TrayDeps = {
  Tray: typeof Tray
  Menu: typeof Menu
  shell: typeof shell
  app: typeof app
  BrowserWindow: typeof BrowserWindow
  nativeImage: typeof nativeImage
}

export type TraySetupOptions = {
  imagePath?: string
  tooltip?: string
  logDir?: string
  managers?: SidecarManager[]
  manager?: SidecarManager
  getModels?: () => ModelEntry[]
  currentModelPath?: string
  onSwitchModel?: (model: ModelEntry) => void | Promise<void>
  getWindow?: () => InstanceType<typeof BrowserWindow> | null
  /** W1-10: extra read-only lines in the 服务状态 submenu (API server state...). */
  getStatusLines?: () => string[]
  /** W1-10: dynamic tooltip (reflects arbitration / errors). */
  getTooltip?: () => string
  deps?: Partial<TrayDeps>
  platform?: NodeJS.Platform
}

export type MenuItemLike = Electron.MenuItemConstructorOptions

function getManagers(opts: TraySetupOptions): SidecarManager[] {
  if (opts.managers) return opts.managers
  if (opts.manager) return [opts.manager]
  return []
}

function getLogDir(opts: TraySetupOptions, managers: SidecarManager[]): string {
  if (opts.logDir) return opts.logDir
  const first = managers[0] as unknown as { logPath?: string; logDir?: string } | undefined
  if (first?.logPath) return path.dirname(first.logPath)
  return path.join(process.cwd(), "logs")
}

export function switchModel(manager: SidecarManager, model: ModelEntry): void {
  try {
    ;(manager.config as unknown as Record<string, unknown>).modelPath = model.path
    const args = [...manager.config.args]
    const idx = args.findIndex((a) => a === "--model" || a === "-m")
    if (idx !== -1 && idx + 1 < args.length) {
      args[idx + 1] = model.path
      ;(manager.config as unknown as { args: string[] }).args = args
    }
  } catch {}
  manager.restart()
}

export function buildTrayTemplate(opts: TraySetupOptions): MenuItemLike[] {
  const managers = getManagers(opts)
  const logDir = getLogDir(opts, managers)
  const models = (() => {
    try { return opts.getModels?.() ?? [] } catch { return [] }
  })()
  const currentPath = opts.currentModelPath ?? (managers[0] as unknown as { config?: { modelPath?: string } } | undefined)?.config?.modelPath

  const win = opts.getWindow?.() ?? null
  const isVisible = (() => {
    try { return !!(win && !win.isDestroyed() && win.isVisible()) } catch { return false }
  })()

  const toggleLabel = isVisible ? "隐藏窗口" : "显示窗口"

  const modelSubmenu: MenuItemLike[] = models.length === 0
    ? [{ label: "暂无模型", enabled: false }]
    : models.map((m) => ({
        label: `${m.name} [${m.quant}/${m.arch}]`,
        type: "radio" as const,
        checked: currentPath ? m.path === currentPath : false,
        click: () => {
          if (opts.onSwitchModel) {
            try { void opts.onSwitchModel(m) } catch {}
            return
          }
          const target = managers[0]
          if (target) switchModel(target, m)
        },
      }))

  const extraLines = (() => {
    try { return opts.getStatusLines?.() ?? [] } catch { return [] }
  })()
  const managerLines: MenuItemLike[] = managers.length === 0
    ? [{ label: "无服务", enabled: false }]
    : managers.map((mgr) => {
        const s = mgr.getStatus()
        const icon = s.running ? "●" : "○"
        const label = `${icon} ${s.name} :${s.port} ${s.running ? "运行中" : "未运行"}${s.pid ? " pid=" + s.pid : ""} 失败${s.failures} 重启${s.restarts}`
        return { label, enabled: false }
      })
  const statusSubmenu: MenuItemLike[] = [
    ...managerLines,
    ...extraLines.map((label) => ({ label, enabled: false })),
  ]

  const template: MenuItemLike[] = [
    {
      label: toggleLabel,
      click: () => {
        const w = opts.getWindow?.() ?? null
        if (!w || (w as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) return
        try {
          if (w.isVisible()) w.hide()
          else { w.show(); try { w.focus() } catch {} }
        } catch {}
      },
    },
    { type: "separator" },
    { label: "模型切换", submenu: modelSubmenu },
    { label: "服务状态", submenu: statusSubmenu },
    { type: "separator" },
    {
      label: "打开日志目录",
      click: () => {
        try {
          const sh: Pick<TrayDeps["shell"], "openPath"> = (opts.deps?.shell as unknown as Pick<TrayDeps["shell"], "openPath">) ?? shell
          void sh.openPath(logDir)
        } catch {}
      },
    },
    { type: "separator" },
    {
      label: "退出",
      role: "quit" as const,
      click: () => {
        try {
          const a: Pick<TrayDeps["app"], "quit"> = (opts.deps?.app as unknown as Pick<TrayDeps["app"], "quit">) ?? app
          a.quit()
        } catch {}
      },
    },
  ]
  return template
}

export class TrayController {
  private tray: InstanceType<typeof Tray> | null = null
  private readonly opts: TraySetupOptions
  private readonly deps: TrayDeps

  constructor(opts: TraySetupOptions, depsOverrides?: Partial<TrayDeps>) {
    this.opts = opts
    this.deps = {
      Tray,
      Menu,
      shell,
      app,
      BrowserWindow,
      nativeImage,
      ...depsOverrides,
      ...(opts.deps ?? {}),
    } as TrayDeps
  }

  create(): InstanceType<typeof Tray> {
    const img = (() => {
      try {
        if (this.opts.imagePath) return this.deps.nativeImage.createFromPath(this.opts.imagePath)
        return this.deps.nativeImage.createEmpty()
      } catch { return this.deps.nativeImage.createEmpty() }
    })()
    this.tray = new this.deps.Tray(img)
    this.updateTooltip()
    this.refresh()
    try {
      const toggle = () => {
        const w = this.opts.getWindow?.() ?? null
        if (!w || w.isDestroyed()) return
        if (w.isVisible()) w.hide()
        else { w.show(); try { w.focus() } catch {} }
      }
      const platform = this.opts.platform ?? process.platform
      if (platform === "darwin") {
        this.tray.on("click", toggle)
      } else {
        let last = 0
        this.tray.on("double-click", () => {
          const now = Date.now()
          if (now - last < 300) return
          last = now
          toggle()
        })
      }
    } catch {}
    return this.tray
  }

  /** W1-10: re-resolve the tooltip (getTooltip wins over the static fallback). */
  updateTooltip(): void {
    if (!this.tray) return
    let text: string
    try { text = this.opts.getTooltip?.() ?? this.opts.tooltip ?? "Local AI Suite" } catch { text = this.opts.tooltip ?? "Local AI Suite" }
    try { this.tray.setToolTip(text) } catch {}
  }

  refresh(): void {
    if (!this.tray) return
    this.updateTooltip()
    const template = buildTrayTemplate(this.opts)
    try {
      const menu = this.deps.Menu.buildFromTemplate(template)
      this.tray.setContextMenu(menu)
    } catch {}
  }

  destroy(): void {
    if (this.tray) {
      try { this.tray.destroy() } catch {}
      this.tray = null
    }
  }

  getTray(): InstanceType<typeof Tray> | null { return this.tray }
}

export function setupTray(opts: TraySetupOptions): TrayController {
  const c = new TrayController(opts)
  c.create()
  return c
}

export default TrayController

