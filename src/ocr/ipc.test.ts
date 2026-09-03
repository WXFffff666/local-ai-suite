/**
 * ipc.test.ts — ocr:* ハンドラの単位テスト (todo37, speech/ipc.test 同款の
 * 注入規約): zod ゲート(空 strict・dataURL フォーマット・exactly-one-source)、
 * galleryId はメイン側 Gallery.get 経由のみ受理(レンダラは FS パスを供給しない)、
 * 32 MiB 復号上限、エンジン欠落/改ざん/失敗のエラコードマッピング、
 * install は ack + 'ocr:progress' イベント(完了系 done/quarantined/error)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createOcrHandlers, dataUrlToBase64, OCR_IMAGE_MAX_BYTES } from './ipc'
import type { OcrService } from './service'
import type { HandlerContext } from '../main/ipc/handlers'
import type { GalleryItem } from '../gallery/gallery'
import type {
  OcrInstallReply,
  OcrProgressEvent,
  OcrRecognizeReply,
  OcrStatusReply,
} from '../main/ipc/whitelist'

let tmp = ''
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

const PNG_B64 = Buffer.from('89504e470d0a1a0a00', 'hex').toString('base64')
const pngURL = `data:image/png;base64,${PNG_B64}`

function makeGalleryFile(): { dir: string; item: GalleryItem; id: string } {
  tmp = mkdtempSync(path.join(tmpdir(), 'las-ocr-ipc-'))
  const id = 'abc-123'
  const itemDir = path.join(tmp, 'gallery', id)
  mkdirSync(itemDir, { recursive: true })
  const originalPath = path.join(itemDir, 'original.png')
  writeFileSync(originalPath, 'png-bytes')
  const item = {
    id,
    prompt: 'p',
    createdAt: 1,
    originalPath,
    thumbPath: path.join(itemDir, 'thumb.png'),
    metaPath: path.join(itemDir, 'meta.json'),
  } as GalleryItem
  return { dir: tmp, item, id }
}

function makeHarness(opts: {
  service?: Partial<OcrService>
  galleryItem?: GalleryItem | null
  engineSource?: 'env' | 'pack' | 'none'
} = {}) {
  const recognize = vi.fn(async () => '识别文字')
  const install = vi.fn(async (onProgress?: (p: { percent: number; downloaded: number; total: number | null; stage: 'downloading' | 'verifying' | 'activating' }) => void) => {
    // gpuPack PackProgress シェイプで進行段階を流す(デフォルト fake)
    onProgress?.({ percent: 5, downloaded: 512, total: 1024, stage: 'downloading' })
    onProgress?.({ percent: 100, downloaded: 1024, total: 1024, stage: 'verifying' })
    onProgress?.({ percent: 100, downloaded: 0, total: null, stage: 'activating' })
    return { ok: true } as { ok: boolean; reason?: string }
  })
  const engine = {
    bin: (opts.engineSource ?? 'pack') === 'none' ? null : 'D:\\engines\\ocr-cpu\\PaddleOCR-json.exe',
    source: (opts.engineSource ?? 'pack') as 'env' | 'pack' | 'none',
    version: (opts.engineSource ?? 'pack') === 'none' ? null : 'v1.4.1',
  }
  const status = vi.fn(() => ({
    engine: { ...engine },
    running: false,
    supported: true,
  }))
  const service = {
    status,
    recognize,
    install,
    stop: vi.fn(),
    resolveEngine: vi.fn(),
    supported: vi.fn(() => true),
    ...opts.service,
  } as unknown as OcrService
  const galleryGet = vi.fn((id: string): GalleryItem => {
    if (opts.galleryItem && opts.galleryItem.id === id) return opts.galleryItem
    throw new Error(`unknown gallery id: ${id}`)
  })
  const send = vi.fn()
  const ctx = { send } as unknown as HandlerContext
  const handlers = createOcrHandlers({ service: () => service, gallery: () => ({ get: galleryGet }) })
  return { handlers, service, recognize, install, status, galleryGet, send, ctx, engine }
}

describe('ocr:status (spawn しない)', () => {
  it('エンジン来源/サポート/稼働をそのまま返す', async () => {
    const h = makeHarness()
    const reply = (await h.handlers['ocr:status']([{}], h.ctx)) as OcrStatusReply
    expect(reply.ok).toBe(true)
    if (reply.ok !== true) return
    expect(reply.supported).toBe(true)
    expect(reply.engine).toEqual({ bin: 'D:\\engines\\ocr-cpu\\PaddleOCR-json.exe', source: 'pack', version: 'v1.4.1' })
    expect(reply.running).toBe(false)
    expect(h.recognize).not.toHaveBeenCalled()
    expect(h.install).not.toHaveBeenCalled()
  })

  it('strict ゲート: 余計なキーは 400-shape', async () => {
    const h = makeHarness()
    await expect(h.handlers['ocr:status']([{ junk: 1 }], h.ctx)).resolves.toMatchObject({ ok: false, error: 'invalid-payload' })
  })
})

describe('ocr:recognize', () => {
  it('dataURL → 接頭辞除去後 image_base64 にマップ', async () => {
    const h = makeHarness()
    const reply = (await h.handlers['ocr:recognize']([{ dataURL: pngURL }], h.ctx)) as OcrRecognizeReply
    expect(reply).toEqual({ ok: true, text: '识别文字' })
    expect(h.recognize).toHaveBeenCalledWith({ imageBase64: PNG_B64 })
  })

  it('galleryId → メイン側 Gallery.get の originalPath を image_path に', async () => {
    const g = makeGalleryFile()
    const h = makeHarness({ galleryItem: g.item })
    const reply = (await h.handlers['ocr:recognize']([{ galleryId: g.id }], h.ctx)) as OcrRecognizeReply
    expect(reply.ok).toBe(true)
    expect(h.recognize).toHaveBeenCalledWith({ imagePath: g.item.originalPath })
  })

  it('unknown galleryId → gallery-item-not-found(パスはエンジんに渡さない)', async () => {
    const h = makeHarness()
    await expect(h.handlers['ocr:recognize']([{ galleryId: 'ghost' }], h.ctx)).resolves.toMatchObject({
      ok: false,
      error: 'gallery-item-not-found',
    })
    expect(h.recognize).not.toHaveBeenCalled()
  })

  it('zod: dataURL/g galleryId 両方・両方なし・画像以外の dataURL は invalid-payload', async () => {
    const h = makeHarness()
    const invalid = { ok: false, error: 'invalid-payload' }
    await expect(h.handlers['ocr:recognize']([{}], h.ctx)).resolves.toMatchObject(invalid)
    await expect(h.handlers['ocr:recognize']([{ dataURL: pngURL, galleryId: 'x' }], h.ctx)).resolves.toMatchObject(invalid)
    await expect(h.handlers['ocr:recognize']([{ dataURL: 'data:text/html;base64,PHNjcmlwdD4=' }], h.ctx)).resolves.toMatchObject(invalid)
    await expect(h.handlers['ocr:recognize']([{ imagePath: 'C:/Windows/x.png' }], h.ctx)).resolves.toMatchObject(invalid)
  })

  it('32 MiB を超える dataURL は image-too-large(デコード前後の両ゲート)', async () => {
    const h = makeHarness()
    const bigB64 = 'A'.repeat(Math.floor((OCR_IMAGE_MAX_BYTES + 1) / 3) * 4)
    const reply = (await h.handlers['ocr:recognize']([{ dataURL: `data:image/png;base64,${bigB64}` }], h.ctx)) as OcrRecognizeReply
    expect(reply.ok).toBe(false)
    if (reply.ok === false) expect(reply.error).toBe('image-too-large')
    expect(h.recognize).not.toHaveBeenCalled()
  })

  it('エンジン系エラーのコードマッピング: missing / tampered / generic', async () => {
    const mk = (msg: string) =>
      makeHarness({
        service: {
          recognize: vi.fn(async (): Promise<string> => {
            throw new Error(msg)
          }) as unknown as OcrService['recognize'],
        },
      })
    await expect(mk('ocr engine binary not found — install it in Settings → OCR').handlers['ocr:recognize']([{ dataURL: pngURL }], { send: vi.fn() } as never))
      .resolves.toMatchObject({ ok: false, error: 'engine-missing' })
    await expect(mk('ocr engine failed pinned sha256 verification (x)').handlers['ocr:recognize']([{ dataURL: pngURL }], { send: vi.fn() } as never))
      .resolves.toMatchObject({ ok: false, error: 'engine-tampered' })
    await expect(mk('PaddleOCR-json error 202: File does not exist.').handlers['ocr:recognize']([{ dataURL: pngURL }], { send: vi.fn() } as never))
      .resolves.toMatchObject({ ok: false, error: 'recognize-failed' })
  })

  it('非サポートプラットフォームは認識前に engine-unsupported-platform', async () => {
    const h = makeHarness({ service: { status: (() => ({ engine: { bin: null, source: 'none', version: null }, running: false, supported: false })) as OcrService['status'] } })
    await expect(h.handlers['ocr:recognize']([{ dataURL: pngURL }], h.ctx)).resolves.toMatchObject({
      ok: false,
      error: 'engine-unsupported-platform',
    })
  })
})

describe('ocr:install (ack + ocr:progress)', () => {
  it('正常時: ack → downloading→…→done イベント; engine は pack になり status 再取得可', async () => {
    const h = makeHarness({ engineSource: 'none' })
    const reply = (await h.handlers['ocr:install']([{}], h.ctx)) as OcrInstallReply
    expect(reply).toEqual({ ok: true })
    await vi.waitFor(() => {
      const states = h.send.mock.calls.map((c) => (c[1] as OcrProgressEvent).state)
      expect(states).toContain('done')
    })
    const events = h.send.mock.calls.map((c) => c[1] as OcrProgressEvent)
    expect(events[0].state).toBe('downloading')
    expect(events.some((e) => e.state === 'verifying')).toBe(true)
  })

  it('sha256-mismatch 結果 → quarantined + 隔離ノート', async () => {
    const h = makeHarness({
      engineSource: 'none',
      service: { install: vi.fn(async () => ({ ok: false, reason: 'sha256-mismatch' })) as unknown as OcrService['install'] },
    })
    await h.handlers['ocr:install']([{}], h.ctx)
    await vi.waitFor(() => {
      const evs = h.send.mock.calls.map((c) => c[1] as OcrProgressEvent)
      expect(evs.some((e) => e.state === 'quarantined' && /隔离/.test(e.note ?? ''))).toBe(true)
    })
  })

  it('インストール済み pack → already-installed(稼働パックを潰さない)', async () => {
    const h = makeHarness({ engineSource: 'none' })
    const ack = (await h.handlers['ocr:install']([{}], h.ctx)) as OcrInstallReply
    expect(ack).toEqual({ ok: true })
    await vi.waitFor(() => {
      expect(h.send).toHaveBeenCalled()
    })
    // install 完了 = pack 相当に状態を絞る(status fake は可変 engine を参照)
    h.engine.source = 'pack'
    h.engine.bin = 'D:\\engines\\ocr-cpu\\PaddleOCR-json.exe'
    const reply2 = (await h.handlers['ocr:install']([{}], h.ctx)) as OcrInstallReply
    expect(reply2).toEqual({ ok: false, error: 'already-installed' })
  })

  it('非サポート → engine-unsupported-platform(ダウンロード発生なし)', async () => {
    const h = makeHarness({
      service: {
        status: (() => ({ engine: { bin: null, source: 'none', version: null }, running: false, supported: false })) as OcrService['status'],
      },
    })
    await expect(h.handlers['ocr:install']([{}], h.ctx)).resolves.toEqual({ ok: false, error: 'engine-unsupported-platform' })
    expect(h.install).not.toHaveBeenCalled()
  })

  it('並発キックは already-downloading', async () => {
    let release: (v: { ok: boolean }) => void = () => undefined
    const h = makeHarness({
      engineSource: 'none',
      service: {
        install: vi.fn(
          () =>
            new Promise<{ ok: boolean }>((res) => {
              release = res
            }),
        ) as unknown as OcrService['install'],
      },
    })
    await expect(h.handlers['ocr:install']([{}], h.ctx)).resolves.toEqual({ ok: true })
    await expect(h.handlers['ocr:install']([{}], h.ctx)).resolves.toEqual({ ok: false, error: 'already-downloading' })
    release({ ok: true })
    await vi.waitFor(() => {
      const evs = h.send.mock.calls.map((c) => c[1] as OcrProgressEvent)
      expect(evs.some((e) => e.state === 'done')).toBe(true)
    })
  })

  it('strict ゲート', async () => {
    const h = makeHarness()
    await expect(h.handlers['ocr:install']([{ junk: 1 }], h.ctx)).resolves.toMatchObject({ ok: false, error: 'invalid-payload' })
  })
})

describe('dataUrlToBase64', () => {
  it('dataURL 先頭を除去、素の base64 はそのまま', () => {
    expect(dataUrlToBase64(pngURL)).toBe(PNG_B64)
    expect(dataUrlToBase64(PNG_B64)).toBe(PNG_B64)
  })
})
