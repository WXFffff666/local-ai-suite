/**
 * MessageList.tsx — todo15 消息列表 + 自动滚动
 * 双路径同一气泡（MessageBubble）：
 *  - ≤ VIRTUALIZE_THRESHOLD 条：普通滚动容器（短会话零虚拟化开销；jsdom 可测）；
 *  - > 阈值：react-virtuoso —— followOutput('smooth') 仅在贴底时跟随新消息，
 *    用户上滚即停（atBottomStateChange），流式内容增量经 tailKey 效应贴底，
 *    离底时浮出 "Jump to latest" 药丸。挂载锚底由 tailKey 效应的
 *    scrollToIndex('LAST') 完成（不用 initialTopMostItemIndex：
 *    VirtuosoMockContext 下该 prop 会卡住窗口渲染）。
 * 阈值切换非双标：virtuoso 在 0 高度环境（SSR/jsdom）不渲染任何条目，
 * 短列表走 plain 同时是测试稳定性的保障（组件测试用 VirtuosoMockContext 验证长列表）。
 */
import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { ChatMessage } from '../../../../chat/types'
import { MessageBubble } from './MessageBubble'

/** 超过该条数启用虚拟化（500 条验收场景必然命中） */
export const VIRTUALIZE_THRESHOLD = 50
/** 贴底判定容差（px） */
export const AT_BOTTOM_EPS = 24

export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= AT_BOTTOM_EPS
}

export type MessageListProps = {
  messages: ChatMessage[]
}

export function MessageList({ messages }: MessageListProps): React.JSX.Element {
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const plainRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const virtualized = messages.length > VIRTUALIZE_THRESHOLD

  const markBottom = useCallback((bottom: boolean) => {
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }, [])

  const onPlainScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    markBottom(isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight))
  }, [markBottom])

  const jumpToLatest = useCallback((smooth: boolean) => {
    markBottom(true)
    if (virtualized) {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: smooth ? 'smooth' : 'auto' })
    } else {
      const el = plainRef.current
      if (!el) return
      if (typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
      } else {
        // jsdom / 旧内核无 Element.scrollTo：直写 scrollTop 等价即时贴底
        el.scrollTop = el.scrollHeight
      }
    }
  }, [virtualized, markBottom])

  // 新消息与流式增量都归到 tailKey：贴底则跟随到底部，用户上滚则静止
  const last = messages[messages.length - 1]
  const tailKey = `${last?.id ?? ''}:${last?.content.length ?? 0}:${last?.reasoning?.length ?? 0}`
  useEffect(() => {
    if (atBottomRef.current) jumpToLatest(false)
  }, [tailKey, virtualized, jumpToLatest])

  if (messages.length === 0) {
    return <div className="las-msglist-empty-hint" />
  }

  return (
    <div className="las-msglist-wrap">
      {virtualized ? (
        <Virtuoso
          ref={virtuosoRef}
          data={messages}
          computeItemKey={(_i, m) => m.id}
          itemContent={(_i, m) => <MessageBubble message={m} />}
          followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
          atBottomStateChange={markBottom}
          atBottomThreshold={AT_BOTTOM_EPS}
          increaseViewportBy={{ top: 160, bottom: 160 }}
          style={{ height: '100%' }}
          scrollerRef={(el) => {
            if (el instanceof HTMLElement) el.setAttribute('data-testid', 'message-scroller')
          }}
        />
      ) : (
        <div ref={plainRef} data-testid="message-scroller" className="las-msglist-plain" onScroll={onPlainScroll}>
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>
      )}
      {!atBottom && (
        <button type="button" className="las-jump-pill" onClick={() => jumpToLatest(true)}>
          ↓ Jump to latest
        </button>
      )}
    </div>
  )
}

export default MessageList
