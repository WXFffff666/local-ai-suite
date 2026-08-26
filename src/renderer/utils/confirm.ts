/**
 * Renderer-side destructive confirm wrapper.
 * Performs frontend first validation, then delegates to main via IPC.
 * Backend performs second validation + native warning dialog.
 */

export type DestructiveConfirmOptions = {
  title?: string
  message: string
  detail?: string
  confirmText?: string
  cancelText?: string
}

export type ApiLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

function getApi(api?: ApiLike): ApiLike {
  if (api) return api
  const w = typeof window !== 'undefined' ? (window as unknown as { api?: ApiLike }) : undefined
  if (w?.api?.invoke) return w.api
  throw new Error('window.api not available — preload not bridged')
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
 * Frontend wrapper for destructive confirmation.
 * - Validates options locally (first check)
 * - Invokes 'dialog:confirmDestructive' which validates again in main (second check) and shows native warning dialog
 * - Returns true only if user confirmed (response === 1 in main)
 */
export async function confirmDestructive(
  options: DestructiveConfirmOptions,
  api?: ApiLike
): Promise<boolean> {
  assertValidOptions(options)
  const target = getApi(api)
  const result = await target.invoke('dialog:confirmDestructive', options)
  return result === true
}

/**
 * Alias for consistency with task naming — showDestructiveConfirm
 */
export const showDestructiveConfirm = confirmDestructive

export function isConfirmOptionsValid(options: unknown): boolean {
  try {
    assertValidOptions(options)
    return true
  } catch {
    return false
  }
}
