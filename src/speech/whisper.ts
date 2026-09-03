/**
 * whisper.ts — whisper.cpp server client layer (todo36, pure, no electron).
 *
 * Transport decision (Appendix R3 §A row 36 + b4938 source audit, see
 * .omo/evidence/task-36): the staged engine is whisper-server.exe ONLY
 * (gen-engine-manifest PINS: Release/whisper-server.exe — no whisper-cli in
 * whisper-bin-x64.zip), so the client speaks the whisper.cpp server protocol
 * directly. Upstream /v1/audio/transcriptions is UNCONFIRMED; /inference is
 * multipart/form-data (server.cpp get_req_parameters: req.has_file(...) —
 * NOT the JSON media-base64 shape OpenAI adapters assume), and
 * common-whisper.h read_audio_data accepts an in-memory WAV buffer — ffmpeg
 * is only needed behind --convert for non-WAV input. We therefore encode
 * 16 kHz mono PCM16 WAV renderer-side and POST it as form-data: zero
 * external tooling, zero CDN.
 *
 * The OpenAI-shape adapter is parseInferenceResponse: json {text} /
 * verbose_json {segments[]} / plain text all collapse to one string.
 */

import { existsSync as fsExistsSync } from 'fs'
import { join } from 'path'

import { SIDECAR_HOST } from '../core/types'

export const WHISPER_NAME = 'whisper' as const
/** Preferred base port; SidecarManager preflight reallocates dynamically (20000-30000) on conflict. */
export const WHISPER_PORT = 11437 as const

export function getHealthUrl(port: number): string {
  return `http://${SIDECAR_HOST}:${port}/health`
}

export function getInferenceUrl(port: number): string {
  return `http://${SIDECAR_HOST}:${port}/inference`
}

// ---------------------------------------------------------------------------
// Args builder (server: --host/--port/-m; language rides the per-request form)
// ---------------------------------------------------------------------------

export type BuildWhisperArgsOptions = {
  /** Absolute whisper ggml (.bin) / gguf model path. */
  modelPath?: string
  host?: string
  port?: number
  threads?: number
  extraArgs?: string[]
}

