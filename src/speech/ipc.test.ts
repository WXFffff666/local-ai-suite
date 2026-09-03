/**
 * ipc.test.ts — speech:* handler units (todo36): zod gates, userData/tmp
 * confinement, size caps, prefs validation and the transcribe error-code
 * mapping. Real fs against a fresh tmpdir userDataDir; whisper service and
 * dialog are injected fakes (same seam convention as engines/updater).
 */
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

import { createSpeechHandlers, SPEECH_WAV_MAX_BYTES, type SpeechPrefs } from './ipc'
import type { SpeechServiceSurface } from './ipc'
import type {
  SpeechPickModelReply,
  SpeechSaveWavReply,
  SpeechStatusReply,
  SpeechTranscribeReply,
} from '../main/ipc/whitelist'

type Handlers = ReturnType<typeof createSpeechHandlers>

function makeHarness(opts: {
  prefs?: Partial<SpeechPrefs>
  service?: SpeechServiceSurface
  dialogOk?: string | null
} = {}) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'las-speech-'))
  const modelsDir = path.join(userDataDir, 'models')
  mkdirSync(modelsDir, { recursive: true })
  let prefs: SpeechPrefs = { speechEnabled: true, whisperModelPath: '', ...opts.prefs }
  const transcribe = vi.fn(async () => '你好')
  const service: SpeechServiceSurface = opts.service ?? ({
    status: () => ({ engine: { bin: 'D:\\e\\whisper-server.exe', source: 'bundled' }, running: false, port: 11437, state: 'stopped' }),
    transcribe,
    stop: () => undefined,
  } as unknown as SpeechServiceSurface)
  const dialog = {
    showOpenDialog: vi.fn(async () =>
      opts.dialogOk === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [opts.dialogOk ?? ''] },
    ),
  }
  const handlers: Handlers = createSpeechHandlers({
    userDataDir,
    modelsDir,
    prefs: {
      get: () => prefs,
      set: (partial) => {
        prefs = { ...prefs, ...partial }
        return prefs
      },
    },
    dialog,
    service: () => service,
  })
  return { handlers, userDataDir, modelsDir, prefsRef: () => prefs, transcribe, dialog, service }
}

const wavURL = (bytes: number): string =>
  `data:audio/wav;base64,${Buffer.alloc(bytes, 7).toString('base64')}`

describe('speech:getStatus (spawn-free)', () => {
  it('reports enabled/model/engine; modelReady requires a confined existing file', async () => {
    const h = makeHarness()
    const reply = (await h.handlers['speech:getStatus']([{}])) as SpeechStatusReply
    expect(reply.ok).toBe(true)
    if (reply.ok !== true) return
    expect(reply.enabled).toBe(true)
    expect(reply.modelReady).toBe(false)
    expect(reply.engine).toEqual({ bin: 'D:\\e\\whisper-server.exe', source: 'bundled' })
    expect(reply.running).toBe(false)
  })

  it('rejects payloads (strict empty-object gate)', async () => {
    const h = makeHarness()
    await expect(h.handlers['speech:getStatus']([{ nope: 1 }])).resolves.toMatchObject({ ok: false, error: 'invalid-payload' })
  })
})

