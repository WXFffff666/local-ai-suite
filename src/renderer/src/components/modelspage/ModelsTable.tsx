/**
 * ModelsTable.tsx — todo13 模型注册表表格
 * 列：name / arch / quant / format / size；corrupted 徽标（registry 字段透出），
 * 无 corrupted 字段时以 format==='unknown' 派生「格式未识别」弱徽标。
 *
 * todo30b（加性扩展）：llm GGUF 行新增「启动」按钮 → invoke('models:launch',
 * {modelId})（registry→llama 侧车热切换的 21→30 跳，main 侧 services.launchModel）；
 * 成功应答显示运行态徽标，失败行内呈现错误。生图权重（diffusion/ 前缀）与
 * 损坏/非 GGUF 行不渲染按钮。
 */
import { useState } from 'react'
import { formatSize, type ModelRow } from './types'
import type { ModelsLaunchReply } from '../../../../main/ipc/whitelist'

export type ModelsTableProps = {
  models: ModelRow[]
}

type LaunchState = 'launching' | { ok: true; running: boolean } | { ok: false; error: string }

/** llm 可启动行：GGUF、未损坏、且不在 diffusion/ 生图前缀下。 */
function isLaunchable(m: ModelRow): boolean {
  return m.format === 'gguf' && m.corrupted !== true && !m.file.startsWith('diffusion/')
}

export function ModelsTable({ models }: ModelsTableProps): React.JSX.Element {
  const [launches, setLaunches] = useState<Record<string, LaunchState>>({})
  if (models.length === 0) {
    return <p className="las-models-empty">模型目录为空 — 从 Market 页下载，或把 GGUF / safetensors 文件拖入模型目录。</p>
  }
  const launch = async (modelId: string): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    setLaunches((l) => ({ ...l, [modelId]: 'launching' }))
    try {
      const reply = (await api.invoke('models:launch', { modelId })) as ModelsLaunchReply
      setLaunches((l) => ({
        ...l,
        [modelId]: reply?.ok === true ? { ok: true, running: reply.status.running } : { ok: false, error: reply.ok === false ? reply.error : '应答格式异常' },
      }))
    } catch (e) {
      setLaunches((l) => ({ ...l, [modelId]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    }
  }
  return (
    <table className="las-models-table" aria-label="本地模型列表">
      <thead>
        <tr>
          <th>名称</th>
          <th>架构</th>
          <th>量化</th>
          <th>格式</th>
          <th className="las-models-size">大小</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const corrupted = m.corrupted === true
          const unrecognized = !corrupted && m.format === 'unknown'
          const launchState = launches[m.name]
          return (
            <tr key={m.file} data-corrupted={corrupted ? 'true' : undefined}>
              <td className="las-models-name" title={m.path}>
                {m.name}
              </td>
              <td>{m.arch}</td>
              <td>{m.quant}</td>
              <td>{m.format}</td>
              <td className="las-models-size">{formatSize(m.size)}</td>
              <td>
                {corrupted ? (
                  <span className="las-models-badge las-models-badge-corrupt" title={m.error ?? '文件头探针失败，已隔离'}>
                    损坏（已隔离）
                  </span>
                ) : unrecognized ? (
                  <span className="las-models-badge las-models-badge-unknown">格式未识别</span>
                ) : (
                  <span className="las-models-ok">正常</span>
                )}
              </td>
              <td>
                {isLaunchable(m) ? (
                  <>
                    <button
                      type="button"
                      className="las-models-launch"
                      data-model={m.name}
                      disabled={launchState === 'launching'}
                      title="加载进 llama 侧车（含 mmproj 配对）"
                      onClick={() => void launch(m.name)}
                    >
                      {launchState === 'launching' ? '启动中…' : '启动'}
                    </button>
                    {launchState !== undefined && launchState !== 'launching' ? (
                      launchState.ok ? (
                        <span className="las-models-badge las-models-launch-ok">{launchState.running ? '运行中' : '启动中'}</span>
                      ) : (
                        <span className="las-models-badge las-models-launch-err" role="alert" title={launchState.error}>
                          启动失败
                        </span>
                      )
                    ) : null}
                  </>
                ) : null}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
