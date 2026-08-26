/**
 * Global shortcuts & chat input shortcuts — Wave7 T31
 * - 全局 Ctrl+Shift+L (CommandOrControl+Shift+L) 呼出/隐藏主窗口
 * - 聊天 Ctrl+Enter 发送
 * - 输入 "/" 唤起生图
 * MIT only, no AGPL
 */
import { globalShortcut, BrowserWindow } from "electron"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const GLOBAL_TOGGLE_ACCELERATOR = "CommandOrControl+Shift+L" as const
export const IMAGE_TRIGGER_PREFIX = "/" as const

// ---------------------------------------------------------------------------
// Pure helpers — renderer + main 共用，无 Electron 依赖，可单测
// ---------------------------------------------------------------------------

/**
 * 是否为生图触发：输入以 "/" 开头（允许前导空格）
 * "/" 本身也算触发（prompt 为空字符串）
 */
export function isImageTrigger(input: string): boolean {
  return input.trimStart().startsWith(IMAGE_TRIGGER_PREFIX)
}

/**
 * 提取 "/" 后的 prompt；非触发返回 null
 */
export function parseImageTrigger(input: string): string | null {
  if (!isImageTrigger(input)) return null
  return input.trimStart().slice(1).trim()
}

export type ParsedChatInput =
  | { kind: "image"; prompt: string; raw: string }
  | { kind: "chat"; text: string }

export function parseChatInput(input: string): ParsedChatInput {
  if (isImageTrigger(input)) {
    return { kind: "image", prompt: parseImageTrigger(input) ?? "", raw: input }
  }
  return { kind: "chat", text: input }
}

/**
 * 是否应通过快捷键发送：Ctrl+Enter 或 Cmd+Enter
 * - Enter + Ctrl/Meta 时发送
 * - 其它组合不发送（避免与 Shift+Enter 换行冲突）
 */
export function shouldSendOnShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  if (e.key !== "Enter") return false
  return e.ctrlKey || e.metaKey
}

/**
 * 是否应拦截 "/" 首字符唤起生图面板
 * 场景：输入框为空或仅空白时按下 "/"，或内容已以 "/" 开头
 */
export function shouldTriggerImageOnSlash(
  e: { key: string },
  currentValue: string,
): boolean {
  if (e.key !== IMAGE_TRIGGER_PREFIX) return false
  // 空输入时按 "/" 立即唤起；已有内容且以 "/" 开头也算
  const next = currentValue + "/"
  return isImageTrigger(next) || isImageTrigger(currentValue)
}

// ---------------------------------------------------------------------------
// Chat textarea keydown handler (renderer 侧可直接复用)
// ---------------------------------------------------------------------------
export type ChatShortcutActions = {
  onSend: () => void
  onImageTrigger?: (prompt: string) => void
}

/**
 * 聊天输入框 keydown 统一处理
 * - Ctrl/Cmd+Enter => onSend()
 * - "/" 首字符 => onImageTrigger(prompt)
 * 返回 true 表示已处理（调用方可 preventDefault）
 */
export function handleChatKeyDown(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault?: () => void },
  currentValue: string,
  actions: ChatShortcutActions,
): boolean {
  // Ctrl/Cmd+Enter 优先
  if (shouldSendOnShortcut(e)) {
    try {
      e.preventDefault?.()
    } catch {}
    actions.onSend()
    return true
  }
  // "/" 唤起生图：仅在输入以 "/" 开头时通知
  if (e.key === IMAGE_TRIGGER_PREFIX) {
    const next = currentValue + "/"
    // 当按下 "/" 后整体输入将成为 image trigger 时触发回调
    // 回调参数为 "/" 后的 prompt（此时多为 ""，由上层决定是否打开生图面板）
    if (isImageTrigger(next)) {
      // 延迟到值更新后也可，这里同步通知一次
      const prompt = next.trimStart().slice(1).trim()
      actions.onImageTrigger?.(prompt)
      // 不 preventDefault，让字符正常落入输入框
    }
  }
  // 另：若当前值已是 image trigger，连续输入时也可同步通知（可选）
  return false
}

// ---------------------------------------------------------------------------
// Main process — globalShortcut
// ---------------------------------------------------------------------------
export type ShortcutDeps = {
  globalShortcut: Pick<typeof globalShortcut, "register" | "unregister" | "isRegistered" | "unregisterAll">
  BrowserWindow: typeof BrowserWindow
}

export type RegisterOptions = {
  getWindow: () => InstanceType<typeof BrowserWindow> | null
  accelerator?: string
  onToggle?: () => void
  deps?: Partial<ShortcutDeps>
}

function resolveDeps(overrides?: Partial<ShortcutDeps>): ShortcutDeps {
  return {
    globalShortcut,
    BrowserWindow,
    ...overrides,
  } as ShortcutDeps
}

export function toggleMainWindow(getWindow: () => InstanceType<typeof BrowserWindow> | null): void {
  const win = getWindow()
  if (!win || (win as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) return
  try {
    if (win.isVisible()) {
      win.hide()
    } else {
      // show + focus，兼容最小化/隐藏
      if ((win as unknown as { isMinimized?: () => boolean }).isMinimized?.()) {
        try { (win as unknown as { restore: () => void }).restore() } catch {}
      }
      win.show()
      try { win.focus() } catch {}
    }
  } catch {}
}

export function registerGlobalShortcuts(opts: RegisterOptions): boolean {
  const accel = opts.accelerator ?? GLOBAL_TOGGLE_ACCELERATOR
  const deps = resolveDeps(opts.deps)
  // 先清理旧注册，避免重复
  try {
    if (deps.globalShortcut.isRegistered(accel)) {
      deps.globalShortcut.unregister(accel)
    }
  } catch {}
  try {
    const ok = deps.globalShortcut.register(accel, () => {
      try { opts.onToggle?.() } catch {}
      toggleMainWindow(opts.getWindow)
    })
    return !!ok
  } catch {
    return false
  }
}

export function unregisterGlobalShortcuts(
  accelerator: string = GLOBAL_TOGGLE_ACCELERATOR,
  depsOverrides?: Partial<ShortcutDeps>,
): void {
  const deps = resolveDeps(depsOverrides)
  try {
    if (deps.globalShortcut.isRegistered(accelerator)) {
      deps.globalShortcut.unregister(accelerator)
    }
  } catch {}
}

export function unregisterAllShortcuts(depsOverrides?: Partial<ShortcutDeps>): void {
  const deps = resolveDeps(depsOverrides)
  try { deps.globalShortcut.unregisterAll() } catch {}
}
