/**
 * Destructive confirm dialog — centralizes dialog.showMessageBox usage.
 * MUST be the single place where showMessageBox is called for destructive actions.
 * Double validation: frontend validates before IPC, backend validates again here.
 */
export type DestructiveConfirmOptions = {
  /** Dialog title, fallback to '确认操作' */
  title?: string
  /** Main message (required, non-empty) */
  message: string
  /** Detail / extended description */
  detail?: string
  /** Confirm button text, default '确认删除' / '确认' */
  confirmText?: string
  /** Cancel button text, default '取消' */
  cancelText?: string
}

export type DialogLike = {
  showMessageBox: (
    options: Electron.MessageBoxOptions
  ) => Promise<Electron.MessageBoxReturnValue>
  // support optional BrowserWindow overload — we only use single-arg form
}

function assertValidOptions(options: unknown): asserts options is DestructiveConfirmOptions {
  if (!options || typeof options !== 'object') {
    throw new Error('confirm options required')
  }
  const o = options as Record<string, unknown>
  if (typeof o.message !== 'string' || o.message.trim().length === 0) {
    throw new Error('message must be a non-empty string')
  }
  if (o.title !== undefined && typeof o.title !== 'string') {
    throw new Error('title must be a string')
  }
  if (o.detail !== undefined && typeof o.detail !== 'string') {
    throw new Error('detail must be a string')
  }
  if (o.confirmText !== undefined && typeof o.confirmText !== 'string') {
    throw new Error('confirmText must be a string')
  }
  if (o.cancelText !== undefined && typeof o.cancelText !== 'string') {
    throw new Error('cancelText must be a string')
  }
}

/**
 * Show a destructive confirmation dialog.
 * - type: 'warning'
 * - buttons: [cancel, confirm] — cancel is default & cancelId
 * - resolves true only when response === 1 (user pressed confirm)
 */
export async function showDestructiveConfirm(
  dialog: DialogLike,
  options: DestructiveConfirmOptions
): Promise<boolean> {
  assertValidOptions(options)

  const cancelText = options.cancelText ?? '取消'
  const confirmText = options.confirmText ?? '确认删除'

  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: [cancelText, confirmText],
    defaultId: 0,
    cancelId: 0,
    title: options.title ?? '确认操作',
    message: options.message,
    detail: options.detail,
    noLink: true
  })

  return result.response === 1
}

/**
 * Create IPC handler for 'dialog:confirmDestructive'.
 * Performs backend double-validation via assertValidOptions + delegates to showDestructiveConfirm.
 * Supports both calling conventions:
 * - ipcMain.handle: (_event, ...args) => handler(args)
 * - direct: handler(event, opts)
 */
export function createDestructiveConfirmHandler(dialog: DialogLike) {
  const handler = async (...allArgs: unknown[]): Promise<boolean> => {
    // Extract real payload: if called as (event, opts) or (argsArray) or (opts)
    let rawOptions: unknown
    if (allArgs.length === 1 && Array.isArray(allArgs[0])) {
      rawOptions = (allArgs[0] as unknown[])[0]
    } else if (allArgs.length === 2) {
      rawOptions = allArgs[1]
    } else {
      rawOptions = allArgs[0]
    }
    assertValidOptions(rawOptions)
    return showDestructiveConfirm(dialog, rawOptions as DestructiveConfirmOptions)
  }
  return handler as unknown as (args: unknown[]) => Promise<unknown>
}
