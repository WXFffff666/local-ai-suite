/**
 * ModelsPage.tsx — todo13 模型管理页 + 阶段3 图形化体验
 *
 * 数据流：
 *   mount → invoke('config:get') → {config.modelsDir} → 目录控件初值
 *   mount → invoke('models:list') → ModelRow[] → ModelsTable（损坏徽标透出 registry.corrupted）
 *   目录切换 → invoke('models:setDir',{path}) → {ok,models,restartRequired} → 表刷新 + 重启提示
 *   手动刷新 → invoke('models:list')
 *   阶段3 → invoke('models:openDir',{sub}) → 资源管理器直达；拖入文件 chokidar 自动注册
 *
 * 非 Electron 环境（window.api 缺失）诚实降级。
 */
import { useCallback, useEffect, useState } from 'react'
import '../components/modelspage/modelspage.css'
import { ModelsTable } from '../components/modelspage/ModelsTable'
import { DirControl } from '../components/modelspage/DirControl'
import { LoraSection } from '../components/modelspage/LoraSection'
import type { ConfigGetReply, ModelsListReply, ModelRow, SetDirReply } from '../components/modelspage/types'

/** 模型分类卡片（阶段3）：点击直达对应文件夹，拖入即用 */
const MODEL_FOLDERS: ReadonlyArray<{ sub?: string; label: string; desc: string }> = [
  { sub: 'llm', label: '💬 对话模型', desc: 'GGUF 对话/润色模型 → models/llm/' },
  { sub: 'diffusion', label: '🎨 画图模型', desc: 'Z-Image / SD / Flux 权重 → models/diffusion/' },
  { sub: 'lora', label: '🧩 LoRA', desc: '画风/角色 LoRA → models/lora/' },
  { sub: 'embedding', label: '📎 嵌入模型', desc: '知识库 embedding → models/embedding/' },
]

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

  const openFolder = useCallback(async (sub?: string): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    const reply = (await api.invoke('models:openDir', sub === undefined ? {} : { sub })) as {
      ok?: boolean
      error?: string
    }
    if (reply?.ok === false) setMessage(`打开文件夹失败：${reply.error ?? 'unknown'}`)
  }, [])

  return (
    <section className="las-page" aria-labelledby="page-title-models">
      <h1 id="page-title-models" className="las-page-title">
        Models
      </h1>
      <p className="las-page-subtitle">本地模型 — 拖进文件夹就能用，自动识别注册（下载也可去 Market 页）</p>
      <div className="las-models-folders" data-testid="models-folders">
        {MODEL_FOLDERS.map((f) => (
          <button key={f.sub ?? 'root'} type="button" className="las-models-folder-card" onClick={() => void openFolder(f.sub)}>
            <strong>{f.label}</strong>
            <span>{f.desc}</span>
            <span className="las-models-folder-open">打开文件夹 →</span>
          </button>
        ))}
      </div>
      <p className="las-page-subtitle">
        把模型文件拖进对应文件夹即可，应用会自动识别（下载中未完成的文件会被隔离，完成后自动可用）。
      </p>
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
      {/* todo19 — 扩散 LoRA 子区（models:loraScan 复用 registry 投影，只读浏览 + 元数据） */}
      <LoraSection />
    </section>
  )
}

export default ModelsPage
