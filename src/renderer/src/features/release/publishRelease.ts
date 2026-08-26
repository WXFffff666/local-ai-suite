/**
 * Publish Release — renderer destructive entry
 * Frontend guard: showDestructiveConfirm 前置校验，Cancel 时无副作用
 * Publishing is destructive (irreversible public exposure)
 */
import { showDestructiveConfirm } from '../../../utils/confirm'

export type PublishReleaseOptions = {
  version: string
  tag?: string
  notes?: string
}

export type ApiLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

export async function publishRelease(
  options: PublishReleaseOptions,
  deps: {
    api?: ApiLike
    performPublish?: (opts: PublishReleaseOptions) => Promise<void>
  } = {}
): Promise<boolean> {
  if (!options || typeof options.version !== 'string' || options.version.trim().length === 0) {
    throw new Error('version required')
  }

  const ver = options.tag ?? options.version
  const confirmed = await showDestructiveConfirm(
    {
      title: '发布版本确认',
      message: `确认发布 Release ${ver}？`,
      detail: '发布后将公开推送到所有用户，此操作不可撤回',
      confirmText: '发布',
      cancelText: '取消'
    },
    deps.api as never
  )

  if (!confirmed) return false

  if (deps.performPublish) {
    await deps.performPublish(options)
  } else if (deps.api) {
    await deps.api.invoke('release:publish', options)
  }

  return true
}

export const handlePublishRelease = publishRelease
