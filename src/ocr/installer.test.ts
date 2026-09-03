/**
 * installer.test.ts — OCR エンジンパックの install/verify/activate フロー
 * (gpuPack.test のシーミング規約): ダウンロード → アーカイブ sha256 →
 * bsdtar 展開 → 原子的 activate → meta.json。sha 不一致は .quarantine に
 * 隔離し activate しない(エンジンディレクトリも active.json も作らない)。
 * 本物の exe は使わない: downloader/extract/shaFile すべて注入。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readActive } from '../engines/gpuPack'
import { installOcrEngine, ocrPackDir, ocrPackExePath, readOcrInstall, isSupportedTarget } from './installer'
import { OCR_ASSET_SHA256, OCR_ARCHIVE_TOPDIR, OCR_ENGINE_KEY, OCR_EXE_FILE, OCR_PACK_VARIANT } from './pins'

let tmp = ''

function userData(): string {
  tmp = mkdtempSync(join(tmpdir(), 'las-ocr-inst-'))
  return join(tmp, 'userData')
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = ''
})

/** 展開後ツリーを偽装: extract が topdir/PaddleOCR-json.exe + models/ を置く */
function fakeExtract(archive: string, dest: string): Promise<void> {
  void archive
  const inner = join(dest, OCR_ARCHIVE_TOPDIR)
  mkdirSync(join(inner, 'models'), { recursive: true })
  writeFileSync(join(inner, OCR_EXE_FILE), 'MZ-fake-exe')
  writeFileSync(join(inner, 'models', 'config_chinese.txt'), 'cfg')
  return Promise.resolve()
}

function makeDeps(over: Partial<Parameters<typeof installOcrEngine>[0]> = {}) {
  const uDir = userData()
  return {
    deps: {
      userDataDir: uDir,
      platform: 'win32' as const,
      arch: 'x64',
      downloader: vi.fn(async (_url: string, file: string, dir: string) => {
        const p = join(dir, file)
        writeFileSync(p, 'fake-7z-bytes')
        return p
      }),
      shaFile: vi.fn(async () => OCR_ASSET_SHA256),
      extract: vi.fn(fakeExtract),
      ...over,
    } as Parameters<typeof installOcrEngine>[0],
    uDir,
  }
}

describe('isSupportedTarget', () => {
  it('win32-x64 のみ true(計画のピンは windows x64 アセット)', () => {
    expect(isSupportedTarget('win32', 'x64')).toBe(true)
    expect(isSupportedTarget('win32', 'arm64')).toBe(false)
    expect(isSupportedTarget('linux', 'x64')).toBe(false)
  })
})

