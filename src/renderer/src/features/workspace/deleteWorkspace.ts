/**
 * Delete Workspace — renderer destructive entry
 * Frontend guard: showDestructiveConfirm 前置校验，Cancel 时无副作用
 * Must delegate to main via dialog:confirmDestructive (second validation in main)
 */
import { showDestructiveConfirm } from '../../../utils/confirm'

export type DeleteWorkspaceOptions = {
  workspaceId: string
  workspaceName?: string
}

export type ApiLike = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

/**
 * Frontend Delete Workspace with double-check guard.
 * - Calls showDestructiveConfirm first (frontend validation)
 * - Backend validates again before showing native dialog
 * - If user cancels (confirmed === false) => no side effect, returns false
 * - If confirmed => performs destructive action via performDelete or IPC
 */
export async function deleteWorkspace(
  options: DeleteWorkspaceOptions,
  deps: {
    api?: ApiLike
    performDelete?: (id: string) => Promise<void>
  } = {}
): Promise<boolean> {
  const { workspaceId, workspaceName } = options
  if (!workspaceId || typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new Error('workspaceId required')
  }

  const label = workspaceName ?? workspaceId
  const confirmed = await showDestructiveConfirm(
    {
      title: '删除工作区',
      message: `确认删除工作区 ${label}？`,
      detail: '此操作不可恢复，将永久删除工作区及关联数据、聊天记录与配置',
      confirmText: '删除',
      cancelText: '取消'
    },
    deps.api as never
  )

  if (!confirmed) return false

  if (deps.performDelete) {
    await deps.performDelete(workspaceId)
  } else if (deps.api) {
    await deps.api.invoke('workspace:delete', workspaceId)
  }

  return true
}

/** Alias to satisfy naming convention */
export const handleDeleteWorkspace = deleteWorkspace
