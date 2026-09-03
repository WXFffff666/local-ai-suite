/**
 * useDownloadJobs.ts — todo14 下载任务状态钩子（14b 补全取消 + 预检呈现）
 *
 * 契约（均为白名单通道，见 whitelist.ts）：
 * - invoke 'models:download' {repoId, filename?} → DownloadAckReply
 *   14b: 磁盘预检不足时应答 {ok:false,error:'insufficient-disk',free,needed}。
 * - invoke 'download:cancel' {id} → {ok:true,id,cancelled} | {ok:false,error:'not-found'}
 * - on 'download:progress' DownloadProgressEvent {id,repoId,received,total,state,state:'cancelled'终态}
 *   total===0 表示字节总量未知 → UI 渲染不定长 shimmer 条；done 时 total===received。
 */
import { useCallback, useEffect, useState } from 'react'
import type { DownloadProgressEvent } from '../../../../main/ipc/whitelist'
import { formatBytes } from './DownloadJobList'
import {
  formatIssues,
  type DownloadAckReply,
  type DownloadJob,
  type MarketModelCard,
} from './types'

/** download:progress → 任务表 upsert（未知 id 的事件也接纳，main 侧可自发）。 */
export function applyProgress(prev: DownloadJob[], e: DownloadProgressEvent): DownloadJob[] {
  const idx = prev.findIndex((j) => j.id === e.id)
  if (idx === -1) {
    return [
      {
        id: e.id,
        repoId: e.repoId,
        name: e.repoId,
        received: e.received,
        total: e.total,
        state: e.state,
        ...(e.error === undefined ? {} : { error: e.error }),
      },
      ...prev,
    ]
  }
  const hit = prev[idx]
  const next = prev.slice()
  next[idx] = {
    ...hit,
    received: e.received,
    total: e.total,
    state: e.state,
    // 非 error 事件不清除既有错误消息（done/error 终态互斥，防御性保留）
    ...(e.error === undefined ? {} : { error: e.error }),
  }
  return next
}

export type UseDownloadJobs = {
  jobs: DownloadJob[]
  /** 该 repo 是否有进行中任务 → 卡片 Download 按钮去重禁用。 */
  isActive: (repoId: string) => boolean
  /** 发起下载；返回 null=已受理，字符串=立即可见的错误消息。 */
  start: (card: MarketModelCard) => Promise<string | null>
  /** 14b：取消会话（树杀子进程）；返回 null=已取消，字符串=错误消息。 */
  cancel: (id: string) => Promise<string | null>
}

export function useDownloadJobs(): UseDownloadJobs {
  const [jobs, setJobs] = useState<DownloadJob[]>([])

  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    return api.on('download:progress', (e: DownloadProgressEvent) => {
      setJobs((prev) => applyProgress(prev, e))
    })
  }, [])

  const isActive = useCallback(
    (repoId: string) => jobs.some((j) => j.repoId === repoId && j.state === 'downloading'),
    [jobs],
  )

  const start = useCallback(async (card: MarketModelCard): Promise<string | null> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return '未检测到 window.api — 市场下载仅在 Electron 主窗口内可用'
    try {
      const reply = (await api.invoke('models:download', {
        repoId: card.repoId,
        ...(card.filename === undefined ? {} : { filename: card.filename }),
      })) as DownloadAckReply
      if (reply.ok) return null
      if (reply.error === 'insufficient-disk') {
        return `磁盘空间不足 — 需要 ${formatBytes(reply.needed)}（含 1.1× 余量），仅剩 ${formatBytes(reply.free)}，下载已拒绝`
      }
      return `models:download 被拒绝 — ${formatIssues(reply)}`
    } catch (err) {
      return `models:download 调用失败 — ${err instanceof Error ? err.message : String(err)}`
    }
  }, [])

  const cancel = useCallback(async (id: string): Promise<string | null> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return '未检测到 window.api — 无法取消'
    try {
      const reply = (await api.invoke('download:cancel', { id })) as
        | { ok: true; id: string; cancelled: true }
        | { ok: false; error: string }
      if (reply.ok) return null // 终态 'cancelled' 事件随即将更新任务行
      return reply.error === 'not-found' ? '任务已结束或不存在 — 无需取消' : `download:cancel 被拒绝 — ${reply.error}`
    } catch (err) {
      return `download:cancel 调用失败 — ${err instanceof Error ? err.message : String(err)}`
    }
  }, [])

  return { jobs, isActive, start, cancel }
}
