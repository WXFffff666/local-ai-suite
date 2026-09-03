/**
 * service.test.ts — OcrService の遅延契約と完全性ゲート (whisper service.test
 * の模倣): status() は spawn も download もしない; OCR_BIN env > installed
 * pack > none の優先順; pack tier は起動前に exe を PIN ハッシュで検証
 * (userData は書き込み可能なため fail-CLOSED — whisper の extraResources
 * tier とは逆); recognize は直列テールキュー; install は single-flight。
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OcrService } from './service'
import { ocrPackDir, ocrPackExePath } from './installer'
import { makeFakeStdio } from './paddleocr'
import { OCR_ASSET_SHA256, OCR_ARCHIVE_TOPDIR, OCR_ENGINE_KEY, OCR_EXE_FILE, OCR_EXE_SHA256, OCR_PACK_VARIANT } from './pins'

let tmp = ''

function freshUserData(): string {
  tmp = mkdtempSync(join(tmpdir(), 'las-ocr-svc-'))
  return join(tmp, 'userData')
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

/** 擬装インストールパック: exe + meta.json(PIN と同一 exeSha256) */
function installFakePack(uDir: string, exeSha = OCR_EXE_SHA256): string {
  const dir = ocrPackDir(uDir)
  mkdirSync(dir, { recursive: true })
  const exe = ocrPackExePath(dir)
  writeFileSync(exe, 'MZ-fake')
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({ engine: OCR_ENGINE_KEY, variant: OCR_PACK_VARIANT, exeSha256: exeSha, version: 'v1.4.1' }),
  )
  return exe
}

function readyFake() {
  const fake = makeFakeStdio()
  const spawnImpl = vi.fn(() => fake.child)
  const svc = new OcrService({
    userDataDir: freshUserData(),
    platform: 'win32',
    arch: 'x64',
    spawnImpl,
    shaFile: vi.fn(async () => OCR_EXE_SHA256),
  })
  return { svc, fake, spawnImpl }
}

