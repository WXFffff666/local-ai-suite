/**
 * ConversationSidebar.tsx — todo17 会话侧栏（聊天页左侧）。
 * 数据源是 chat.db（经 conversations:* IPC），store 只是它的渲染视图：
 *   mount → list（空则 create）→ 选中首个并 listMessages 注入 store；
 *   选中 → loadConversation；新建 → create；重命名 → 行内输入 + conversations:rename；
 *   删除 → deleteConversationGuarded（dialog:confirmDestructive 二次确认）→ 级联删消息。
 * 无 window.api（纯浏览器/vitest 裸环境）降级为诚实提示，不抛错。
 * 错误统一进 error 横幅（role="alert"），绝不自愈假装成功。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '../../../../chat/store'
import type { ChatMessage, ChatSession } from '../../../../chat/types'
import {
  createConversation,
  getApi,
  listConversations,
  listMessages,
  renameConversation,
  type ConversationMeta
} from './api'
import { deleteConversationGuarded } from './deleteConversation'

type Busy = boolean

export function ConversationSidebar(): React.JSX.Element {
  const [conversations, setConversations] = useState<ConversationMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const mounted = useRef(true)

  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const loadConversation = useChatStore((s) => s.loadConversation)
  const renameSession = useChatStore((s) => s.renameSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const fail = useCallback((e: unknown): void => {
    if (!mounted.current) return
    setError(e instanceof Error ? e.message : String(e))
  }, [])

  const select = useCallback(
    async (meta: ConversationMeta): Promise<void> => {
      const invoke = getApi()
      if (!invoke) return
      try {
        const messages = await listMessages(invoke, meta.id)
        if (!mounted.current) return
        const session: ChatSession = {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          messages: messages.map(
            (m): ChatMessage => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })
          )
        }
        loadConversation(session)
        setError(null)
      } catch (e: unknown) {
        fail(e)
      }
    },
    [fail, loadConversation]
  )

  // mount：list + 空则 create + 选中首个（plan FLOW）
  useEffect(() => {
    const invoke = getApi()
    if (!invoke) return
    void (async () => {
      setBusy(true)
      try {
        let items = await listConversations(invoke)
        if (items.length === 0) {
          const created = await createConversation(invoke)
          items = [created]
        }
        if (!mounted.current) return
        setConversations(items)
        const first = items[0]
        if (first && useChatStore.getState().activeConversationId === null) {
          await select(first)
        }
      } catch (e: unknown) {
        fail(e)
      } finally {
        if (mounted.current) setBusy(false)
      }
    })()
  }, [fail, select])

  const handleNew = useCallback(async (): Promise<void> => {
    const invoke = getApi()
    if (!invoke) return
    setBusy(true)
    try {
      const created = await createConversation(invoke)
      if (!mounted.current) return
      setConversations((prev) => [created, ...prev])
      await select(created)
    } catch (e: unknown) {
      fail(e)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [fail, select])

  const handleDelete = useCallback(
    async (meta: ConversationMeta): Promise<void> => {
      try {
        const removed = await deleteConversationGuarded({
          conversationId: meta.id,
          conversationTitle: meta.title
        })
        if (!removed || !mounted.current) return
        deleteSession(meta.id)
        const next = conversations.filter((c) => c.id !== meta.id)
        setConversations(next)
        if (activeConversationId === meta.id) {
          const fallback = next[0]
          if (fallback) {
            await select(fallback)
          } else {
            setActiveConversation(null)
            const invoke = getApi()
            if (invoke) {
              const created = await createConversation(invoke)
              if (mounted.current) setConversations([created])
              await select(created)
            }
          }
        }
      } catch (e: unknown) {
        fail(e)
      }
    },
    [activeConversationId, conversations, fail, select, setActiveConversation, deleteSession]
  )

  const commitRename = useCallback(
    async (meta: ConversationMeta): Promise<void> => {
      const invoke = getApi()
      setRenamingId(null)
      if (!invoke) return
      const title = renameValue.trim()
      if (!title || title === meta.title) return
      try {
        const updated = await renameConversation(invoke, meta.id, title)
        if (!mounted.current) return
        setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
        renameSession(updated.id, updated.title)
      } catch (e: unknown) {
        fail(e)
      }
    },
    [fail, renameSession, renameValue]
  )

  const apiAvailable = getApi() !== null

  return (
    <aside
      aria-label="conversations"
      style={{
        width: 220,
        flexShrink: 0,
        borderRight: '1px solid #222',
        padding: 12,
        background: '#0f0f0f',
        color: '#ddd',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 0
      }}
    >
      <button
        onClick={() => void handleNew()}
        disabled={!apiAvailable || busy}
        style={{ width: '100%', padding: '8px 10px', marginBottom: 6, cursor: 'pointer' }}
      >
        + 新会话
      </button>

      {!apiAvailable && (
        <div style={{ color: '#f0b4b4', fontSize: 12 }}>桌面端运行时才有会话持久化（window.api 不可用）</div>
      )}

      {error && (
        <div role="alert" style={{ color: '#f88', fontSize: 12, padding: '6px 8px', border: '1px solid #4a2a2a', borderRadius: 6 }}>
          {error}
        </div>
      )}

      {conversations.length === 0 && apiAvailable && !error && (
        <div style={{ color: '#666', fontSize: 12 }}>{busy ? '加载中…' : '暂无会话'}</div>
      )}

      {conversations.map((c) => (
        <div
          key={c.id}
          onClick={() => void select(c)}
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            background: c.id === activeConversationId ? '#1e1e1e' : 'transparent',
            border: '1px solid #2a2a2a',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 6
          }}
        >
          {renamingId === c.id ? (
            <input
              autoFocus
              value={renameValue}
              aria-label="rename-input"
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitRename(c)
                if (e.key === 'Escape') setRenamingId(null)
              }}
              onBlur={() => void commitRename(c)}
              style={{ flex: 1, minWidth: 0, background: '#111', color: '#eee', border: '1px solid #334', borderRadius: 4, padding: '2px 4px' }}
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation()
                setRenamingId(c.id)
                setRenameValue(c.title)
              }}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
              title={c.title}
            >
              {c.title}
            </span>
          )}
          <button
            aria-label={`rename-${c.id}`}
            onClick={(e) => {
              e.stopPropagation()
              setRenamingId(c.id)
              setRenameValue(c.title)
            }}
            style={{ background: 'transparent', color: '#888', border: 'none', cursor: 'pointer' }}
          >
            ✎
          </button>
          <button
            aria-label={`delete-${c.id}`}
            onClick={(e) => {
              e.stopPropagation()
              void handleDelete(c)
            }}
            style={{ background: 'transparent', color: '#888', border: 'none', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>
      ))}
    </aside>
  )
}

export default ConversationSidebar
