/**
 * images API — OpenAI-compatible image generation (Wave5 T21)
 *
 * Routes:
 *   POST /v1/images/generations   (OpenAI spec)
 *   POST /api/generate-image      (alias, same payload shape)
 *
 * Design:
 * - prompt: string (required, trimmed non-empty)  -> straight to SD /generate
 * - No workflow JSON: extra fields like workflow/workflow_json are ignored/rejected
 * - Output: PNG as b64_json in OpenAI shape { created, data: [{ b64_json }] }
 * - Delegates to sd sidecar POST http://127.0.0.1:11436/generate via fetch injection
 * - Host MUST stay 127.0.0.1 (sidecar invariant)
 *
 * MIT only — no AGPL.
 */

import { generateImage, getGenerateUrl, SD_HOST, SD_PORT, type SdGenerateRequest, type SdGenerateResponse } from '../sidecars/sd'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IMAGES_GENERATIONS_PATH = '/v1/images/generations' as const
export const API_GENERATE_IMAGE_PATH = '/api/generate-image' as const
export const ALLOWED_PATHS = [IMAGES_GENERATIONS_PATH, API_GENERATE_IMAGE_PATH] as const

export const DEFAULT_SIZE = '512x512' as const
export const DEFAULT_N = 1 as const
export const MAX_N = 4 as const
export const MAX_PROMPT_LEN = 4000 as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImagesGenerationsBody = {
  prompt: string
  n?: number
  size?: string
  model?: string
  response_format?: string
  // optional SD passthrough (kept minimal)
  negative_prompt?: string
  steps?: number
  cfg_scale?: number
  seed?: number
  // explicitly NOT supported workflow json
  workflow?: unknown
  workflow_json?: unknown
  [k: string]: unknown
}

export type ApiGenerateImageBody = {
  prompt: string
  n?: number
  size?: string
  width?: number
  height?: number
  steps?: number
  cfg_scale?: number
  seed?: number
  negative_prompt?: string
  [k: string]: unknown
}

export type ImageB64Item = { b64_json: string; revised_prompt?: string }
export type ImagesGenerationsResponse = {
  created: number
  data: ImageB64Item[]
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type ImagesDeps = {
  port?: number
  fetchImpl?: FetchLike
  /** Override generate for tests (if supplied, fetchImpl/port ignored). */
  generateImpl?: (req: SdGenerateRequest, opts?: { port?: number; fetchImpl?: FetchLike; signal?: AbortSignal }) => Promise<SdGenerateResponse>
  signal?: AbortSignal
  /** sd 异步任务轮询间隔 ms（默认 800；测试可调小） */
  pollMs?: number
}

// ---------------------------------------------------------------------------
// Helpers: size / prompt / n
// ---------------------------------------------------------------------------

export function parseSize(size?: string): { width: number; height: number } {
  const raw = (size ?? DEFAULT_SIZE).trim()
  const m = raw.match(/^(\d+)x(\d+)$/i)
  if (!m) throw new HttpError(400, `invalid size "${raw}" — expected WxH like 512x512`)
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64 || w > 2048 || h > 2048) {
    throw new HttpError(400, `size out of range: ${raw} (64..2048)`)
  }
  // sd.cpp prefers multiples; we allow any integer in range (up to caller)
  return { width: w, height: h }
}

export function normalizeN(n: unknown): number {
  if (n === undefined || n === null) return DEFAULT_N
  const num = typeof n === 'string' ? Number(n) : (n as number)
  if (!Number.isInteger(num) || num < 1 || num > MAX_N) {
    throw new HttpError(400, `invalid n "${String(n)}" — must be integer 1..${MAX_N}`)
  }
  return num
}

