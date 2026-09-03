/**
 * SpeechSection.tsx — todo36 设置页「语音输入」区（EngineStatus 数据流先例）：
 *   mount → invoke('speech:getStatus') → 开关 / 模型路径 / 引擎来源行
 *   开关 → speech:setPrefs {enabled}；「选择模型…」→ speech:pickModel
 *   （主进程 dialog + modelsDir|userData/whisper-models 围栏）→ speech:setPrefs
 *   {modelPath}。getStatus 不 spawn 侧车（chat 挂载同样探测它）。
 * VAD 说明：@ricky0123/vad-web 的 Silero 模型默认走 CDN 拉取，与零外联不变量
 * 冲突，按住说话本就不需要静音门控 —— 该区只提供 PTT 开关（learnings 记录）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { SpeechPickModelReply, SpeechStatusReply } from '../../../../main/ipc/whitelist'

const ENGINE_SOURCE_LABELS: Record<string, string> = {
  env: '环境变量 WHISPER_BIN',
  bundled: '内置引擎（sha256 钉校验）',
  none: '缺失 — 随安装包 extraResources 提供',
}

type StatusOk = Extract<SpeechStatusReply, { ok: true }>

export function SpeechSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<StatusOk | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const fetchStatus = useCallback(async (): Promise<void> => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api) return
    try {
      const reply = (await api.invoke('speech:getStatus', {})) as SpeechStatusReply
      if (reply?.ok === true) {
        setStatus(reply)
        setNote(null)
      } else if (reply) {
        setNote(`语音状态读取失败 — ${'error' in reply ? reply.error : '应答格式异常'}`)
      }
    } catch {
      setNote('speech:getStatus 失败 — 语音输入暂不可用')
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const toggle = useCallback(
    async (enabled: boolean): Promise<void> => {
      const api = window.api
      if (!api) return
      const reply = (await api.invoke('speech:setPrefs', { enabled })) as SpeechStatusReply
      if (reply?.ok === true) setStatus(reply)
    },
    [],
  )

  const pickModel = useCallback(async (): Promise<void> => {
    const api = window.api
    if (!api) return
    const picked = (await api.invoke('speech:pickModel', {})) as SpeechPickModelReply
    if (!picked.ok) {
      setNote(`选择模型失败 — ${picked.error}`)
      return
    }
    if (picked.path === null) return
    const reply = (await api.invoke('speech:setPrefs', { modelPath: picked.path })) as SpeechStatusReply
    if (reply?.ok === true) {
      setStatus(reply)
      setNote(null)
    } else if (reply) {
      setNote(`模型路径被拒绝 — ${'error' in reply ? reply.error : '未知'}`)
    }
  }, [])

  if (status === null) {
    // window.api 缺席（纯浏览器预览）或首次读取失败：整区隐藏，不干扰其余设置断言。
    if (note === null || typeof window === 'undefined' || !window.api) return null
  }

  const s = status
  return (
    <section className="las-settings-group" aria-label="语音输入">
      <h2 className="las-settings-group-title">语音输入（按住说话 · whisper.cpp）</h2>
      {note !== null ? <p className="las-settings-note">{note}</p> : null}
      {s ? (
        <>
          <div className="las-settings-row">
            <span className="las-settings-label">启用麦克风输入</span>
            <div className="las-settings-pills" role="radiogroup" aria-label="语音输入开关">
              {([true, false] as const).map((v) => (
                <button
                  key={String(v)}
                  type="button"
                  role="radio"
                  aria-checked={s.enabled === v}
                  data-testid={`speech-enabled-${v}`}
                  className={`las-settings-pill${s.enabled === v ? ' las-settings-pill-on' : ''}`}
                  onClick={() => void toggle(v)}
                >
                  {v ? '开' : '关'}
                </button>
              ))}
            </div>
          </div>
          <div className="las-settings-row">
            <span className="las-settings-label">Whisper 模型</span>
            <code className="las-settings-value" data-testid="speech-model-path">
              {s.modelPath || '未配置'}
            </code>
            <button type="button" data-testid="speech-pick-model" onClick={() => void pickModel()}>
              选择模型…
            </button>
          </div>
          <div className="las-settings-row">
            <span className="las-settings-label">引擎来源</span>
            <code className="las-settings-value" data-testid="speech-engine-source" title={s.engine.bin ?? ''}>
              {ENGINE_SOURCE_LABELS[s.engine.source] ?? s.engine.source}
            </code>
            <span className="las-settings-note" data-testid="speech-ready">
              {s.modelReady ? '就绪' : s.engine.bin === null ? '缺引擎' : '缺模型'}
              {s.running ? ' · 侧车运行中' : ''}
            </span>
          </div>
          <p className="las-settings-note">
            模型文件（ggml .bin / .gguf）自行下载，仅接受位于模型目录或 whisper-models 目录内的路径；
            转写全程 127.0.0.1 本地闭环，零外联。
          </p>
        </>
      ) : null}
    </section>
  )
}

export default SpeechSection
