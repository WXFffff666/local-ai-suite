import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join, relative, resolve } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import {
  save,
  list,
  copy,
  insert,
  reuse,
  getItem,
  remove,
  clear,
  getGalleryDir,
  getOriginalPath,
  getThumbPath,
  getMetaPath,
  toDataUrl,
  Gallery,
  GalleryError,
  saveToGallery,
  listGallery,
  copyGalleryItem,
  insertGalleryItem,
  reuseGalleryParams,
  GALLERY_DIR_NAME,
} from './gallery'

// 1x1 PNG b64 (minimal valid PNG)
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'
const TINY_PNG_DATAURL = `data:image/png;base64,${TINY_PNG_B64}`

function tempGallery(): string {
  const d = mkdtempSync(join(tmpdir(), 'las-gallery-'))
  const g = join(d, GALLERY_DIR_NAME)
  return g
}

describe('gallery — 落盘缩略图/原图/元数据 + 右键复制/插入/复用', () => {
  let galleryDir: string
  let tmpRoot: string

  beforeEach(() => {
    const g = tempGallery()
    galleryDir = g
    tmpRoot = join(g, '..')
    // galleryDir parent already exists via mkdtempSync; ensure gallery root parent exists
  })

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {}
  })

  it('save 写入 原图/thumb/meta 三文件', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'a cat', width: 512, height: 512, steps: 20, seed: 42, model: 'sdxl', baseDir: galleryDir })
    expect(item.id).toBeTruthy()
    expect(item.prompt).toBe('a cat')
    expect(existsSync(item.originalPath)).toBe(true)
    expect(existsSync(item.thumbPath)).toBe(true)
    expect(existsSync(item.metaPath)).toBe(true)
    // paths convention
    expect(item.originalPath).toContain('original.png')
    expect(item.thumbPath).toContain('thumb.png')
    expect(item.metaPath).toContain('meta.json')
    // meta content
    const meta = JSON.parse(readFileSync(item.metaPath, 'utf-8')) as Record<string, unknown>
    expect(meta['prompt']).toBe('a cat')
    expect(meta['seed']).toBe(42)
    expect(meta['model']).toBe('sdxl')
    // b64 round-trip
    const buf = readFileSync(item.originalPath)
    expect(buf.toString('base64')).toBe(TINY_PNG_B64)
    const thumbBuf = readFileSync(item.thumbPath)
    expect(thumbBuf.toString('base64')).toBe(TINY_PNG_B64)
  })

  it('save 兼容 data: 前缀', () => {
    const item = save({ b64: TINY_PNG_DATAURL, prompt: 'dog', baseDir: galleryDir })
    expect(existsSync(item.originalPath)).toBe(true)
    expect(readFileSync(item.originalPath).toString('base64')).toBe(TINY_PNG_B64)
  })

  it('save 校验 prompt/b64 必填', () => {
    expect(() => save({ b64: '', prompt: 'hi', baseDir: galleryDir })).toThrow(/b64/)
    expect(() => save({ b64: TINY_PNG_B64, prompt: '  ', baseDir: galleryDir })).toThrow(/prompt/)
  })

  it('list 返回倒序，空目录返回 []', () => {
    expect(list({ baseDir: galleryDir })).toEqual([])
    const a = save({ b64: TINY_PNG_B64, prompt: 'first', baseDir: galleryDir })
    // ensure time gap
    const b = save({ b64: TINY_PNG_B64, prompt: 'second', baseDir: galleryDir })
    const items = list({ baseDir: galleryDir })
    expect(items.length).toBe(2)
    // second is newer -> first in list
    expect(items[0]!.id).toBe(b.id)
    expect(items[1]!.id).toBe(a.id)
    // aliases
    expect(listGallery({ baseDir: galleryDir }).length).toBe(2)
  })

  it('getItem / copy 返回 b64 + path', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'copy me', seed: 7, baseDir: galleryDir })
    const fetched = getItem(item.id, galleryDir)
    expect(fetched.prompt).toBe('copy me')

    const payload = copy(item.id, galleryDir)
    expect(payload.b64).toBe(TINY_PNG_B64)
    expect(payload.mime).toBe('image/png')
    expect(payload.path).toContain('original.png')

    // copy 亦支持直接传对象
    const p2 = copy(item, galleryDir)
    expect(p2.b64).toBe(TINY_PNG_B64)

    // alias
    const p3 = copyGalleryItem(item.id, galleryDir)
    expect(p3.b64).toBe(TINY_PNG_B64)
  })

  it('copy 不存在抛错', () => {
    expect(() => copy('no-such-id', galleryDir)).toThrow(/not found/)
  })

  it('insert 返回 markdown 文本 + 回调', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'insert me', baseDir: galleryDir })
    const payload = insert(item.id, galleryDir)
    expect(payload.prompt).toBe('insert me')
    expect(payload.imagePath).toContain('original.png')
    expect(payload.b64).toBe(TINY_PNG_B64)
    expect(payload.text).toContain('insert me')
    expect(payload.text).toContain('![')

    // 传对象
    const p2 = insert(item, galleryDir)
    expect(p2.prompt).toBe('insert me')

    // 回调
    const fn = vi.fn()
    const p3 = insert(item.id, galleryDir, fn)
    expect(fn).toHaveBeenCalledOnce()
    expect(fn.mock.calls[0]![0].prompt).toBe('insert me')
    expect(p3.text).toBe(fn.mock.calls[0]![0].text)

    // alias
    const p4 = insertGalleryItem(item.id, galleryDir)
    expect(p4.b64).toBe(TINY_PNG_B64)
  })

  it('insert 支持 (item, callback) 重载', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'cb overload', baseDir: galleryDir })
    const fn = vi.fn()
    const payload = insert(item, fn)
    expect(fn).toHaveBeenCalledOnce()
    expect(payload.prompt).toBe('cb overload')
  })

  it('reuse 一键复用参数', () => {
    const item = save({
      b64: TINY_PNG_B64,
      prompt: 'reuse prompt',
      negative_prompt: 'bad',
      width: 768,
      height: 512,
      steps: 25,
      cfg_scale: 7.5,
      seed: 123,
      model: 'flux',
      sampler: 'euler',
      baseDir: galleryDir,
    })
    const params = reuse(item.id, galleryDir)
    expect(params.prompt).toBe('reuse prompt')
    expect(params.negative_prompt).toBe('bad')
    expect(params.width).toBe(768)
    expect(params.height).toBe(512)
    expect(params.steps).toBe(25)
    expect(params.cfg_scale).toBe(7.5)
    expect(params.seed).toBe(123)
    expect(params.model).toBe('flux')
    expect(params.sampler).toBe('euler')

    // 对象重载 + alias
    const p2 = reuse(item, galleryDir)
    expect(p2.prompt).toBe('reuse prompt')
    const p3 = reuseGalleryParams(item.id, galleryDir)
    expect(p3.model).toBe('flux')
  })

  it('remove / clear', () => {
    const a = save({ b64: TINY_PNG_B64, prompt: 'a', baseDir: galleryDir })
    const b = save({ b64: TINY_PNG_B64, prompt: 'b', baseDir: galleryDir })
    expect(list({ baseDir: galleryDir }).length).toBe(2)
    expect(remove(a.id, galleryDir)).toBe(true)
    expect(list({ baseDir: galleryDir }).length).toBe(1)
    expect(remove('nope', galleryDir)).toBe(false)
    const n = clear(galleryDir)
    expect(n).toBe(1)
    expect(list({ baseDir: galleryDir }).length).toBe(0)
    expect(clear(galleryDir)).toBe(0)
  })

  it('Gallery class 包装 save/list/copy/insert/reuse', () => {
    const g = new Gallery(galleryDir)
    const item = g.save({ b64: TINY_PNG_B64, prompt: 'class test', seed: 99 })
    expect(g.list().length).toBe(1)
    expect(g.get(item.id).prompt).toBe('class test')
    expect(g.copy(item.id).b64).toBe(TINY_PNG_B64)
    expect(g.insert(item.id).prompt).toBe('class test')
    expect(g.reuse(item.id).seed).toBe(99)
    expect(g.remove(item.id)).toBe(true)
    g.save({ b64: TINY_PNG_B64, prompt: 'x' })
    g.save({ b64: TINY_PNG_B64, prompt: 'y' })
    expect(g.clear()).toBe(2)
  })

  it('headers: saveToGallery alias 等价于 save', () => {
    const item = saveToGallery({ b64: TINY_PNG_B64, prompt: 'alias', baseDir: galleryDir })
    expect(existsSync(item.originalPath)).toBe(true)
  })

  it('toDataUrl / get*Path helpers', () => {
    expect(toDataUrl(TINY_PNG_B64)).toBe(TINY_PNG_DATAURL)
    expect(toDataUrl(TINY_PNG_DATAURL)).toBe(TINY_PNG_DATAURL)
    const id = 'test-id'
    expect(getGalleryDir(galleryDir)).toContain(GALLERY_DIR_NAME)
    expect(getOriginalPath(id, galleryDir)).toContain('original.png')
    expect(getThumbPath(id, galleryDir)).toContain('thumb.png')
    expect(getMetaPath(id, galleryDir)).toContain('meta.json')
  })

  it('list 跳过损坏 meta', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'good', baseDir: galleryDir })
    // 手动制造坏目录
    const badDir = join(galleryDir, 'bad-item')
    mkdirSync(badDir, { recursive: true })
    // 无 meta.json -> 被跳过
    expect(list({ baseDir: galleryDir }).length).toBe(1)
    // 写坏 json
    const corruptId = 'corrupt'
    const cDir = join(galleryDir, corruptId)
    mkdirSync(cDir, { recursive: true })
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(join(cDir, 'meta.json'), '{ not json', 'utf-8')
    expect(list({ baseDir: galleryDir }).length).toBe(1)
    expect(list({ baseDir: galleryDir })[0]!.id).toBe(item.id)
  })

  // -------------------------------------------------------------------------
  // task4 — 读路径 id 净化 + 目录包含校验
  // -------------------------------------------------------------------------

  it('task4: 穿越 id 被拒或被净化，绝不逃出 gallery 根目录', () => {
    const g = resolve(galleryDir)
    // '../../evil' 净化为 '.._.._evil' 后仍以 '..' 开头 → 包含校验直接拒绝（计划验收的抛错分支）
    expect(() => getOriginalPath('../../evil', galleryDir)).toThrow(GalleryError)
    expect(() => getThumbPath('..\\..\\windows\\system32', galleryDir)).toThrow(GalleryError)
    // 'a/b%2e%2e' 被完全净化折叠为根内普通目录名 a_b_2e_2e
    expect(resolve(getOriginalPath('a/b%2e%2e', galleryDir))).toBe(join(g, 'a_b_2e_2e', 'original.png'))
    expect(relative(g, resolve(getOriginalPath('a/b%2e%2e', galleryDir)))).toBe(join('a_b_2e_2e', 'original.png'))
    // 读动词同口径：拒绝而非逃出
    expect(() => copy('../../evil', galleryDir)).toThrow(GalleryError)
    expect(() => getItem('..\\..\\x', galleryDir)).toThrow(GalleryError)
  })

  it('task4: 净化后仍以 .. 开头的 id（字面 .. / . / 空串 / ..hidden）抛 GalleryError', () => {
    for (const bad of ['..', '.', '', '..hidden', '../..', '..\\..']) {
      expect(() => getMetaPath(bad, galleryDir)).toThrow(GalleryError)
      expect(() => getOriginalPath(bad, galleryDir)).toThrow(GalleryError)
      expect(() => getThumbPath(bad, galleryDir)).toThrow(GalleryError)
      expect(() => getItem(bad, galleryDir)).toThrow(GalleryError)
      expect(() => remove(bad, galleryDir)).toThrow(GalleryError)
    }
  })

  it('task4: remove 穿越 id 被拒且父目录与既有项毫发无损', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'precious', baseDir: galleryDir })
    expect(() => remove('..', galleryDir)).toThrow(GalleryError)
    expect(existsSync(item.originalPath)).toBe(true)
    expect(list({ baseDir: galleryDir }).length).toBe(1)
  })

  it('task4: save 以越界 id 落盘被拒，父目录零残留', () => {
    expect(() => save({ b64: TINY_PNG_B64, prompt: 'x', id: '..', baseDir: galleryDir })).toThrow(GalleryError)
    expect(() => save({ b64: TINY_PNG_B64, prompt: 'x', id: '../..', baseDir: galleryDir })).toThrow(GalleryError)
    expect(existsSync(join(resolve(galleryDir, '..'), 'original.png'))).toBe(false)
    expect(existsSync(join(resolve(galleryDir, '..'), 'meta.json'))).toBe(false)
  })

  it('task4: 对象入参携带被篡改 originalPath 时 copy/insert 抛 GalleryError', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'tamper target', baseDir: galleryDir })
    const outside = join(tmpRoot, 'outside-secret.png')
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(outside, 'secret-bytes', 'utf-8')
    const evil = { ...item, originalPath: outside }
    expect(() => copy(evil, galleryDir)).toThrow(GalleryError)
    expect(() => insert(evil, galleryDir)).toThrow(GalleryError)
    // 对象合法路径仍走通（回归保护）
    expect(copy(item, galleryDir).b64).toBe(TINY_PNG_B64)
  })

  it('task4: list 遇盘上异常目录名（..x 开头）跳过而非崩溃', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'survivor', baseDir: galleryDir })
    const weird = join(galleryDir, '..hidden-dir')
    mkdirSync(weird, { recursive: true })
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(join(weird, 'meta.json'), JSON.stringify({ id: '..hidden-dir', prompt: 'ghost', createdAt: 1 }), 'utf-8')
    const items = list({ baseDir: galleryDir })
    expect(items.length).toBe(1)
    expect(items[0]!.id).toBe(item.id)
  })

  it('task4: 合法 id 全动词往返不变', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'round trip', id: 'legit-id_1.2-3', baseDir: galleryDir })
    expect(item.id).toBe('legit-id_1.2-3')
    expect(getItem(item.id, galleryDir).prompt).toBe('round trip')
    expect(copy(item.id, galleryDir).b64).toBe(TINY_PNG_B64)
    expect(insert(item.id, galleryDir).prompt).toBe('round trip')
    expect(reuse(item.id, galleryDir).prompt).toBe('round trip')
    expect(remove(item.id, galleryDir)).toBe(true)
    expect(list({ baseDir: galleryDir }).length).toBe(0)
  })
})
