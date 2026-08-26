/**
 * Delete Workspace — main destructive entry
 * Backend guard: dialogConfirm 二次校验，Cancel 时无副作用
 * MUST use showDestructiveConfirm as single validated dialog entry
 */
import { showDestructiveConfirm, type DialogLike } from '../utils/dialogConfirm'

export type DeleteWorkspaceBackendOptions = {
  workspaceId: string
}

/**
 * Backend Delete Workspace with double-check guard.
 * - Validates via showDestructiveConfirm (assertValidOptions + native dialog)
 * - If user cancels (confirmed === false) => returns cancelled:true with no side effect
 * - If confirmed => invokes performDelete
 */
export async function handleDeleteWorkspace(
  dialog: DialogLike,
  options: DeleteWorkspaceBackendOptions,
  performDelete: (id: string) => Promise<void>
): Promise<{ cancelled: boolean }> {
  if (!options || typeof options.workspaceId !== 'string' || options.workspaceId.trim().length === 0) {
    throw new Error('workspaceId required')
  }

  const confirmed = await showDestructiveConfirm(dialog, {
    title: '删除工作区',
    message: `确认删除工作区 ${options.workspaceId}？`,
    detail: '此操作不可恢复，将永久删除工作区及关联数据',
    confirmText: '删除',
    cancelText: '取消'
  })

  if (!confirmed) return { cancelled: true }

  await performDelete(options.workspaceId)
  return { cancelled: false }
}

/**
 * IPC handler factory for 'workspace:delete'
 * Ensures channel payload passes through backend guard
 */
export function createDeleteWorkspaceHandler(
  dialog: DialogLike,
  performDelete: (id: string) => Promise<void>
) {
  return async (args: unknown[]): Promise<{ cancelled: boolean }> => {
    const opts = args[0] as DeleteWorkspaceBackendOptions
    return handleDeleteWorkspace(dialog, opts, performDelete)
  }
}