export function validatePrompt(prompt: unknown): string {
  if (typeof prompt !== 'string') throw new HttpError(400, 'prompt is required and must be a string')
  const p = prompt.trim()
  if (!p) throw new HttpError(400, 'prompt is required')
  if (p.length > MAX_PROMPT_LEN) throw new HttpError(400, `prompt too long (${p.length} > ${MAX_PROMPT_LEN})`)
  return p
}

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function rejectWorkflowFields(body: Record<string, unknown>): void {
  // Task: 无工作流 JSON — if caller sends workflow JSON we error (not silently ignore huge graph)
  if (body['workflow'] !== undefined || body['workflow_json'] !== undefined || body['workflowJson'] !== undefined || body['graph'] !== undefined) {
    throw new HttpError(400, 'workflow JSON not supported — send prompt string only')
  }
}

function extractB64s(res: SdGenerateResponse): string[] {
  if (Array.isArray(res.images) && res.images.length) return res.images.filter((s) => typeof s === 'string' && s.length > 0) as string[]
  if (typeof res.image === 'string' && res.image.length) return [res.image]
  // Some builds return { b64_json } or { data: ... } — be lenient for tests
  const maybe = (res as Record<string, unknown>)['b64_json']
  if (typeof maybe === 'string' && maybe.length) return [maybe]
  const maybeData = (res as Record<string, unknown>)['data']
  if (Array.isArray(maybeData)) {
    const out: string[] = []
    for (const it of maybeData as unknown[]) {
      const rec = it as Record<string, unknown>
      if (typeof rec['b64_json'] === 'string') out.push(rec['b64_json'] as string)
      else if (typeof rec['image'] === 'string') out.push(rec['image'] as string)
    }
    if (out.length) return out
  }
  throw new HttpError(502, 'sd /generate returned no image')
}

// ---------------------------------------------------------------------------
// Core: single prompt -> N images (sequential to avoid VRAM spike)
// ---------------------------------------------------------------------------

export async function generateB64List(
  body: ImagesGenerationsBody | ApiGenerateImageBody,
  deps: ImagesDeps = {},
): Promise<string[]> {
  const rec = body as Record<string, unknown>
  rejectWorkflowFields(rec)
  const prompt = validatePrompt(rec['prompt'])
  const n = normalizeN(rec['n'])
  // size: prefer explicit width/height if provided via /api/generate-image
  let width: number
  let height: number
  const wRaw = rec['width']
  const hRaw = rec['height']
  if (wRaw !== undefined || hRaw !== undefined) {
    const w = Number(wRaw)
    const h = Number(hRaw)
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64 || w > 2048 || h > 2048) {
      throw new HttpError(400, `invalid width/height ${String(wRaw)}x${String(hRaw)} (64..2048)`)
    }
    width = w
    height = h
  } else {
    const sz = parseSize(rec['size'] as string | undefined)
    width = sz.width
    height = sz.height
  }

  const sdReq: SdGenerateRequest = {
    prompt,
    width,
    height,
  }
  if (typeof rec['negative_prompt'] === 'string') sdReq.negative_prompt = rec['negative_prompt'] as string
  if (rec['steps'] !== undefined) sdReq.steps = Number(rec['steps'])
  if (rec['cfg_scale'] !== undefined) sdReq.cfg_scale = Number(rec['cfg_scale'])
  if (rec['seed'] !== undefined) sdReq.seed = Number(rec['seed'])

  const doGenerate = deps.generateImpl
    ? (r: SdGenerateRequest) => deps.generateImpl!(r, { port: deps.port, fetchImpl: deps.fetchImpl, signal: deps.signal })
    : (r: SdGenerateRequest) => generateImage(r, { port: deps.port, fetchImpl: deps.fetchImpl, signal: deps.signal, ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }) })

  const out: string[] = []
  for (let i = 0; i < n; i++) {
    // For n>1 vary seed deterministically if seed provided
    const req = i === 0 ? sdReq : { ...sdReq, seed: sdReq.seed !== undefined ? (sdReq.seed as number) + i : undefined }
    const res = await doGenerate(req)
    const b64s = extractB64s(res)
    // sd may return batch internally — take first for this iteration
    out.push(b64s[0]!)
    // if sd returned multiple images for n=1, expand
    if (b64s.length > 1 && n === 1) {
      // include extras
      for (let k = 1; k < b64s.length; k++) out.push(b64s[k]!)
      break
    }
  }
  return out.slice(0, n)
}