describe('installOcrEngine — happy path', () => {
  it('download→verify→extract→activate: pack dir + meta.json + active.json', async () => {
    const { deps, uDir } = makeDeps()
    const r = await installOcrEngine(deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = ocrPackDir(uDir)
    expect(r.dir).toBe(dir)
    expect(existsSync(ocrPackExePath(dir))).toBe(true)
    expect(existsSync(join(dir, 'models', 'config_chinese.txt'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'))
    expect(meta).toMatchObject({
      engine: OCR_ENGINE_KEY,
      variant: OCR_PACK_VARIANT,
      sha256: OCR_ASSET_SHA256,
      version: 'v1.4.1',
    })
    expect(typeof meta.exeSha256).toBe('string')
    expect(readActive(join(uDir, 'engines'))[OCR_ENGINE_KEY]).toBe(OCR_PACK_VARIANT)
    // staging は空になる(インストール残骸なし)
    expect(existsSync(join(uDir, 'engines', '.staging'))).toBe(false)
    const read = readOcrInstall(uDir)
    expect(read?.meta.version).toBe('v1.4.1')
    expect(read?.exe).toBe(ocrPackExePath(dir))
  })
})

describe('installOcrEngine — failure branches', () => {
  it('アーカイブ sha256 不一致 → quarantined、activate しない', async () => {
    const { deps, uDir } = makeDeps({ shaFile: vi.fn(async () => 'f'.repeat(64)) })
    const r = await installOcrEngine(deps)
    expect(r).toEqual({ ok: false, reason: 'sha256-mismatch' })
    expect(existsSync(ocrPackDir(uDir))).toBe(false)
    expect(readActive(join(uDir, 'engines'))[OCR_ENGINE_KEY]).toBeUndefined()
    // 隔離ツリーが存在(サイレント削除しない = gpuPack 方針同款)
    expect(existsSync(join(uDir, 'engines', '.quarantine'))).toBe(true)
    // extract は一度も呼ばれない(検証前に展開しない)
    expect(deps.extract).not.toHaveBeenCalled()
  })

  it('ダウンロード失敗 → quarantined + download-error 理由', async () => {
    const { deps, uDir } = makeDeps({
      downloader: vi.fn(async () => {
        throw new Error('net down')
      }),
    })
    const r = await installOcrEngine(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/^download-error:net down/)
    expect(existsSync(ocrPackDir(uDir))).toBe(false)
  })

  it('展開失敗 → extract-failed、部分パックを activate しない', async () => {
    const { deps, uDir } = makeDeps({
      extract: vi.fn(async () => {
        throw new Error('tar.exe missing')
      }),
    })
    const r = await installOcrEngine(deps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/^extract-failed/)
    expect(existsSync(ocrPackDir(uDir))).toBe(false)
  })

  it('展開先に exe なし → extract-missing-exe', async () => {
    const { deps } = makeDeps({
      extract: vi.fn(async (_a: string, dest: string) => {
        mkdirSync(join(dest, 'unexpected'), { recursive: true })
        return Promise.resolve()
      }),
    })
    const r = await installOcrEngine(deps)
    expect(r).toEqual({ ok: false, reason: 'extract-missing-exe' })
  })

  it('非 win32-x64 → engine-unsupported-platform(ネットワーク触碰なし)', async () => {
    const { deps, uDir } = makeDeps({ platform: 'linux', arch: 'x64' })
    const r = await installOcrEngine(deps)
    expect(r).toEqual({ ok: false, reason: 'engine-unsupported-platform' })
    expect(deps.downloader).not.toHaveBeenCalled()
    expect(existsSync(join(uDir, 'engines'))).toBe(false)
  })

  it('再インストールは既存パックを上書きスワップ(atomic rename)', async () => {
    const { deps, uDir } = makeDeps()
    await installOcrEngine(deps)
    const firstMeta = JSON.parse(readFileSync(join(ocrPackDir(uDir), 'meta.json'), 'utf-8'))
    // 同一 deps を再使用(downloader/extract は每回新しい一時ファイルを作る)
    const r = await installOcrEngine(deps)
    expect(r.ok).toBe(true)
    const meta = JSON.parse(readFileSync(join(ocrPackDir(uDir), 'meta.json'), 'utf-8'))
    expect(meta.activatedAt >= firstMeta.activatedAt).toBe(true)
    expect(existsSync(ocrPackExePath(ocrPackDir(uDir)))).toBe(true)
  })
})

describe('readOcrInstall — tamper honesty', () => {
  it('exe が無い / meta が壊れている / engine キー不一致 → null', async () => {
    const uDir = userData()
    expect(readOcrInstall(uDir)).toBeNull()
    const dir = ocrPackDir(uDir)
    mkdirSync(dir, { recursive: true })
    expect(readOcrInstall(uDir)).toBeNull() // meta なし
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ engine: 'llama', exeSha256: 'x' }))
    expect(readOcrInstall(uDir)).toBeNull() // engine 不一致
    writeFileSync(join(dir, 'meta.json'), '{broken')
    expect(readOcrInstall(uDir)).toBeNull()
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ engine: OCR_ENGINE_KEY, exeSha256: 'a'.repeat(64) }))
    expect(readOcrInstall(uDir)).toBeNull() // exe 実体なし
    writeFileSync(join(dir, OCR_EXE_FILE), 'MZ')
    expect(readOcrInstall(uDir)?.meta.exeSha256).toBe('a'.repeat(64))
  })
})
