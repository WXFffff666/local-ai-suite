/**
 * LoraSection.tsx — todo19 模型页 LoRA 子区：models:loraScan 列出
 * diffusion/lora 权重文件（registry 扫描复用），点开详情懒拉
 * models:loraMeta 展示 safetensors 头元数据（ss_tag/网络维度/基模型）。
 * 只读浏览；选择+滑杆在生图面板 LoraPicker。scan 失败（含非 Electron）
 * 诚实降级为一条 note，不影响主模型表。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  invokeLoraMeta,
  invokeLoraScan,
  type LoraFile,
  type LoraMetaReply,
} from '../lora/loraShared'
import type { AllowedChannel } from '../../../../main/ipc/whitelist'
import '../lora/lora.css'

type LoraApi = {
  invoke: (channel: AllowedChannel, ...args: unknown[]) => Promise<unknown>
}

function getApi(): LoraApi | undefined {
  return typeof window === 'undefined' ? undefined : (window.api as LoraApi | undefined)
}

export function LoraSection(): React.JSX.Element | null {
  const [files, setFiles] = useState<LoraFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [meta, setMeta] = useState<Record<string, LoraMetaReply>>({})

  const rescan = useCallback(async (): Promise<void> => {
    const api = getApi()
    if (!api) {
      setError('window.api 缺失 — LoRA 列表仅在 Electron 主窗口内可用')
      setFiles(null)
      return
    }
    try {
      setFiles(await invokeLoraScan((ch, p) => api.invoke(ch, p)))
      setError(null)
    } catch (e) {
      setError(`models:loraScan 失败 — ${e instanceof Error ? e.message : String(e)}`)
      setFiles(null)
    }
  }, [])

  const toggleDetail = useCallback(
    (file: LoraFile): void => {
      const api = getApi()
      if (!api) return
      if (openPath === file.path) {
        setOpenPath(null)
        return
      }
      setOpenPath(file.path)
      if (meta[file.path] !== undefined) return
      void (async () => {
        const reply = await invokeLoraMeta((ch, p) => api.invoke(ch, p), file.path).catch(
          (): LoraMetaReply => ({ ok: false, error: 'bad-header' }),
        )
        setMeta((m) => ({ ...m, [file.path]: reply }))
      })()
    },
    [openPath, meta],
  )

  // 首帧扫描一次；「重新扫描」按钮手动刷新
  useEffect(() => {
    void rescan()
  }, [rescan])

  return (
    <section className="las-lora-section" aria-label="LoRA 权重文件">
      <div className="las-lora-section-head">
        <h2>LoRA</h2>
        <button type="button" className="las-models-refresh" onClick={() => void rescan()}>
          重新扫描
        </button>
        <span className="las-models-count">{files !== null ? `${files.length} 个文件` : '…'}</span>
      </div>
      {error !== null ? <p className="las-lora-note">{error}</p> : null}
      {files !== null && files.length === 0 ? (
        <p className="las-lora-note">diffusion/lora 目录下暂无 .safetensors/.gguf 权重。</p>
      ) : null}
      {files !== null && files.length > 0 ? (
        <ul className="las-lora-section-list">
          {files.map((file) => {
            const reply = meta[file.path]
            return (
              <li key={file.path} data-testid={`lora-row-${file.name}`}>
                <button type="button" className="las-lora-row-btn" onClick={() => toggleDetail(file)}>
                  <span className="las-lora-name">{file.name}</span>
                  <span className="las-lora-size">{file.sizeLabel}</span>
                  <span className="las-lora-format">{file.format}</span>
                  <span className="las-lora-file">{file.file}</span>
                </button>
                {openPath === file.path ? (
                  <div className="las-lora-detail" data-testid={`lora-detail-${file.name}`}>
                    {reply === undefined ? (
                      <span className="las-lora-note">读取元数据…</span>
                    ) : reply.ok && Object.keys(reply.meta).length > 0 ? (
                      <dl className="las-lora-meta-dl">
                        {Object.entries(reply.meta).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{String(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <span className="las-lora-note">元数据未知（{reply.ok ? '头内无 LoRA 键' : reply.error}），生图仍可用。</span>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

export default LoraSection