describe('speech:setPrefs — whisper model confinement + shape validation', () => {
  it('accepts a .bin inside modelsDir and persists', async () => {
    const h = makeHarness()
    const model = path.join(h.modelsDir, 'ggml-base.bin')
    writeFileSync(model, 'm')
    const reply = (await h.handlers['speech:setPrefs']([{ modelPath: model }])) as SpeechStatusReply
    expect(reply.ok).toBe(true)
    if (reply.ok === true) expect(reply.modelReady).toBe(true)
    expect(h.prefsRef().whisperModelPath).toBe(model)
  })

  it('refuses paths outside modelsDir|userData', async () => {
    const outside = path.join(tmpdir(), 'evil-model.bin')
    writeFileSync(outside, 'm')
    const h = makeHarness()
    await expect(h.handlers['speech:setPrefs']([{ modelPath: outside }])).resolves.toMatchObject({
      ok: false,
      error: 'path-outside-allowed',
    })
  })

  it('refuses wrong extensions and missing files', async () => {
    const h = makeHarness()
    const exe = path.join(h.modelsDir, 'evil.exe')
    writeFileSync(exe, 'm')
    await expect(h.handlers['speech:setPrefs']([{ modelPath: exe }])).resolves.toMatchObject({ ok: false, error: 'bad-extension' })
    await expect(
      h.handlers['speech:setPrefs']([{ modelPath: path.join(h.modelsDir, 'gone.gguf') }]),
    ).resolves.toMatchObject({ ok: false, error: 'file-not-found' })
  })

  it('enabled toggle persists; empty prefs payload is a zod 400', async () => {
    const h = makeHarness()
    const reply = (await h.handlers['speech:setPrefs']([{ enabled: false }])) as SpeechStatusReply
    expect(reply.ok === true && reply.enabled).toBe(false)
    await expect(h.handlers['speech:setPrefs']([{}])).resolves.toMatchObject({ ok: false, error: 'invalid-payload' })
  })

  it("modelPath '' clears the model (un-configured state)", async () => {
    const model = path.join(mkdtempSync(path.join(tmpdir(), 'las-s2-')), 'x.bin')
    const h = makeHarness({ prefs: { whisperModelPath: 'x' } })
    const reply = (await h.handlers['speech:setPrefs']([{ modelPath: '' }])) as SpeechStatusReply
    expect(reply.ok === true && reply.modelPath).toBe('')
    void model
  })
})

describe('speech:pickModel', () => {
  it('canceled dialog -> path null', async () => {
    const h = makeHarness({ dialogOk: null })
    const reply = (await h.handlers['speech:pickModel']([{}])) as SpeechPickModelReply
    expect(reply).toEqual({ ok: true, path: null })
  })

  it('picked file inside userData/whisper-models is accepted', async () => {
    const h = makeHarness()
    const dir = path.join(h.userDataDir, 'whisper-models')
    mkdirSync(dir, { recursive: true })
    const model = path.join(dir, 'ggml-small.bin')
    writeFileSync(model, 'm')
    h.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [model] })
    const reply = (await h.handlers['speech:pickModel']([{}])) as SpeechPickModelReply
    expect(reply).toEqual({ ok: true, path: model })
  })

  it('dialog without showOpenDialog -> honest dialog-unavailable', async () => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'las-s3-'))
    const handlers = createSpeechHandlers({
      userDataDir,
      modelsDir: userDataDir,
      prefs: { get: () => ({ speechEnabled: true, whisperModelPath: '' }), set: (p) => ({ speechEnabled: true, whisperModelPath: '', ...p }) },
      dialog: {},
    })
    await expect(handlers['speech:pickModel']([{}])).resolves.toMatchObject({ ok: false, error: 'dialog-unavailable' })
  })
})

describe('speech:saveWav — generalized saveTempImage (32 MiB cap)', () => {
  it('writes the decoded WAV under userData/tmp and returns the path', async () => {
    const h = makeHarness()
    const reply = (await h.handlers['speech:saveWav']([{ dataURL: wavURL(1024) }])) as SpeechSaveWavReply
    expect(reply.ok).toBe(true)
    if (reply.ok !== true) return
    expect(reply.path).toContain('speech-')
    expect(readFileSync(reply.path).length).toBe(1024)
  })

  it('non-WAV dataURLs are rejected by the zod gate', async () => {
    const h = makeHarness()
    await expect(
      h.handlers['speech:saveWav']([{ dataURL: 'data:image/png;base64,QQ==' }]),
    ).resolves.toMatchObject({ ok: false, error: 'invalid-payload' })
  })

  it('decoded bytes over the cap -> dataurl-too-large', async () => {
    const h = makeHarness()
    const dataURL = wavURL(SPEECH_WAV_MAX_BYTES + 1)
    // stays under the zod char pre-guard (45M) while crossing the 32MiB decoded cap
    expect(dataURL.length).toBeLessThan(45_000_000)
    await expect(h.handlers['speech:saveWav']([{ dataURL }])).resolves.toMatchObject({ ok: false, error: 'dataurl-too-large' })
  })

  it('empty payload -> invalid-payload', async () => {
    const h = makeHarness()
    await expect(h.handlers['speech:saveWav']([{ dataURL: 'data:audio/wav;base64,' }])).resolves.toMatchObject({
      ok: false,
      error: 'invalid-payload',
    })
  })
})