export function toOpenAIResponse(b64s: string[], prompt?: string): ImagesGenerationsResponse {
  return {
    created: Math.floor(Date.now() / 1000),
    data: b64s.map((b64) => ({ b64_json: b64, ...(prompt ? { revised_prompt: prompt } : {}) })),
  }
}

// ---------------------------------------------------------------------------
// Public handlers (body -> response) — for unit tests and direct usage
// ---------------------------------------------------------------------------

export async function handleImagesGenerations(
  body: unknown,
  deps: ImagesDeps = {},
): Promise<ImagesGenerationsResponse> {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'request body must be JSON object')
  const promptForRevised = validatePrompt((body as Record<string, unknown>)['prompt'])
  const b64s = await generateB64List(body as ImagesGenerationsBody, deps)
  // include revised_prompt echo for completeness (prompt itself)
  return toOpenAIResponse(b64s, promptForRevised)
}

/** Alias: POST /api/generate-image — same logic, same OpenAI shape */
export async function handleGenerateImage(
  body: unknown,
  deps: ImagesDeps = {},
): Promise<ImagesGenerationsResponse> {
  return handleImagesGenerations(body, deps)
}

// ---------------------------------------------------------------------------
// Fetch-style router — mountable in node http / electron net / tests
// ---------------------------------------------------------------------------

function jsonRes(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}

export async function handleImagesRequest(req: Request, deps: ImagesDeps = {}): Promise<Response | null> {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    // relative url fallback
    url = new URL(req.url, `http://${SD_HOST}:${deps.port ?? SD_PORT}`)
  }
  const pathname = url.pathname
  const isGenerations = pathname === IMAGES_GENERATIONS_PATH || pathname === `${IMAGES_GENERATIONS_PATH}/`
  const isAlias = pathname === API_GENERATE_IMAGE_PATH || pathname === `${API_GENERATE_IMAGE_PATH}/`
  if (!isGenerations && !isAlias) return null
  if (req.method.toUpperCase() !== 'POST') {
    return jsonRes(405, { error: `method ${req.method} not allowed, use POST` })
  }
  let body: unknown
  const ct = req.headers.get('content-type') ?? ''
  try {
    if (ct.includes('application/json')) {
      body = await req.json()
    } else {
      const text = await req.text()
      body = text ? JSON.parse(text) : {}
    }
  } catch {
    return jsonRes(400, { error: 'invalid json body' })
  }

  // response_format must be b64_json if supplied
  const rf = (body as Record<string, unknown>)?.['response_format']
  if (rf !== undefined && rf !== 'b64_json') {
    return jsonRes(400, { error: 'response_format must be b64_json (url not supported offline)' })
  }

  try {
    const out = await handleImagesGenerations(body, deps)
    return jsonRes(200, out)
  } catch (e) {
    const err = e as HttpError
    const status = typeof err.status === 'number' ? err.status : 500
    const msg = err.message ?? String(e)
    return jsonRes(status, { error: msg })
  }
}

/** Create a fetch handler suitable for mounting: (req) => Promise<Response|null> */
export function createImagesHandler(deps: ImagesDeps = {}): (req: Request) => Promise<Response | null> {
  return (req: Request) => handleImagesRequest(req, deps)
}

/** Helpers for tests / diagnostics */
export function getImagesGenerationsUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}${IMAGES_GENERATIONS_PATH}`
}
export function getApiGenerateImageUrl(port: number = SD_PORT): string {
  return `http://${SD_HOST}:${port}${API_GENERATE_IMAGE_PATH}`
}
/** Expose SD generate url for reference */
export function getSdGenerateUrl(port: number = SD_PORT): string {
  return getGenerateUrl(port)
}

export default {
  IMAGES_GENERATIONS_PATH,
  API_GENERATE_IMAGE_PATH,
  handleImagesGenerations,
  handleGenerateImage,
  handleImagesRequest,
  createImagesHandler,
  generateB64List,
  parseSize,
  normalizeN,
  validatePrompt,
}
