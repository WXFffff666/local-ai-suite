/**
 * Delete Conversation — renderer destructive entry (todo17).
 * Same double-check template as features/workspace/deleteWorkspace.ts:
 * frontend validation → dialog:confirmDestructive (main re-validates + native
 * warning) → only then the conversations:delete IPC (cascades messages in main).
 * Cancel ⇒ no side effect, returns false.
 */
import { showDestructiveConfirm } from '../../../utils/confirm'
import { deleteConversationRow, getApi, type InvokeFn } from './api'

export type DeleteConversationOptions = {
  conversationId: string
  conversationTitle?: string
}

export async function deleteConversationGuarded(
  options: DeleteConversationOptions,
  deps: { invoke?: InvokeFn } = {}
): Promise<boolean> {
  const { conversationId, conversationTitle } = options
  if (!conversationId || conversationId.trim().length === 0) {
    throw new Error('conversationId required')
  }

  const invoke = deps.invoke ?? getApi()
  if (!invoke) throw new Error('window.api not available — preload not bridged')

  const label = conversationTitle ?? conversationId
  const confirmed = await showDestructiveConfirm(
    {
      title: '删除会话',
      message: `确认删除会话「${label}」？`,
      detail: '此操作不可恢复，将永久删除该会话及其全部消息',
      confirmText: '删除',
      cancelText: '取消'
    },
    // confirm.ts's ApiLike takes an { invoke } object; AllowedChannel ⊂ string
    { invoke: invoke as unknown as (channel: string, ...args: unknown[]) => Promise<unknown> }
  )

  if (!confirmed) return false

  await deleteConversationRow(invoke, conversationId)
  return true
}
