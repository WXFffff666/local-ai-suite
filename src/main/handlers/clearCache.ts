/**
 * Clear Cache — main destructive entry
 * Backend guard: dialogConfirm 二次校验，Cancel 时无副作用
 */
import { showDestructiveConfirm, type DialogLike } from '../utils/dialogConfirm'

export type ClearCacheBackendOptions = {
  scope?: string
  cacheDir?: string
}

export async function handleClearCache(
  dialog: DialogLike,
  options: ClearCacheBackendOptions,
  performClear: (opts: ClearCacheBackendOptions) => Promise<void>
): Promise<{ cancelled: boolean }> {
  const target = options?.scope ?? options?.cacheDir ?? '全部缓存'
  const confirmed = await showDestructiveConfirm(dialog, {
    title: '清空缓存确认',
    message: `确认清空 ${target}？`,
    detail: '将删除本地缓存文件与索引，可能影响离线加载速度',
    confirmText: '清空',
    cancelText: '取消'
  })

  if (!confirmed) return { cancelled: true }

  await performClear(options ?? {})
  return { cancelled: false }
}

export function createClearCacheHandler(
  dialog: DialogLike,
  performClear: (opts: ClearCacheBackendOptions) => Promise<void>
) {
  return async (args: unknown[]): Promise<{ cancelled: boolean }> => {
    const opts = (args[0] as ClearCacheBackendOptions) ?? {}
    return handleClearCache(dialog, opts, performClear)
  }
}
