/**
 * ipc.ts — speech:* handler factories (todo36). Registration stays in
 * src/main/ipc/handlers.ts (the single IPC surface, imageOps/enginesIpc
 * precedent); this module owns validation + whisper-service/file side effects.
 *
 * Channel contract:
 *   speech:getStatus    {}                        -> SpeechStatusReply
 *   speech:setPrefs     {enabled?, modelPath?}    -> SpeechStatusReply
 *   speech:pickModel    {}                        -> SpeechPickModelReply (main-side dialog)
 *   speech:saveWav      {dataURL}                 -> SpeechSaveWavReply   (saveTempImage pattern, 32 MiB cap)
 *   speech:transcribe   {wavPath, language?}      -> SpeechTranscribeReply
 *
 * getStatus is spawn-free by contract (chat mount + e2e probe it); only
 * transcribe() touches the whisper sidecar.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve as resolvePath } from 'path'

import {
  speechPickModelSchema,
  speechSaveWavSchema,
  speechSetPrefsSchema,
  speechTranscribeSchema,
  speechGetStatusSchema,
  validatePayload,
  type SpeechSetPrefsInput,
} from '../main/ipc/schemas'
import type {
  SpeechPickModelReply,
  SpeechSaveWavReply,
  SpeechStatusReply,
  SpeechTranscribeReply,
} from '../main/ipc/whitelist'
import { getWhisperService } from './service'
import { checkWhisperModelPath, isInsideDir, modelPathIsAllowed, WHISPER_MODEL_EXTENSIONS } from './modelPaths'

export type SpeechHandler = (args: unknown[]) => Promise<unknown>

/** Decoded WAV cap on speech:saveWav (32 MiB ≈ 35 min of 16k mono PCM16). */
export const SPEECH_WAV_MAX_BYTES = 32 * 1024 * 1024

export type SpeechPrefs = {
  speechEnabled: boolean
  whisperModelPath: string
}

