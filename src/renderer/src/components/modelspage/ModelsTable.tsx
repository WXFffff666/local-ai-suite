/**
 * ModelsTable.tsx — todo13 模型注册表表格
 * 列：name / arch / quant / format / size；corrupted 徽标（registry 字段透出），
 * 无 corrupted 字段时以 format==='unknown' 派生「格式未识别」弱徽标。
 */
import { formatSize, type ModelRow } from './types'

export type ModelsTableProps = {
  models: ModelRow[]
}

export function ModelsTable({ models }: ModelsTableProps): React.JSX.Element {
  if (models.length === 0) {
    return <p className="las-models-empty">模型目录为空 — 从 Market 页下载，或把 GGUF / safetensors 文件拖入模型目录。</p>
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
        </tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const corrupted = m.corrupted === true
          const unrecognized = !corrupted && m.format === 'unknown'
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
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
