/**
 * Overwrite Coverage — main destructive entry
 * Backend guard: dialogConfirm 二次校验，Cancel 时无副作用
 */
import { showDestructiveConfirm, type DialogLike } from '../utils/dialogConfirm'

export type OverwriteCoverageBackendOptions = {
  reportId?: string
  filePath?: string
}

export async function handleOverwriteCoverage(
  dialog: DialogLike,
  options: OverwriteCoverageBackendOptions,
  performOverwrite: (opts: OverwriteCoverageBackendOptions) => Promise<void>
): Promise<{ cancelled: boolean }> {
  if (!options || typeof options !== 'object') throw new Error('options required')

  const target = options.filePath ?? options.reportId ?? '当前覆盖率报告'
  const confirmed = await showDestructiveConfirm(dialog, {
    title: '覆盖率覆盖确认',
    message: `确认覆盖 ${target}？`,
    detail: '此操作将覆盖现有覆盖率数据，旧数据不可恢复',
    confirmText: '覆盖',
    cancelText: '取消'
  })

  if (!confirmed) return { cancelled: true }

  await performOverwrite(options)
  return { cancelled: false }
}

export function createOverwriteCoverageHandler(
  dialog: DialogLike,
  performOverwrite: (opts: OverwriteCoverageBackendOptions) => Promise<void>
) {
  return async (args: unknown[]): Promise<{ cancelled: boolean }> => {
    const opts = (args[0] as OverwriteCoverageBackendOptions) ?? {}
    return handleOverwriteCoverage(dialog, opts, performOverwrite)
  }
}