export type OpenDialogLike = {
  showOpenDialog?(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>
}

export type SpeechServiceSurface = ReturnType<typeof getWhisperService>

export type SpeechIpcDeps = {
  userDataDir: string
  /** models root — whisper models may live under it (or userData/whisper-models). */
  modelsDir: string
  prefs: { get: () => SpeechPrefs; set: (partial: Partial<SpeechPrefs>) => SpeechPrefs }
  dialog: OpenDialogLike
  /** whisper sidecar owner; default = the process singleton (lazy, spawn-free). */
  service?: () => SpeechServiceSurface
}

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

export function createSpeechHandlers(deps: SpeechIpcDeps): Record<
  'speech:getStatus' | 'speech:setPrefs' | 'speech:pickModel' | 'speech:saveWav' | 'speech:transcribe',
  SpeechHandler
> {
  const service = () => deps.service?.() ?? getWhisperService()

  const buildStatus = (): SpeechStatusReply => {
    const prefs = deps.prefs.get()
    const st = service().status()
    const modelReady =
      prefs.whisperModelPath !== '' &&
      modelPathIsAllowed(prefs.whisperModelPath, {
        modelsDir: deps.modelsDir,
        userDataDir: deps.userDataDir,
        existsSync,
      })
    return {
      ok: true,
      enabled: prefs.speechEnabled,
      modelPath: prefs.whisperModelPath,
      modelReady,
      engine: { bin: st.engine.bin, source: st.engine.source },
      running: st.running,
    }
  }

  return {
    'speech:getStatus': async (args) => {
      const parsed = validatePayload(speechGetStatusSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      return buildStatus()
    },

    'speech:setPrefs': async (args) => {
      const parsed = validatePayload(speechSetPrefsSchema, first(args))
      if (!parsed.ok) return parsed
      const input = parsed.data as SpeechSetPrefsInput
      if (input.modelPath !== undefined) {
        if (input.modelPath === '') {
          deps.prefs.set({ whisperModelPath: '' })
        } else {
          const rejection = checkWhisperModelPath({
            path: input.modelPath,
            modelsDir: deps.modelsDir,
            userDataDir: deps.userDataDir,
            existsSync,
          })
          if (rejection !== undefined) {
            return { ok: false, error: rejection } satisfies SpeechStatusReply
          }
          deps.prefs.set({ whisperModelPath: input.modelPath })
        }
      }
      if (input.enabled !== undefined) deps.prefs.set({ speechEnabled: input.enabled })
      return buildStatus()
    },

    'speech:pickModel': async (args) => {
      const parsed = validatePayload(speechPickModelSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      if (deps.dialog.showOpenDialog === undefined) {
        return { ok: false, error: 'dialog-unavailable' } satisfies SpeechPickModelReply
      }
      const defaultDir = join(deps.userDataDir, 'whisper-models')
      mkdirSync(defaultDir, { recursive: true })
      const result = await deps.dialog.showOpenDialog({
        title: '选择 Whisper 模型（ggml .bin / .gguf）',
        defaultPath: defaultDir,
        properties: ['openFile'],
        filters: [{ name: 'Whisper model', extensions: [...WHISPER_MODEL_EXTENSIONS] }],
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: true, path: null } satisfies SpeechPickModelReply
      }
      const picked = result.filePaths[0] ?? ''
      const rejection = checkWhisperModelPath({
        path: picked,
        modelsDir: deps.modelsDir,
        userDataDir: deps.userDataDir,
        existsSync,
      })
      if (rejection !== undefined) {
        return { ok: false, error: rejection } satisfies SpeechPickModelReply
      }
      return { ok: true, path: picked } satisfies SpeechPickModelReply
    },

    'speech:saveWav': async (args) => {
      const parsed = validatePayload(speechSaveWavSchema, first(args))
      if (!parsed.ok) return parsed
      const comma = parsed.data.dataURL.indexOf(',')
      const buf = Buffer.from(parsed.data.dataURL.slice(comma + 1), 'base64')
      if (buf.length === 0) return { ok: false, error: 'invalid-payload' } satisfies SpeechSaveWavReply
      if (buf.length > SPEECH_WAV_MAX_BYTES) {
        return { ok: false, error: 'dataurl-too-large' } satisfies SpeechSaveWavReply
      }
      const tmpDir = join(deps.userDataDir, 'tmp')
      mkdirSync(tmpDir, { recursive: true })
      const ts = Date.now()
      let path = join(tmpDir, `speech-${ts}.wav`)
      for (let n = 1; existsSync(path); n += 1) path = join(tmpDir, `speech-${ts}-${n}.wav`)
      writeFileSync(path, buf)
      return { ok: true, path } satisfies SpeechSaveWavReply
    },

    'speech:transcribe': async (args) => {
      const parsed = validatePayload(speechTranscribeSchema, first(args))
      if (!parsed.ok) return parsed
      const prefs = deps.prefs.get()
      if (prefs.whisperModelPath === '') {
        return { ok: false, error: 'model-not-configured' } satisfies SpeechTranscribeReply
      }
      const wavPath = resolvePath(parsed.data.wavPath)
      if (!isInsideDir(wavPath, resolvePath(join(deps.userDataDir, 'tmp')))) {
        return { ok: false, error: 'audio-path-outside-allowed' } satisfies SpeechTranscribeReply
      }
      let wav: Buffer
      try {
        if (!statSync(wavPath).isFile()) {
          return { ok: false, error: 'audio-path-outside-allowed' } satisfies SpeechTranscribeReply
        }
        wav = readFileSync(wavPath)
      } catch {
        return { ok: false, error: 'audio-not-found' } satisfies SpeechTranscribeReply
      }
      try {
        const text = await service().transcribe({
          wav: new Uint8Array(wav),
          modelPath: prefs.whisperModelPath,
          ...(parsed.data.language === undefined ? {} : { language: parsed.data.language }),
        })
        return { ok: true, text } satisfies SpeechTranscribeReply
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const code = detail.includes('engine binary not found')
          ? 'engine-missing'
          : detail.includes('not configured')
            ? 'model-not-configured'
            : 'transcribe-failed'
        return { ok: false, error: code, detail } satisfies SpeechTranscribeReply
      }
    },
  }
}
