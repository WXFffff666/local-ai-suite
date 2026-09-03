/**
 * MicButton.tsx — todo36 push-to-talk composer button.
 *
 * Hold to talk, release to transcribe (plan row 36: 按住说话). VAD gating is
 * deliberately NOT wired: @ricky0123/vad-web@0.0.30 fetches its Silero model
 * from a CDN at runtime (breaks the zero-external-requests invariant —
 * PRIVACY.md and e2e test e2) and push-to-talk needs no silence detection;
 * streaming ASR is sherpa-onnx backlog territory (plan Must-NOT).
 *
 * Browser APIs cross the RecorderSurface seam (audio.ts type, recorder.ts
 * real wiring); jsdom tests fake it and drive the full state machine.
 *
 * Render contract: null when window.api is absent, the probe fails, or
 * Settings → speech is disabled — keeps Chat.characterization's baseline DOM
 * (that fake api answers {ok:true} with no enabled/modelReady fields).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import type { RecorderSurface } from './audio'
import { defaultRecorderSurface } from './recorder'
import type { SpeechStatusReply } from '../main/ipc/whitelist'
import './micbutton.css'

export type { RecorderSurface }
export type MicPhase = 'idle' | 'recording' | 'transcribing' | 'error'

export type MicButtonProps = {
  onTranscript: (text: string) => void
  /** Override the browser seam (tests). Default wires navigator globals. */
  recorder?: RecorderSurface
}

type StatusOk = Extract<SpeechStatusReply, { ok: true }>

function statusOk(reply: unknown): reply is StatusOk {
  return typeof reply === 'object' && reply !== null && (reply as SpeechStatusReply).ok === true
}

function fmtTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function MicButton({ onTranscript, recorder }: MicButtonProps): React.JSX.Element | null {
  const [phase, setPhase] = useState<MicPhase>('idle')
  const [status, setStatus] = useState<StatusOk | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [decoderReady, setDecoderReady] = useState(true)
  const recorderRef = useRef<RecorderSurface | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopHandleRef = useRef<(() => void) | null>(null)
  const phaseRef = useRef<MicPhase>('idle')
  phaseRef.current = phase

  // capability probe — spawn-free channel (speech:getStatus never starts the
  // sidecar; safe on every chat mount).
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.api
    // structural guard (vision.ts precedent): partial test fakes may lack invoke
    if (!api || typeof api.invoke !== 'function') return
    let cancelled = false
    api
      .invoke('speech:getStatus', {})
      .then((reply: unknown) => {
        if (!cancelled && statusOk(reply)) setStatus(reply)
      })
      .catch(() => {
        /* honest hidden state */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (recorder) {
      recorderRef.current = recorder
      setDecoderReady(true)
      return
    }
    try {
      recorderRef.current = defaultRecorderSurface()
      setDecoderReady(recorderRef.current !== null)
    } catch {
      recorderRef.current = null
      setDecoderReady(false)
    }
  }, [recorder])

  const stopTimer = useCallback((): void => {
    if (timerRef.current !== null) clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  useEffect(() => stopTimer, [stopTimer])

  const releaseStream = useCallback((): void => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
  }, [])

  const showError = useCallback((message: string): void => {
    setError(message)
    setPhase('error')
    window.setTimeout(() => {
      setPhase('idle')
      setError(null)
    }, 4000)
  }, [])

  /** recorder.onstop lands here: encode → saveWav → transcribe → callback. */
  const finishRecording = useCallback(
    async (chunks: Blob[]): Promise<void> => {
      if (cancelledRef.current) return
      setPhase('transcribing')
      try {
        const rec = recorderRef.current
        const api = window.api
        if (!rec || !api) throw new Error('录音环境不可用')
        const dataURL = await rec.toWavDataURL(new Blob(chunks, { type: 'audio/webm' }))
        const saved = (await api.invoke('speech:saveWav', { dataURL })) as { ok: boolean; path?: string; error?: string }
        if (!saved.ok || !saved.path) throw new Error(saved.error ?? 'saveWav failed')
        const reply = (await api.invoke('speech:transcribe', { wavPath: saved.path })) as {
          ok: boolean
          text?: string
          error?: string
          detail?: string
        }
        if (!reply.ok) {
          const reason =
            reply.error === 'model-not-configured'
              ? '尚未在 设置 → 语音 配置 Whisper 模型'
              : reply.error === 'engine-missing'
                ? '未找到 whisper-server 引擎（随安装包提供，请检查安装）'
                : (reply.detail ?? reply.error ?? '转写失败')
          throw new Error(reason)
        }
        setPhase('idle')
        const text = (reply.text ?? '').trim()
        if (text) onTranscript(text)
      } catch (e) {
        showError(e instanceof Error ? e.message : String(e))
      }
    },
    [onTranscript, showError],
  )

  const begin = useCallback(async (): Promise<void> => {
    const rec = recorderRef.current
    if (!rec || phaseRef.current !== 'idle') return
    let stream: MediaStream
    try {
      stream = await rec.getUserMedia({ audio: true })
    } catch {
      showError('麦克风权限被拒绝 — 在系统/浏览器设置中允许音频输入')
      return
    }
    streamRef.current = stream
    cancelledRef.current = false
    setSeconds(0)
    setPhase('recording')
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
    const chunks: Blob[] = []
    const handle = rec.createRecorder(stream)
    stopHandleRef.current = () => handle.stop()
    handle.onData((chunk) => chunks.push(chunk))
    handle.onStop(() => {
      stopHandleRef.current = null
      stopTimer()
      releaseStream()
      void finishRecording(chunks)
    })
    handle.start()
  }, [finishRecording, releaseStream, showError, stopTimer])

  const end = useCallback((): void => {
    if (phaseRef.current !== 'recording') return
    stopHandleRef.current?.()
  }, [])

  const cancel = useCallback((): void => {
    if (phaseRef.current !== 'recording') return
    cancelledRef.current = true
    stopHandleRef.current?.()
    stopHandleRef.current = null
    stopTimer()
    releaseStream()
    setPhase('idle')
  }, [releaseStream, stopTimer])

  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, cancel])

  if (status === null || !status.enabled || typeof window === 'undefined' || !window.api) return null
  if (!decoderReady) return null

  const label =
    phase === 'recording'
      ? `录音中 ${fmtTime(seconds)} — 松开转写，Esc 取消`
      : phase === 'transcribing'
        ? '转写中…'
        : status.modelReady
          ? '按住说话'
          : '未配置 Whisper 模型（设置 → 语音）'

  return (
    <span className="las-mic-wrap" data-testid="mic-button-wrap">
      <button
        type="button"
        className={`las-mic las-mic-${phase}`}
        data-testid="mic-button"
        aria-label={label}
        title={label}
        disabled={!status.modelReady || phase === 'transcribing'}
        onPointerDown={() => {
          void begin()
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={end}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Mic size={16} aria-hidden />
      </button>
      {phase === 'recording' && (
        <span className="las-mic-timer" data-testid="mic-timer">
          {fmtTime(seconds)}
        </span>
      )}
      {phase === 'transcribing' && (
        <span className="las-mic-transcribing" role="status" data-testid="mic-transcribing">
          转写中…
        </span>
      )}
      {phase === 'error' && error !== null && (
        <span className="las-mic-error" role="alert" data-testid="mic-error">
          {error}
        </span>
      )}
    </span>
  )
}

export default MicButton
