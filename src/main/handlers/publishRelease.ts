/**
 * Publish Release — main destructive entry
 * Backend guard: dialogConfirm 二次校验，Cancel 时无副作用
 */
import { showDestructiveConfirm, type DialogLike } from '../utils/dialogConfirm'

export type PublishReleaseBackendOptions = {
  version: string
  tag?: string
  notes?: string
}

export async function handlePublishRelease(
  dialog: DialogLike,
  options: PublishReleaseBackendOptions,
  performPublish: (opts: PublishReleaseBackendOptions) => Promise<void>
): Promise<{ cancelled: boolean }> {
  if (!options || typeof options.version !== 'string' || options.version.trim().length === 0) {
    throw new Error('version required')
  }

  const ver = options.tag ?? options.version
  const confirmed = await showDestructiveConfirm(dialog, {
    title: '发布版本确认',
    message: `确认发布 Release ${ver}？`,
    detail: '发布后将公开推送到所有用户，此操作不可撤回',
    confirmText: '发布',
    cancelText: '取消'
  })

  if (!confirmed) return { cancelled: true }

  await performPublish(options)
  return { cancelled: false }
}

export function createPublishReleaseHandler(
  dialog: DialogLike,
  performPublish: (opts: PublishReleaseBackendOptions) => Promise<void>
) {
  return async (args: unknown[]): Promise<{ cancelled: boolean }> => {
    const opts = args[0] as PublishReleaseBackendOptions
    return handlePublishRelease(dialog, opts, performPublish)
  }
}
