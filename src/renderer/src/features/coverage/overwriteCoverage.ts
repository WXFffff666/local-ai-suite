/**
 * Overwrite Coverage — renderer destructive entry
 * Frontend guard: showDestructiveConfirm 前置校验，Cancel 时无副作用
 */
import { showDestructiveConfirm } from '../../../utils/confirm'

export type OverwriteCoverageOptions = {
  reportId?: string
  filePath?: string
}

export type ApiLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

/**
 * Frontend Overwrite Coverage with double-check guard.
 * Cancel => no side effect.
 */
export async function overwriteCoverage(
  options: OverwriteCoverageOptions,
  deps: {
    api?: ApiLike
    performOverwrite?: (opts: OverwriteCoverageOptions) => Promise<void>
  } = {}
): Promise<boolean> {
  if (!options || typeof options !== 'object') throw new Error('options required')

  const target = options.filePath ?? options.reportId ?? '当前覆盖率报告'
  const confirmed = await showDestructiveConfirm(
    {
      title: '覆盖率覆盖确认',
      message: `确认覆盖 ${target}？`,
      detail: '此操作将覆盖现有覆盖率数据，旧数据不可恢复',
      confirmText: '覆盖',
      cancelText: '取消'
    },
    deps.api as never
  )

  if (!confirmed) return false

  if (deps.performOverwrite) {
    await deps.performOverwrite(options)
  } else if (deps.api) {
    await deps.api.invoke('coverage:overwrite', options)
  }

  return true
}

export const handleOverwriteCoverage = overwriteCoverage
