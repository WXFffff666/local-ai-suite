/**
 * DownloadJobList.tsx — 多任务下载面板：每个 job 一行进度条 + 终态徽标
 * total===0 → 不定长 shimmer（hf-cli 事件契约：完成前无字节总量）。
 * 取消按钮为 disabled 占位：后端尚无 download:cancel 通道（todo14 偏差记录）。
 */
import type { DownloadJob } from './types'

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(1)} ${units[u]}`
}

const STATE_LABEL: Record<DownloadJob['state'], string> = {
  downloading: '下载中',
  done: '完成',
  error: '失败',
}

export type DownloadJobListProps = {
  jobs: DownloadJob[]
}

export function DownloadJobList({ jobs }: DownloadJobListProps): React.JSX.Element {
  return (
    <aside className="las-market-downloads" aria-label="下载任务">
      <h2 className="las-market-downloads-title">下载任务（{jobs.length}）</h2>
      {jobs.length === 0 ? (
        <p className="las-market-downloads-empty">暂无任务 — 从上方结果点「下载」开始。</p>
      ) : (
        <ul className="las-market-job-list">
          {jobs.map((job) => {
            const known = job.total > 0
            const pct = known ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0
            return (
              <li key={job.id} className="las-market-job" data-state={job.state} data-job-id={job.id}>
                <div className="las-market-job-head">
                  <span className="las-market-job-name" title={job.repoId}>
                    {job.name}
                  </span>
                  <span className={`las-market-job-state las-market-job-state-${job.state}`}>
                    {STATE_LABEL[job.state]}
                  </span>
                </div>
                <div
                  className={`las-market-job-bar${job.state === 'downloading' && !known ? ' las-market-job-bar-indeterminate' : ''}`}
                  role="progressbar"
                  aria-label={`${job.name} 下载进度`}
                  aria-valuemin={0}
                  aria-valuemax={known ? job.total : undefined}
                  aria-valuenow={job.received}
                >
                  <div
                    className="las-market-job-bar-fill"
                    style={
                      job.state === 'downloading' && known ? { width: `${pct}%` } : undefined
                    }
                  />
                </div>
                <div className="las-market-job-foot">
                  <span className="las-market-job-size">
                    {job.state === 'done'
                      ? `已接收 ${formatBytes(job.received)}`
                      : known
                        ? `${formatBytes(job.received)} / ${formatBytes(job.total)}`
                        : `已接收 ${formatBytes(job.received)}（总大小未知）`}
                  </span>
                  <button
                    type="button"
                    className="las-market-job-cancel"
                    disabled
                    title="后端尚未提供 download:cancel 通道（todo14 偏差：待后续任务接入）"
                  >
                    取消
                  </button>
                </div>
                {job.state === 'error' && job.error ? (
                  <p className="las-market-job-error">{job.error}</p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