export function buildWhisperArgs(opts: BuildWhisperArgsOptions = {}): string[] {
  const host = opts.host ?? SIDECAR_HOST
  if (host !== SIDECAR_HOST) {
    throw new Error(`whisper sidecar host must be ${SIDECAR_HOST}, got ${host}`)
  }
  const port = opts.port ?? WHISPER_PORT
  if (port < 1024 || port > 65535) throw new Error(`port out of range: ${port}`)
  const args: string[] = ['--host', host, '--port', String(port)]
  if (opts.modelPath) args.push('--model', opts.modelPath)
  if (opts.threads !== undefined) {
    if (!Number.isInteger(opts.threads) || opts.threads < 1) {
      throw new Error(`threads must be >=1, got ${opts.threads}`)
    }
    args.push('--threads', String(opts.threads))
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  return args
}

// ---------------------------------------------------------------------------
// Engine binary resolution (env > manifest-bundled > absent; PATH is NOT a
// tier: whisper-server has no --version flag, so the resolver cascade would be
// fail-closed anyway — gen-engine-manifest.mjs PINS comment, b4938 audited).
// ---------------------------------------------------------------------------

export type WhisperEngineHit = {
  bin: string
  source: 'env' | 'bundled'
  /** Expected sha256 from the distribution manifest (bundled tier only). */
  expectedSha256?: string
}
export type WhisperEngineMiss = { bin: null; source: 'none' }
export type WhisperEngineResolution = WhisperEngineHit | WhisperEngineMiss

export type ResolveWhisperEngineDeps = {
  env?: Record<string, string | undefined>
  /** extraResources root (packaged) — <resourcesPath>/engines/whisper/... */
  resourcesPath?: string
  /** dev cwd — build/engines/whisper/... */
  cwd?: string
  /** manifest cpu spec (file + sha256) for the bundled tier; absent = dev fallback. */
  bundled?: { file: string; sha256?: string } | null
  existsSync?: (p: string) => boolean
}

export function resolveWhisperEngine(deps: ResolveWhisperEngineDeps = {}): WhisperEngineResolution {
  const env = deps.env ?? (typeof process !== 'undefined' ? process.env : {})
  const existsSync = deps.existsSync ?? fsExistsSync
  const override = env['WHISPER_BIN']
  if (override && override.trim() !== '') {
    return { bin: override.trim(), source: 'env' }
  }
  const file = deps.bundled?.file ?? join('whisper', 'whisper-server.exe')
  const roots: string[] = []
  if (deps.resourcesPath) roots.push(join(deps.resourcesPath, 'engines'))
  if (deps.cwd) roots.push(join(deps.cwd, 'build', 'engines'))
  for (const root of roots) {
    const candidate = join(root, file)
    if (existsSync(candidate)) {
      const hit: WhisperEngineHit = { bin: candidate, source: 'bundled' }
      if (deps.bundled?.sha256) hit.expectedSha256 = deps.bundled.sha256
      return hit
    }
  }
  return { bin: null, source: 'none' }
}

// ---------------------------------------------------------------------------
// /inference request + response adapter
// ---------------------------------------------------------------------------

export type TranscribeRequest = {
  /** 16 kHz mono PCM16 WAV bytes (encoded renderer-side, src/chat/audio.ts). */
  wav: Uint8Array
  /** whisper language token ('auto', 'en', 'zh', 'chinese'...); default 'auto'. */
  language?: string
  /** Ask the server to translate to English (server form field 'translate'). */
  translate?: boolean
}

export type FormDataCtor = new () => {
  append(name: string, value: unknown, filename?: string): void
}
export type BlobCtor = new (parts: unknown[], options?: { type?: string }) => unknown
export type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<{
  status: number
  headers?: { get?(name: string): string | null }
  text(): Promise<string>
  json?(): Promise<unknown>
}>

export type WhisperInferenceError = Error & { whisperStatus?: number }

export function whisperError(message: string, status?: number): WhisperInferenceError {
  const err = new Error(message) as WhisperInferenceError
  if (status !== undefined) err.whisperStatus = status
  return err
}

/**
 * POST multipart /inference — 'file' part carries the WAV bytes (server.cpp
 * requires has_file("file"); text fields per get_req_parameters). Returns the
 * transcribed text via the OpenAI-shape adapter below.
 */
export async function transcribeWav(
  port: number,
  req: TranscribeRequest,
  deps: {
    fetchImpl?: FetchLike
    FormData?: FormDataCtor
    Blob?: BlobCtor
    signal?: AbortSignal
  } = {},
): Promise<string> {
  const doFetch = deps.fetchImpl ?? (fetch as unknown as FetchLike)
  const FormDataImpl = deps.FormData ?? (globalThis.FormData as FormDataCtor | undefined)
  const BlobImpl = deps.Blob ?? (globalThis.Blob as BlobCtor | undefined)
  if (!FormDataImpl || !BlobImpl) {
    throw whisperError('FormData/Blob globals unavailable in this runtime')
  }
  const form = new FormDataImpl()
  const filePart = new BlobImpl([req.wav], { type: 'audio/wav' })
  form.append('file', filePart, 'speech.wav')
  form.append('language', req.language && req.language.trim() ? req.language.trim() : 'auto')
  form.append('response_format', 'json')
  form.append('no_timestamps', 'true')
  if (req.translate === true) form.append('translate', 'true')

  const res = await doFetch(getInferenceUrl(port), { method: 'POST', body: form, signal: deps.signal })
  const body = await res.text()
  if (res.status !== 200) {
    throw whisperError(`whisper /inference failed: ${res.status} ${body.slice(0, 300)}`.trim(), res.status)
  }
  return parseInferenceResponse(body)
}

/**
 * OpenAI-shape adapter (~plan row 36): the server returns {"text": "..."} for
 * response_format=json, {"segments":[{"text":...}]} for verbose_json, and
 * bare text for response_format=text. Collapse all three; empty/whitespace is
 * NOT an error — an empty recording legitimately transcribes to ''.
 */
export function parseInferenceResponse(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return trimmed
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      if (typeof obj['text'] === 'string') return obj['text'].trim()
      const segments = obj['segments']
      if (Array.isArray(segments)) {
        return segments
          .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>)['text'] : undefined))
          .filter((t): t is string => typeof t === 'string')
          .join(' ')
          .trim()
      }
      const error = obj['error']
      if (typeof error === 'string' && error) throw whisperError(`whisper /inference error: ${error}`)
    }
    return trimmed
  }
  return trimmed
}
