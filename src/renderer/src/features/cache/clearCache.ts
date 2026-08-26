/**
 * Clear Cache — renderer destructive entry
 * Frontend guard: showDestructiveConfirm 前置校验，Cancel 时无副作用
 */
import { showDestructiveConfirm } from '../../../utils/confirm'

export type ClearCacheOptions = {
  scope?: string
  cacheDir?: string
}

export type ApiLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

export async function clearCache(
  options: ClearCacheOptions = {},
  deps: {
    api?: ApiLike
    performClear?: (opts: ClearCacheOptions) => Promise<void>
  } = {}
): Promise<boolean> {
  const target = options.scope ?? options.cacheDir ?? '全部缓存'
  const confirmed = await showDestructiveConfirm(
    {
      title: '清空缓存确认',
      message: `确认清空 ${target}？`,
      detail: '将删除本地缓存文件与索引，可能影响离线加载速度',
      confirmText: '清空',
      cancelText: '取消'
    },
    deps.api as never
  )

  if (!confirmed) return false

  if (deps.performClear) {
    await deps.performClear(options)
  } else if (deps.api) {
    await deps.api.invoke('cache:clear', options)
  }

  return true
}

export const handleClearCache = clearCache
