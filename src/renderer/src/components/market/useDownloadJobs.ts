/**
 * useDownloadJobs.ts — todo14 下载任务状态钩子
 *
 * 契约（均为既有通道，见 whitelist.ts，本任务不新增 IPC）：
 * - invoke 'models:download' {repoId, filename?} → DownloadAckReply
 * - on 'download:progress' DownloadProgressEvent {id,repoId,received,total,state,error?}
 *   total===0 表示字节总量未知 → UI 渲染不定长 shimmer 条；done 时 total===received。
 *
 * 偏差记录：后端无 download:cancel / 磁盘余量预检通道（DownloadManager 无
 * cancel API，白名单被并行 lane 冻结）→ 任务行提供 disabled 取消按钮，
 * 说明文字呈现原因，待 orchestrator 折叠后续任务。
 */
import { useCallback, useEffect, useState } from 'react'
import type { DownloadProgressEvent } from '../../../../main/ipc/whitelist'
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
      return `models:download 被拒绝 — ${formatIssues(reply)}`
    } catch (err) {
      return `models:download 调用失败 — ${err instanceof Error ? err.message : String(err)}`
    }
  }, [])

  return { jobs, isActive, start }
}
