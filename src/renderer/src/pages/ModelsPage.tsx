/**
 * ModelsPage.tsx — todo13 模型管理页
 *
 * 数据流：
 *   mount → invoke('config:get') → {config.modelsDir} → 目录控件初值
 *   mount → invoke('models:list') → ModelRow[] → ModelsTable（损坏徽标透出 registry.corrupted）
 *   目录切换 → invoke('models:setDir',{path}) → {ok,models,restartRequired} → 表刷新 + 重启提示
 *   手动刷新 → invoke('models:list')
 *
 * 不做下载（归 Market 页 todo14）。非 Electron 环境（window.api 缺失）诚实降级。
 */
import { useCallback, useEffect, useState } from 'react'
import '../components/modelspage/modelspage.css'
import { ModelsTable } from '../components/modelspage/ModelsTable'
import { DirControl } from '../components/modelspage/DirControl'
import type { ConfigGetReply, ModelsListReply, ModelRow, SetDirReply } from '../components/modelspage/types'

export function ModelsPage(): React.JSX.Element {
  const [models, setModels] = useState<ModelRow[]>([])
  const [modelsDir, setModelsDir] = useState('')
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) {
      setPhase('error')
      setMessage('未检测到 window.api — 模型列表仅在 Electron 主窗口内可用')
      return
    }
    try {
      const reply = (await api.invoke('models:list')) as ModelsListReply
      setModels(Array.isArray(reply.models) ? reply.models : [])
      setPhase('ready')
    } catch (e) {
      setPhase('error')
      setMessage(`models:list 失败 — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (api) {
        try {
          const cfg = (await api.invoke('config:get')) as ConfigGetReply
          if (cfg && cfg.ok !== false && cfg.config) setModelsDir(cfg.config.modelsDir ?? '')
        } catch {
          /* 目录初值缺省显示 — 主列表仍由 refresh 呈现 */
        }
      }
      await refresh()
    })()
  }, [refresh])

  const submitDir = useCallback(
    async (path: string): Promise<SetDirReply | null> => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (!api) return null
      const reply = (await api.invoke('models:setDir', { path })) as SetDirReply
      if (reply.ok) {
        setModelsDir(reply.modelsDir)
        setModels(reply.models)
      }
      return reply
    },
    [],
  )

  return (
    <section className="las-page" aria-labelledby="page-title-models">
      <h1 id="page-title-models" className="las-page-title">
        Models
      </h1>
      <p className="las-page-subtitle">本地模型注册表 — 识别、校验与目录管理（下载在 Market 页）</p>
      <DirControl modelsDir={modelsDir} onSubmit={submitDir} />
      <div className="las-models-toolbar">
        <button type="button" className="las-models-refresh" onClick={() => void refresh()}>
          刷新
        </button>
        <span className="las-models-count">{phase === 'ready' ? `${models.length} 个模型` : '…'}</span>
      </div>
      {phase === 'loading' ? <p className="las-models-empty">读取模型注册表…</p> : null}
      {phase === 'error' ? (
        <p className="las-models-dir-error" role="alert">
          {message ?? '模型列表不可用'}
        </p>
      ) : null}
      {phase === 'ready' ? <ModelsTable models={models} /> : null}
    </section>
  )
}

export default ModelsPage