describe('OcrService.status — 副作用ゼロの契約', () => {
  it('エンジンを起動せず、none tier を正しく報告する', () => {
    const { svc, spawnImpl } = readyFake()
    const st = svc.status()
    expect(st.engine).toEqual({ bin: null, source: 'none', version: null })
    expect(st.running).toBe(false)
    expect(st.supported).toBe(true)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('OCR_BIN env が pack より優先(source=env、sha ゲートなし)', () => {
    const uDir = freshUserData()
    installFakePack(uDir)
    const svc = new OcrService({ userDataDir: uDir, env: { OCR_BIN: 'D:\\custom\\PaddleOCR-json.exe' }, spawnImpl: vi.fn() })
    expect(svc.resolveEngine()).toEqual({ bin: 'D:\\custom\\PaddleOCR-json.exe', source: 'env', version: null })
  })

  it('pack tier: meta の version を報告', () => {
    const uDir = freshUserData()
    const exe = installFakePack(uDir)
    const svc = new OcrService({ userDataDir: uDir, spawnImpl: vi.fn() })
    expect(svc.resolveEngine()).toEqual({ bin: exe, source: 'pack', version: 'v1.4.1' })
  })

  it('非 win32-x64 は supported=false', () => {
    const svc = new OcrService({ userDataDir: freshUserData(), platform: 'linux', arch: 'x64', spawnImpl: vi.fn() })
    expect(svc.status().supported).toBe(false)
  })
})

describe('OcrService.recognize — ライフサイクルと完全性', () => {
  it('エンジン不在 → エンジナ未検出メッセージ(install 誘導)', async () => {
    const svc = new OcrService({ userDataDir: freshUserData(), spawnImpl: vi.fn() })
    await expect(svc.recognize({ imageBase64: 'QQ==' })).rejects.toThrow(/engine binary not found/)
  })

  it('pack tier: exe が PIN ハッシュ不一致 → spawn 前に拒否(fail-closed)', async () => {
    const uDir = freshUserData()
    installFakePack(uDir, 'a'.repeat(64)) // meta と実体の両方が偽の世帯主を指す
    const spawnImpl = vi.fn()
    const svc = new OcrService({
      userDataDir: uDir,
      spawnImpl,
      shaFile: vi.fn(async () => 'b'.repeat(64)), // _disk_ の実ハッシュ
    })
    await expect(svc.recognize({ imageBase64: 'QQ==' })).rejects.toThrow(/pinned sha256/)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('ハッピーパス: ハンドシェイク待ち → 1 in 1 out → テキスト', async () => {
    const uDir = freshUserData()
    installFakePack(uDir)
    const fake = makeFakeStdio()
    const svc = new OcrService({
      userDataDir: uDir,
      platform: 'win32',
      arch: 'x64',
      spawnImpl: () => fake.child,
      shaFile: vi.fn(async () => OCR_EXE_SHA256),
    })
    const p = svc.recognize({ imageBase64: 'iVBORw0KGgo=' })
    await new Promise((r) => setTimeout(r, 0))
    fake.pushStdout('PaddleOCR-json v1.4.1\nOCR init completed.\n')
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.stdinWrites.at(-1)).toBe('{"image_base64":"iVBORw0KGgo="}\n')
    fake.pushStdout('{"code":100,"data":[{"text":"你好","score":1,"box":[[0,0],[1,0],[1,1],[0,1]]}]}\n')
    await expect(p).resolves.toBe('你好')
    expect(svc.status().running).toBe(true)
    svc.stop()
    expect(svc.status().running).toBe(false)
  })

  it('直列テールキュー: 2 リクエストは逐次(in-flight は常に 1)', async () => {
    const uDir = freshUserData()
    installFakePack(uDir)
    const fake = makeFakeStdio()
    const svc = new OcrService({
      userDataDir: uDir,
      spawnImpl: () => fake.child,
      shaFile: vi.fn(async () => OCR_EXE_SHA256),
    })
    const a = svc.recognize({ imageBase64: 'QQ==' })
    const b = svc.recognize({ imageBase64: 'Ug==' })
    await new Promise((r) => setTimeout(r, 0))
    fake.pushStdout('PaddleOCR-json v1.4.1\nOCR init completed.\n')
    await new Promise((r) => setTimeout(r, 0))
    // b は a の解決前には書かれない
    expect(fake.stdinWrites.filter((w) => w.startsWith('{"image_base64"'))).toHaveLength(1)
    fake.pushStdout('{"code":100,"data":[{"text":"a","score":1,"box":[[0,0],[1,0],[1,1],[0,1]]}]}\n')
    expect(await a).toBe('a')
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.stdinWrites.filter((w) => w.startsWith('{"image_base64"'))).toHaveLength(2)
    fake.pushStdout('{"code":100,"data":[{"text":"b","score":1,"box":[[0,0],[1,0],[1,1],[0,1]]}]}\n')
    expect(await b).toBe('b')
  })
})

describe('OcrService.install — single-flight + seams', () => {
  function installable(over: Partial<ConstructorParameters<typeof OcrService>[0]> = {}) {
    const uDir = freshUserData()
    const downloader = vi.fn(async (_url: string, file: string, dir: string) => {
      const p = join(dir, file)
      writeFileSync(p, 'fake-7z')
      return p
    })
    const svc = new OcrService({
      userDataDir: uDir,
      platform: 'win32',
      arch: 'x64',
      spawnImpl: vi.fn(),
      // shaFile はアーカイブ検証に使われる → アーカイブの PIN を返す
      shaFile: vi.fn(async () => OCR_ASSET_SHA256),
      packDownloader: downloader,
      extract: async (_a: string, dest: string) => {
        const inner = join(dest, OCR_ARCHIVE_TOPDIR)
        mkdirSync(inner, { recursive: true })
        writeFileSync(join(inner, OCR_EXE_FILE), 'MZ-fake')
        return Promise.resolve()
      },
      ...over,
    })
    return { svc, uDir, downloader }
  }

  it('win32-x64: service.install → pack がインストールされ status が pack を見る', async () => {
    const { svc, uDir } = installable()
    const r = await svc.install()
    expect(r).toEqual({ ok: true })
    expect(existsSync(ocrPackExePath(ocrPackDir(uDir)))).toBe(true)
    expect(svc.resolveEngine().source).toBe('pack')
  })

  it('sha256 不一致 → ok:false + quarantined 理由、エンジンなし', async () => {
    const { svc, uDir } = installable({ shaFile: vi.fn(async () => 'e'.repeat(64)) })
    const r = await svc.install()
    expect(r).toEqual({ ok: false, reason: 'sha256-mismatch' })
    expect(svc.resolveEngine().source).toBe('none')
    expect(existsSync(ocrPackDir(uDir))).toBe(false)
  })

  it('並発 install は同一 promise を共有(single-flight)、完了後解除', async () => {
    const { svc } = installable()
    const p1 = svc.install()
    const p2 = svc.install()
    expect(p2).toBe(p1)
    await p1
    const p3 = svc.install()
    expect(p3).not.toBe(p1)
    // 2 回目のインストールは already pack に上書き(成功)
    expect((await p3).ok).toBe(true)
  })

  it('非 win32-x64 → engine-unsupported-platform(ネットワーク触碰なし)', async () => {
    const { svc, downloader } = installable({ platform: 'linux' })
    const p1 = svc.install()
    const p2 = svc.install()
    expect(p2).toBe(p1)
    expect(await p1).toEqual({ ok: false, reason: 'engine-unsupported-platform' })
    expect(downloader).not.toHaveBeenCalled()
  })
})