describe('speech:transcribe', () => {
  /** configure a model through the setPrefs handler (same userData harness). */
  async function configureModel(h: ReturnType<typeof makeHarness>): Promise<string> {
    const model = path.join(h.modelsDir, 'ggml-base.bin')
    mkdirSync(path.dirname(model), { recursive: true })
    writeFileSync(model, 'ggml-model')
    const reply = (await h.handlers['speech:setPrefs']([{ modelPath: model }])) as SpeechStatusReply
    if (reply.ok !== true) throw new Error('model configure failed')
    return model
  }

  it('happy: tmp WAV + configured model -> service.transcribe(wav, language)', async () => {
    const h = makeHarness()
    const model = await configureModel(h)
    const saved = (await h.handlers['speech:saveWav']([{ dataURL: wavURL(8) }])) as SpeechSaveWavReply
    if (saved.ok !== true) throw new Error('save failed')
    const reply = (await h.handlers['speech:transcribe']([{ wavPath: saved.path, language: 'zh' }])) as SpeechTranscribeReply
    expect(reply).toEqual({ ok: true, text: '你好' })
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    const req = h.transcribe.mock.calls[0]?.[0] as { modelPath: string; language?: string; wav: Uint8Array }
    expect(req.modelPath).toBe(model)
    expect(req.language).toBe('zh')
    expect(req.wav.length).toBe(8)
  })

  it('no model configured -> model-not-configured, service untouched', async () => {
    const h = makeHarness()
    const reply = (await h.handlers['speech:transcribe']([{ wavPath: path.join(h.userDataDir, 'tmp', 'x.wav') }])) as SpeechTranscribeReply
    expect(reply.ok).toBe(false)
    if (reply.ok === false) expect(reply.error).toBe('model-not-configured')
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('wavPath outside userData/tmp is refused (no arbitrary file reads)', async () => {
    const h = makeHarness()
    await configureModel(h)
    await expect(
      h.handlers['speech:transcribe']([{ wavPath: path.join(h.userDataDir, '..', 'speech-outside.wav') }]),
    ).resolves.toMatchObject({ ok: false, error: 'audio-path-outside-allowed' })
    await expect(
      h.handlers['speech:transcribe']([{ wavPath: path.resolve(process.execPath) }]),
    ).resolves.toMatchObject({ ok: false, error: 'audio-path-outside-allowed' })
    expect(h.transcribe).not.toHaveBeenCalled()
  })

  it('service failure maps to engine-missing / transcribe-failed with detail', async () => {
    const h = makeHarness()
    await configureModel(h)
    const saved = (await h.handlers['speech:saveWav']([{ dataURL: wavURL(4) }])) as SpeechSaveWavReply
    if (saved.ok !== true) throw new Error('save failed')
    vi.mocked(h.transcribe).mockRejectedValueOnce(new Error('whisper engine binary not found — check Settings → Speech'))
    await expect(h.handlers['speech:transcribe']([{ wavPath: saved.path }])).resolves.toMatchObject({ ok: false, error: 'engine-missing' })
    vi.mocked(h.transcribe).mockRejectedValueOnce(new Error('whisper /inference failed: 500'))
    const reply = (await h.handlers['speech:transcribe']([{ wavPath: saved.path }])) as SpeechTranscribeReply
    expect(reply.ok === false && reply.error).toBe('transcribe-failed')
    expect(reply.ok === false && reply.detail).toContain('500')
  })

  it('missing WAV file -> audio-not-found', async () => {
    const h = makeHarness()
    await configureModel(h)
    const missing = path.join(h.userDataDir, 'tmp', 'speech-999999.wav')
    await expect(h.handlers['speech:transcribe']([{ wavPath: missing }])).resolves.toMatchObject({ ok: false, error: 'audio-not-found' })
  })
})
