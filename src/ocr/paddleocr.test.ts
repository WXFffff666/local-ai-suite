/**
 * paddleocr.ts の単体: stdin/stdout JSON-lines フレーミング(1入力↔1出力、
 * ハンドシェイク "OCR init completed."、それ以前のバナー/パイプモードノイズ、
 * code 100/101/エラー分岐)と PaddleOcrPipeline ライフサイクル(遅延 spawn・
 * exit → kill・応答タイムアウト・待機中のノイズ行スキップ)を FakeChild 経由で検証。
 * プロトコルの文字列はすべて実測プローブ(evidence task-37)から転記。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OcrEngineError,
  PaddleOcrPipeline,
  asciiEscapeJson,
  buildRequestLine,
  makeFakeStdio,
  parseResponseLine,
  responseText,
  OCR_READY_LINE,
  type OcrResponse,
} from './paddleocr'

afterEach(() => {
  vi.useRealTimers()
})

describe('buildRequestLine / asciiEscapeJson', () => {
  it('image_base64 → 1行 JSON + \\n(キーは1つのみ・接頭辞なし)', () => {
    const line = buildRequestLine({ imageBase64: 'iVBORw0KGgo=' })
    expect(line).toBe('{"image_base64":"iVBORw0KGgo="}\n')
  })

  it('image_path → バックスラッシュ正規化 + 非ASCIIを \\uXXXX エスケープ(docs 推奨)', () => {
    const line = buildRequestLine({ imagePath: 'D:\\画廊\\a.png' })
    expect(line.endsWith('\n')).toBe(true)
    // eslint-disable-next-line no-control-regex
    expect(line.replace(/\n/, '')).toMatch(/^[\x20-\x7e]+$/)
    expect(JSON.parse(line)).toEqual({ image_path: 'D:/画廊/a.png' })
  })

  it('data-URL 接頭辞入り base64 / 空パス / 両キーは拒否', () => {
    expect(() => buildRequestLine({ imageBase64: 'data:image/png;base64,QQ==' })).toThrow(OcrEngineError)
    expect(() => buildRequestLine({ imagePath: '' })).toThrow(/non-empty/)
    expect(() => buildRequestLine({ imagePath: 'a.png', imageBase64: 'QQ==' } as never)).toThrow(/exactly one/)
  })

  it('asciiEscapeJson は非ASCIIのみ \\uXXXX に変換(JSON として等価)', () => {
    const s = asciiEscapeJson(JSON.stringify({ t: '你好abc !@#' }))
    expect(s).not.toMatch(/[^\x00-\x7f]/)
    expect(JSON.parse(s)).toEqual({ t: '你好abc !@#' })
  })
})

describe('parseResponseLine / responseText', () => {
  it('バナー/パイプモード行は null(応答JSONでない)', () => {
    expect(parseResponseLine('PaddleOCR-json v1.4.1')).toBeNull()
    expect(parseResponseLine('OCR anonymous pipe mode.')).toBeNull()
    expect(parseResponseLine('{"noCode":1}')).toBeNull()
  })

  it('code 100 → テキスト行連結', () => {
    const res = parseResponseLine(
      '{"code":100,"data":[{"box":[[18,36],[262,36],[262,64],[18,64]],"score":0.926,"text":"Hello OCR 123"}]}',
    ) as OcrResponse
    expect(responseText(res)).toBe('Hello OCR 123')
    const two: OcrResponse = { code: 100, data: [{ text: '一行', score: 1, box: [[0, 0], [1, 0], [1, 1], [0, 1]] }, { text: '二行', score: 1, box: [[0, 0], [1, 0], [1, 1], [0, 1]] }] }
    expect(responseText(two)).toBe('一行\n二行')
  })

  it('code 101(空結果)はエラーではなく空文字', () => {
    expect(responseText({ code: 101, data: 'OCR result is empty.' })).toBe('')
  })

  it('code 300/301 等の引擎エラーは ocrCode 付き reject', () => {
    expect(() => responseText({ code: 300, data: 'Base64 decoding failed.' })).toThrow(/error 300/)
    try {
      responseText({ code: 403, data: 'No valid tasks.' })
    } catch (e) {
      expect((e as OcrEngineError).ocrCode).toBe(403)
    }
  })
})

function startPipeline(fake: ReturnType<typeof makeFakeStdio>, opts?: { initTimeoutMs?: number; responseTimeoutMs?: number }) {
  const pipe = new PaddleOcrPipeline({
    bin: 'C:\\engines\\ocr-cpu\\PaddleOCR-json.exe',
    spawnImpl: () => fake.child,
    initTimeoutMs: opts?.initTimeoutMs ?? 5_000,
    responseTimeoutMs: opts?.responseTimeoutMs ?? 5_000,
    exitGraceMs: 50,
  })
  return pipe
}

const HANDSHAKE = `PaddleOCR-json v1.4.1\n${OCR_READY_LINE}\n`

describe('PaddleOcrPipeline — spawn/handshake', () => {
  it('起動前のバナーノイズを無視し、OCR init completed. で resolve', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.pushStdout('PaddleOCR-json v1.4.1\nOCR anonymous pipe mode.\n')
    expect(pipe.isRunning()).toBe(false)
    fake.pushStdout(`${OCR_READY_LINE}\n`)
    await started
    expect(pipe.isRunning()).toBe(true)
  })

  it('ハンドシェイク前の early exit は reject(コード付き)', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.exit(1)
    await expect(started).rejects.toThrow(/exited \(code 1\)/)
  })

  it('init タイムアウトは initTimeoutMs で reject', async () => {
    vi.useFakeTimers()
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake, { initTimeoutMs: 100 })
    const started = pipe.ensureStarted()
    let rejection: unknown = null
    started.catch((e) => {
      rejection = e
    })
    await vi.advanceTimersByTimeAsync(150)
    expect(rejection).toBeInstanceOf(OcrEngineError)
    expect(String(rejection)).toMatch(/init timed out/)
  })
})

describe('PaddleOcrPipeline — recognize round trip', () => {
  it('1 in ↔ 1 out: リクエスト1行書き込み → 応答JSON1行で解決', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.pushStdout(HANDSHAKE)
    await started
    const p = pipe.recognize({ imageBase64: 'iVBORw0KGgo=' })
    await new Promise((r) => setTimeout(r, 0)) // let the promise chain reach stdin.write
    expect(fake.stdinWrites.at(-1)).toBe('{"image_base64":"iVBORw0KGgo="}\n')
    fake.pushStdout('{"code":100,"data":[{"text":"提取文字","score":0.9,"box":[[0,0],[1,0],[1,1],[0,1]]}]}\n')
    await expect(p).resolves.toBe('提取文字')
  })

  it('応答待ちの間の stdout ノイズ行はスキップして待ち続ける', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.pushStdout(HANDSHAKE)
    await started
    const p = pipe.recognize({ imagePath: 'D:/a.png' })
    await new Promise((r) => setTimeout(r, 0)) // request in flight before responses arrive
    fake.pushStdout('some paddle perf noise\n')
    fake.pushStdout('{"code":101,"data":"OCR result is empty."}\n')
    await expect(p).resolves.toBe('')
  })

  it('引擎エラー応答(code 202)は reject、プロセスは生存継続', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.pushStdout(HANDSHAKE)
    await started
    const p = pipe.recognize({ imagePath: 'D:/missing.png' })
    await new Promise((r) => setTimeout(r, 0)) // request in flight before the error response
    fake.pushStdout('{"code":202,"data":"File does not exist."}\n')
    await expect(p).rejects.toThrow(/error 202/)
    expect(pipe.isRunning()).toBe(true)
  })

  it('response タイムアウトは reject、後続リクエストは可能', async () => {
    vi.useFakeTimers()
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake, { responseTimeoutMs: 200 })
    const started = pipe.ensureStarted()
    fake.pushStdout(HANDSHAKE)
    await vi.advanceTimersByTimeAsync(0)
    void started
    await vi.runOnlyPendingTimersAsync().catch(() => undefined)
    const p = pipe.recognize({ imageBase64: 'QQ==' })
    const settled = p.catch((e) => e)
    await vi.advanceTimersByTimeAsync(300)
    const err = await settled
    expect(err).toBeInstanceOf(OcrEngineError)
    expect(String(err)).toMatch(/response timed out/)
  })

  it('稼働中の exit は保留中の recognize を reject', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.pushStdout(HANDSHAKE)
    await started
    const p = pipe.recognize({ imageBase64: 'QQ==' })
    await new Promise((r) => setTimeout(r, 0)) // request must be in flight before the kill
    fake.exit(0)
    await expect(p).rejects.toThrow(/exited/)
  })

  it('stop(): exit\\n を送信、grace 経過後も生存なら kill', async () => {
    vi.useFakeTimers()
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const started = pipe.ensureStarted()
    fake.pushStdout(HANDSHAKE)
    await vi.advanceTimersByTimeAsync(0)
    void started
    pipe.stop()
    expect(fake.stdinWrites.at(-1)).toBe('exit\n')
    expect(pipe.isRunning()).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(fake.killCount()).toBe(1)
    // exit が先に来たら kill しない
    const fake2 = makeFakeStdio()
    const pipe2 = startPipeline(fake2)
    const started2 = pipe2.ensureStarted()
    fake2.pushStdout(HANDSHAKE)
    await vi.advanceTimersByTimeAsync(0)
    void started2
    pipe2.stop()
    fake2.exit(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(fake2.killCount()).toBe(0)
  })

  it('未起動の recognize は ensureStarted でハンドシェイク待ちから開始', async () => {
    const fake = makeFakeStdio()
    const pipe = startPipeline(fake)
    const p = pipe.recognize({ imageBase64: 'QQ==' })
    fake.pushStdout(HANDSHAKE)
    await new Promise((r) => setTimeout(r, 0)) // handshake → write must settle before the response
    fake.pushStdout('{"code":100,"data":[{"text":"x","score":1,"box":[[0,0],[1,0],[1,1],[0,1]]}]}\n')
    await expect(p).resolves.toBe('x')
  })
})
