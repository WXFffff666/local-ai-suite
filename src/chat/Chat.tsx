/**
 * Chat.tsx — 对话工作区（todo11 IPC 流式 + todo15 渲染打磨 + todo21 VLM 贴图）
 * 数据流全部走 store（window.api chat:send / chat:abort + delta/done/error 事件），
 * 渲染层不直连侧车端口。无 window.api 时降级为诚实只读态。
 * todo15：消息 markdown/代码块/自动滚动/预设 chips 由 components/chatui/** 承担，
 * store 数据形状零改动（types.ts 冻结契约）。
 * todo21：composer 支持 文件选择/粘贴 贴图（≤2 张，base64 dataURL 进
 * messages content image_url）；注册表无带 projectorPath 的 gguf 模型时
 * 贴图入口禁用并提示（plan QA-fail 场景）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Paperclip, X, BookOpen } from 'lucide-react'
import { useChatStore, getChatIpcApi, IPC_UNAVAILABLE_MESSAGE } from './store'
// todo42 (ADDITIVE): 单文件 HTML 导出（渲染层 sanitize 管线组装 + chat:exportHtml 落盘）。
import ExportHtmlButton from '../renderer/src/components/export/ExportHtmlButton'
import {
  MAX_IMAGES_PER_MESSAGE,
  VISION_DISABLED_TOOLTIP,
  probeVisionCapability,
  readFileAsDataUrl,
  selectAttachableImages,
} from './vision'
import { CHAT_PRESETS, fillChatPreset, type ChatPreset } from '../presets/presets'
import { MessageList } from '../renderer/src/components/chatui/MessageList'
import { PresetPicker } from '../renderer/src/components/chatui/PresetPicker'
import '../renderer/src/components/chatui/chatui.css'
// todo29 (ADDITIVE): agent mode surface. Default mode stays 'chat' — with no
// window.api / no toggle interaction every branch below is byte-identical to
// the pre-29 render (pinned by Chat.characterization.test.tsx).
import AgentModeToggle from '../renderer/src/components/agentui/AgentModeToggle'
import AgentTimeline from '../renderer/src/components/agentui/AgentTimeline'
import { useAgentStore, DRAFT_KEY } from '../renderer/src/components/agentui/agentStore'
import { isBusy } from '../renderer/src/components/agentui/timeline'
// todo29-style ADDITIVE (todo36): push-to-talk. MicButton self-hides without
// window.api / without speech:getStatus ok — default DOM unchanged otherwise.
import { MicButton } from './MicButton'
// todo37-style ADDITIVE: per-image "提取文字" (PaddleOCR-json sidecar). The
// bridge self-hides (no buttons render) until ocr:status says installed.
import type { MessageOcrApi } from '../renderer/src/components/chatui/MessageBubble'
import type { OcrRecognizeReply, OcrStatusReply, RagQueryReply, RagStatusReply } from '../main/ipc/whitelist'
import { formatRagContext } from '../renderer/src/components/rag/api'

export type ChatProps = {
  /** 对话预设（点击填充输入框）；传空数组隐藏预设行 */
  presets?: readonly ChatPreset[]
}

