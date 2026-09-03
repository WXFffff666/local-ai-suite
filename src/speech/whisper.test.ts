/**
 * whisper.test.ts — todo36 client-layer units (no child process, no network:
 * argv matrix, engine-resolution precedence, multipart body composition via
 * fake FormData/Blob, response adapter).
 */
import path from 'path'

import { describe, expect, it, vi } from 'vitest'

import {
  buildWhisperArgs,
  getHealthUrl,
  getInferenceUrl,
  parseInferenceResponse,
  resolveWhisperEngine,
  transcribeWav,
  WHISPER_PORT,
  type BlobCtor,
  type FormDataCtor,
} from './whisper'

describe('buildWhisperArgs — whisper-server argv (b4938 --host/--port/-m)', () => {
  it('pins loopback host + port + model in argv order', () => {
    expect(buildWhisperArgs({ modelPath: 'D:\\models\\whisper\\ggml-base.bin', port: 11437 })).toEqual([
      '--host',
      '127.0.0.1',
      '--port',
      '11437',
      '--model',
      'D:\\models\\whisper\\ggml-base.bin',
    ])
  })

  it('rejects any non-loopback host (security baseline)', () => {
    expect(() => buildWhisperArgs({ host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/)
  })

  it('rejects out-of-range ports and bad threads', () => {
    expect(() => buildWhisperArgs({ port: 80 })).toThrow(/port out of range/)
    expect(() => buildWhisperArgs({ threads: 0 })).toThrow(/threads/)
  })

  it('threads + extraArgs append; language deliberately NOT argv (per-request form field)', () => {
    expect(
      buildWhisperArgs({ threads: 4, extraArgs: ['--verbose'] }),
    ).toEqual(['--host', '127.0.0.1', '--port', String(WHISPER_PORT), '--threads', '4', '--verbose'])
  })
})

describe('resolveWhisperEngine — WHISPER_BIN env > manifest-bundled > none', () => {
  const mkExists = (paths: string[]) => (p: string): boolean => paths.includes(p)

  it('env override wins and is trimmed', () => {
    const hit = resolveWhisperEngine({
      env: { WHISPER_BIN: ' D:\\tools\\w.exe ' },
      cwd: '/x',
      existsSync: mkExists([]),
    })
    expect(hit).toEqual({ bin: 'D:\\tools\\w.exe', source: 'env' })
  })

  it('bundled tier resolves manifest-relative file under <root>/engines', () => {
    const candidate = path.join('/app/resources', 'engines', 'whisper/whisper-server.exe')
    const hit = resolveWhisperEngine({
      env: {},
      resourcesPath: '/app/resources',
      bundled: { file: 'whisper/whisper-server.exe', sha256: 'a'.repeat(64) },
      existsSync: mkExists([candidate]),
    })
    expect(hit.source).toBe('bundled')
    expect(hit.bin).toBe(candidate)
    if (hit.source === 'bundled') expect(hit.expectedSha256).toBe('a'.repeat(64))
  })

  it('dev fallback build/engines without manifest (no sha pin)', () => {
    const hit = resolveWhisperEngine({
      env: {},
      cwd: 'D:\\repo',
      existsSync: mkExists([path.join('D:\\repo', 'build', 'engines', 'whisper', 'whisper-server.exe')]),
    })
    expect(hit).toMatchObject({ source: 'bundled' })
    if (hit.source === 'bundled') expect(hit.expectedSha256).toBeUndefined()
  })

  it('reports miss instead of PATH-guessing (whisper-server has no --version: fail-closed)', () => {
    expect(resolveWhisperEngine({ env: {}, cwd: '/x', resourcesPath: '/r', existsSync: () => false })).toEqual({
      bin: null,
      source: 'none',
    })
  })
})

describe('URLs', () => {
  it('health + inference on 127.0.0.1 with resolved port', () => {
    expect(getHealthUrl(20500)).toBe('http://127.0.0.1:20500/health')
    expect(getInferenceUrl(20500)).toBe('http://127.0.0.1:20500/inference')
  })
})

// ---------------------------------------------------------------------------
// transcribeWav — fake multipart stack
// ---------------------------------------------------------------------------

type FakeForm = { fields: Array<[string, unknown, string | undefined]> }

function fakeFormStack(): { FormData: FormDataCtor; Blob: BlobCtor; forms: FakeForm[] } {
  const forms: FakeForm[] = []
  class FakeFormData {
    fields: Array<[string, unknown, string | undefined]> = []
    constructor() {
      forms.push(this)
    }
    append(name: string, value: unknown, filename?: string): void {
      this.fields.push([name, value, filename])
    }
  }
  class FakeBlob {
    constructor(public parts: unknown[], public options?: { type?: string }) {}
  }
  return {
    FormData: FakeFormData as unknown as FormDataCtor,
    Blob: FakeBlob as unknown as BlobCtor,
    forms: forms as unknown as FakeForm[],
  }
}

describe('transcribeWav — POST multipart /inference (server.cpp has_file contract)', () => {
  it('composes file + language + response_format fields; default language auto', async () => {
    const stack = fakeFormStack()
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ text: '你好世界' }),
    }))
    const text = await transcribeWav(
      20500,
      { wav: new Uint8Array([1, 2, 3]) },
      { ...stack, fetchImpl: fetchImpl as never },
    )
    expect(text).toBe('你好世界')
    const url = fetchImpl.mock.calls[0]?.[0]
    expect(url).toBe('http://127.0.0.1:20500/inference')
    const fields = stack.forms[0]?.fields ?? []
    const names = fields.map((f) => f[0])
    expect(names).toEqual(['file', 'language', 'response_format', 'no_timestamps'])
    const language = fields.find((f) => f[0] === 'language')?.[1]
    expect(language).toBe('auto')
    expect(fields.find((f) => f[0] === 'response_format')?.[1]).toBe('json')
    // WAV bytes arrive as a Blob part with a filename (httplib multipart file field)
    const fileField = fields.find((f) => f[0] === 'file')
    expect(fileField?.[2]).toBe('speech.wav')
  })

  it('explicit language + translate ride the form; no translate key otherwise', async () => {
    const stack = fakeFormStack()
    const fetchImpl = vi.fn(async () => ({ status: 200, text: async () => '{"text":"ok"}' }))
    await transcribeWav(
      1,
      { wav: new Uint8Array(), language: ' zh ', translate: true },
      { ...stack, fetchImpl: fetchImpl as never },
    )
    const fields = stack.forms[0]?.fields ?? []
    expect(fields.find((f) => f[0] === 'language')?.[1]).toBe('zh')
    expect(fields.find((f) => f[0] === 'translate')?.[1]).toBe('true')
    await transcribeWav(1, { wav: new Uint8Array() }, { ...stack, fetchImpl: fetchImpl as never })
    const fields2 = stack.forms[1]?.fields ?? []
    expect(fields2.length).toBeGreaterThan(0)
    expect(fields2.some((f) => f[0] === 'translate')).toBe(false)
  })

  it('non-200 surfaces whisperStatus for the IPC error mapping', async () => {
    const stack = fakeFormStack()
    const fetchImpl = vi.fn(async () => ({ status: 400, text: async () => '{"error":"failed to read audio data"}' }))
    await expect(
      transcribeWav(1, { wav: new Uint8Array() }, { ...stack, fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ whisperStatus: 400, message: expect.stringContaining('failed to read audio data') })
  })
})

describe('parseInferenceResponse — OpenAI-shape adapter (json/verbose_json/text)', () => {
  it('{"text"} json format', () => {
    expect(parseInferenceResponse('{"text":" hello "}')).toBe('hello')
  })
  it('verbose_json falls back to joined segments when text absent', () => {
    expect(parseInferenceResponse('{"segments":[{"text":"a"},{"text":"b"}]}')).toBe('a b')
  })
  it('plain text body passes through', () => {
    expect(parseInferenceResponse(' 你好\n')).toBe('你好')
  })
  it('empty body = empty transcription, not an error', () => {
    expect(parseInferenceResponse('')).toBe('')
  })
  it('{"error":...} json throws with the server message', () => {
    expect(() => parseInferenceResponse('{"error":"model not loaded"}')).toThrow(/model not loaded/)
  })
  it('json with text: "" collapses to empty string', () => {
    expect(parseInferenceResponse('{"text":""}')).toBe('')
  })
})