export function Chat({ presets = CHAT_PRESETS }: ChatProps): React.JSX.Element {
  const sessions = useChatStore((s) => s.sessions)
  const currentId = useChatStore((s) => s.currentId)
  const streaming = useChatStore((s) => s.streaming)
  const error = useChatStore((s) => s.error)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const switchSession = useChatStore((s) => s.switchSession)
  const send = useChatStore((s) => s.send)
  const abort = useChatStore((s) => s.abort)
  const retry = useChatStore((s) => s.retry)
  const clearCurrentMessages = useChatStore((s) => s.clearCurrentMessages)

  const [input, setInput] = useState('')
  /** todo21: 待发送贴图（base64 dataURL，≤2 张） */
  const [images, setImages] = useState<string[]>([])
  const [vision, setVision] = useState(false)
  /** todo37: ocr:status 探测（mount 一次，spawn-free）；installed = 引擎可识别 */
  const [ocrInstalled, setOcrInstalled] = useState(false)
  /** todo39 (ADDITIVE): 本地知识库问答开关（默认关，chat 发送路径逐字节不变）。 */
  const [ragOn, setRagOn] = useState(false)
  const [ragMode, setRagMode] = useState<'ollama' | 'internal' | 'hash' | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // todo36: 转写文本插入到光标处需要 textarea 句柄
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cur = sessions.find((s) => s.id === currentId) ?? null
  const canStream = getChatIpcApi() !== null
  const streamingHere = Boolean(cur?.messages.some((m) => m.pending))

  // todo29: agent mode (additive). sessionKey falls back to a draft bucket
  // so the mode/timeline survive before any chat session exists.
  const agentKey = currentId ?? DRAFT_KEY
  const agentMode = useAgentStore((s) => s.modes[agentKey] ?? 'chat')
  const agentBusy = useAgentStore((s) => isBusy(s.runs[agentKey]?.phase ?? 'idle'))
  const startAgentRun = useAgentStore((s) => s.startRun)
  const inAgent = agentMode === 'agent'

  // 阶段1：画图工具开关 — 开启时说"画一张…"直接本地出图（默认开）
  const [imageTool, setImageTool] = useState(true)

  useEffect(() => {
    let cancelled = false
    void probeVisionCapability().then((v) => {
      if (!cancelled) setVision(v)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // todo37: OCR 可用性探测（ocr:status 不 spawn 引擎，也不触发下载）。
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    // App.test 的假 api 只有 on —— invoke 缺席时保持诚实不可用。
    if (!api || typeof api.invoke !== 'function') return
    let cancelled = false
    void api
      .invoke('ocr:status', {})
      .then((reply) => {
        const r = reply as OcrStatusReply
        if (!cancelled && r?.ok === true) setOcrInstalled(r.supported && r.engine.source !== 'none')
      })
      .catch(() => {
        /* honest unavailable */
      })
    return () => {
      cancelled = true
    }
  }, [])

  // todo39: RAG 状态探测（rag:status 不入库、不 spawn；仅决定开关可见性 +
  // hash 降级提示）。无 window.api / 探测失败时开关隐藏，发送路径不变。
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    if (!api || typeof api.invoke !== 'function') return
    let cancelled = false
    void api
      .invoke('rag:status', {})
      .then((reply) => {
        const r = reply as RagStatusReply
        if (cancelled || r?.ok !== true) return
        if (r.mode === 'ollama' || r.mode === 'internal' || r.mode === 'hash') setRagMode(r.mode)
      })
      .catch(() => {
        /* honest unavailable */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const ocrApi: MessageOcrApi | undefined = canStream
    ? {
        available: ocrInstalled,
        recognize: async (dataUrl: string): Promise<string> => {
          const reply = (await window.api.invoke('ocr:recognize', { dataURL: dataUrl })) as OcrRecognizeReply
          if (!reply || reply.ok !== true) {
            const detail = reply && reply.ok === false ? reply.detail : undefined
            const code = reply && reply.ok === false ? reply.error : 'no-reply'
            throw new Error(detail ?? code)
          }
          return reply.text
        },
      }
    : undefined

  const addImageFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (!vision) return
      const picked = selectAttachableImages(files, images.length)
      const urls: string[] = []
      for (const i of picked) {
        const f = files[i]
        if (f) urls.push(await readFileAsDataUrl(f))
      }
      if (urls.length > 0) setImages((prev) => [...prev, ...urls].slice(0, MAX_IMAGES_PER_MESSAGE))
    },
    [vision, images.length],
  )

  const handleSend = async (): Promise<void> => {
    const t = input.trim()
    // todo29: agent mode — the composer submits the goal to agent:start
    // (贴图/presets belong to the chat path; agent takes plain text goals).
    if (inAgent) {
      if (!t || agentBusy) return
      setInput('')
      await startAgentRun(agentKey, t)
      return
    }
    if ((!t && images.length === 0) || streamingHere) return
    const attached = images
    setInput('')
    setImages([])
    // todo39 (ADDITIVE): 知识库问答 — 开关在位时先混合检索，命中片段作为
    // wire-only 上下文注入本轮提问，[n] 引用角标挂到本条 user 消息。
    // 检索失败/无命中 → 原样发送（诚实降级，不阻塞对话）。
    if (ragOn && t) {
      try {
        const reply = (await window.api.invoke('rag:query', { q: t, topK: 5 })) as RagQueryReply
        if (reply?.ok === true && reply.citations.length > 0) {
          await send(t, { imageTool }, attached, { context: formatRagContext(reply.citations), citations: reply.citations })
          return
        }
      } catch {
        /* retrieval unavailable — plain turn below */
      }
    }
    await send(t, { imageTool }, attached)
  }

  const applyPreset = (preset: ChatPreset): void => {    const fill = fillChatPreset(preset)
    if (fill) setInput(fill.prompt)
  }

  /** todo36: whisper 转写结果插入光标处（textarea 不可用时退化为追加）。 */
  const insertAtCaret = useCallback((text: string): void => {
    const ta = textareaRef.current
    if (!ta) {
      setInput((prev) => (prev ? `${prev} ${text}` : text))
      return
    }
    const start = ta.selectionStart ?? ta.value.length
    const end = ta.selectionEnd ?? ta.value.length
    setInput(`${ta.value.slice(0, start)}${text}${ta.value.slice(end)}`)
    const caret = start + text.length
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = caret
    })
  }, [])

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: 'system-ui,sans-serif' }}>
      <aside style={{ width: 220, borderRight: '1px solid #222', padding: 12, background: '#0f0f0f', color: '#ddd', overflowY: 'auto' }}>
        <button
          onClick={() => createSession()}
          style={{ width: '100%', padding: '8px 10px', marginBottom: 12, cursor: 'pointer' }}
        >
          + New Chat
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => switchSession(s.id)}
              style={{
                padding: '8px 10px',
                borderRadius: 6,
                cursor: 'pointer',
                background: s.id === currentId ? '#1e1e1e' : 'transparent',
                border: '1px solid #2a2a2a',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{s.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                style={{ marginLeft: 6, background: 'transparent', color: '#888', border: 'none', cursor: 'pointer' }}
                aria-label="delete"
              >
                ×
              </button>
            </div>
          ))}
          {sessions.length === 0 && <span style={{ color: '#666', fontSize: 12 }}>No sessions</span>}
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#111', color: '#e6e6e6' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #222', display: 'flex', gap: 8, alignItems: 'center' }}>
          <strong style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cur ? cur.title : 'Select or create a chat'}
          </strong>
          <AgentModeToggle sessionKey={agentKey} />
          {!inAgent && (
            <button
              onClick={() => setImageTool((v) => !v)}
              title="开启后，对话里说「画一张…」会直接本地生图"
              style={{
                cursor: 'pointer',
                opacity: imageTool ? 1 : 0.5,
                border: imageTool ? '1px solid #7c6cf6' : '1px solid #444',
                borderRadius: 6,
                padding: '2px 8px',
              }}
              data-testid="chat-image-tool-toggle"
            >
              🎨 画图 {imageTool ? '开' : '关'}
            </button>
          )}
          {!inAgent && cur && cur.messages.length > 0 && <ExportHtmlButton session={cur} />}
          {!inAgent && cur && <button onClick={clearCurrentMessages} style={{ cursor: 'pointer' }}>Clear</button>}
          {!inAgent && streamingHere && <button onClick={abort} style={{ cursor: 'pointer', color: '#f55' }}>Abort</button>}
          {!inAgent && !streaming && error && error !== 'aborted' && (
            <button onClick={() => void retry()} style={{ cursor: 'pointer' }}>Retry</button>
          )}
        </div>

        {!canStream && (
          <div role="status" style={{ padding: '8px 16px', background: '#2a1d1d', color: '#f0b4b4', fontSize: 12, borderBottom: '1px solid #4a2a2a' }}>
            {IPC_UNAVAILABLE_MESSAGE}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {inAgent ? (
            <AgentTimeline sessionKey={agentKey} />
          ) : (
            <>
              {cur && cur.messages.length > 0 ? (
                <MessageList
                  key={cur.id}
                  messages={cur.messages}
                  {...(ocrApi ? { ocr: ocrApi } : {})}
                  onOcrInsert={insertAtCaret}
                />
              ) : (
                <div style={{ padding: 16, color: '#666' }}>
                  {!cur && 'Create a new chat to start. 流式经主进程 chat:delta 事件转发。'}
                  {cur && cur.messages.length === 0 && 'No messages — say hello.'}
                </div>
              )}
              {error && error !== 'aborted' && canStream && (
                <div style={{ color: '#f88', fontSize: 12, padding: '0 16px 8px' }}>Error: {error}</div>
              )}
            </>
          )}
        </div>

        {!inAgent && presets.length > 0 && <PresetPicker presets={presets} onPick={applyPreset} />}

        <div style={{ padding: 12, borderTop: '1px solid #222' }}>
          {images.length > 0 && (
            <div className="las-attach-strip" data-testid="attach-strip">
              {images.map((url, i) => (
                <span key={`${i}:${url.slice(-12)}`} className="las-attach-thumb">
                  <img src={url} alt={`附图 ${i + 1}`} />
                  <button
                    type="button"
                    aria-label={`remove-image-${i + 1}`}
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              data-testid="image-file-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                void addImageFiles(files)
              }}
            />
            <button
              type="button"
              aria-label="attach-image"
              data-testid="attach-image-button"
              title={vision ? '添加图片（≤2 张）' : VISION_DISABLED_TOOLTIP}
              disabled={!canStream || !vision || images.length >= MAX_IMAGES_PER_MESSAGE || inAgent}
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: '0 10px', cursor: canStream && vision && !inAgent ? 'pointer' : 'not-allowed' }}
            >
              <Paperclip size={16} aria-hidden />
            </button>
            {/* todo36: push-to-talk（按住说话→松开转写→插入光标处） */}
            <MicButton onTranscript={insertAtCaret} />
            {/* todo39: 本地知识库问答开关（rag:* 通道；hash 模式带降级提示） */}
            {canStream && ragMode !== null && (
              <button
                type="button"
                data-testid="rag-mode-toggle"
                aria-pressed={ragOn}
                title={ragMode === 'hash' ? '检索质量降级（无本地嵌入引擎）— 当前为哈希占位向量' : ragMode === 'ollama' ? '嵌入引擎：Ollama' : '嵌入引擎：内部 llama-server --embeddings'}
                disabled={inAgent}
                onClick={() => setRagOn((v) => !v)}
                style={{ padding: '0 10px', cursor: inAgent ? 'not-allowed' : 'pointer', borderColor: ragOn ? '#7a5af5' : undefined }}
              >
                <BookOpen size={16} aria-hidden style={{ verticalAlign: 'middle', color: ragOn ? '#7a5af5' : undefined }} />
                <span style={{ marginLeft: 4 }}>知识库</span>
              </button>
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                const items = Array.from(e.clipboardData?.items ?? [])
                const files = items
                  .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                  .map((it) => it.getAsFile())
                  .filter((f): f is File => f !== null)
                if (files.length > 0) {
                  e.preventDefault()
                  void addImageFiles(files)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() }
              }}
              placeholder={
                !canStream
                  ? '桌面端运行时可发送消息'
                  : inAgent
                    ? '描述一个编码任务…（Enter 启动代理，工具执行前会逐一请求授权）'
                    : 'Type a message… (Enter to send, Shift+Enter newline; 支持粘贴图片)'
              }
              rows={2}
              style={{ flex: 1, resize: 'none', padding: 10, borderRadius: 8, border: '1px solid #333', background: '#0f0f0f', color: '#eee' }}
              disabled={!canStream}
            />
            <button
              onClick={() => void handleSend()}
              disabled={
                inAgent
                  ? !canStream || agentBusy || !input.trim()
                  : !canStream || streamingHere || (!input.trim() && images.length === 0)
              }
              style={{ padding: '0 18px', cursor: (inAgent ? agentBusy : streamingHere) ? 'not-allowed' : 'pointer' }}
            >
              {inAgent ? (agentBusy ? '…' : '运行') : streamingHere ? '…' : 'Send'}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}

export default Chat
