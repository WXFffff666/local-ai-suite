/**
 * todo19 — LoRA fs layer tests: safetensors header parser (synthetic bytes,
 * incl. big-endian-invalid and >10MB declared headers), modelsDir path
 * containment (QA-fail '../../x.safetensors'), and the two IPC channels
 * against a stub registry with real temp files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  LORA_HEADER_MAX_BYTES,
  assertInsideModelsDir,
  formatLoraSize,
  isLoraEntry,
  parseSafetensorsHeader,
  readLoraMetaFile,
  toLoraFiles,
  LoraPathError
} from './loraFs'
import { buildIpcHandlers, type HandlerContext, type ServicesSurface } from './handlers'
import type { ModelEntry } from '../../models/registry'
import type { LoraMetaReply, LoraScanReply } from './whitelist'

// --- synthetic safetensors bytes ---------------------------------------------

/** [8B u64-LE len][JSON header][pad] — header always ≥ 16B by construction. */
function safetensorsBytes(metadata?: Record<string, unknown>, extraTensors = true): Buffer {
  const header: Record<string, unknown> = extraTensors
    ? { 'lora.unet.blocks.0': { dtype: 'F16', shape: [32, 4], data_offsets: [0, 256] } }
    : {}
  if (metadata) header['__metadata__'] = metadata
  const json = Buffer.from(JSON.stringify(header), 'utf-8')
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([len, json, Buffer.alloc(256)])
}

const KOHYA_META = {
  ss_tag_string: 'marbled, abstract, art',
  ss_network_dim: '32',
  ss_network_alpha: '16',
  ss_sd_model_name: 'sd_xl_base_1.0',
  encryption: 'aes-256-evil-key-material', // must be filtered out
  unrelated_note: 'x'.repeat(4000) // must be filtered out
}

describe('parseSafetensorsHeader (synthetic bytes)', () => {
  it('合法头 → 仅返回 ss_/*lora*/modelspec. 过滤后的 __metadata__', () => {
    const res = parseSafetensorsHeader(safetensorsBytes(KOHYA_META))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.meta).toEqual({
      ss_tag_string: 'marbled, abstract, art',
      ss_network_dim: 32, // numeric strings coerce to number for compact display
      ss_network_alpha: 16,
      ss_sd_model_name: 'sd_xl_base_1.0'
    })
  })

  it('无 __metadata__ 的合法头 → ok + 空 meta（文件仍可用）', () => {
    const res = parseSafetensorsHeader(safetensorsBytes())
    expect(res).toEqual({ ok: true, meta: {} })
  })

  it('输入不足 8 字节 → bad-header', () => {
    expect(parseSafetensorsHeader(Buffer.alloc(7))).toEqual({ ok: false, error: 'bad-header' })
  })

  it('声明长度 <16（垃圾文件）→ bad-header', () => {
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(4n)
    expect(parseSafetensorsHeader(Buffer.concat([len, Buffer.from('{"a":1}')]))).toEqual({
      ok: false,
      error: 'bad-header'
    })
  })

  it('大端序误写的长度（LE 读出 2^32）→ header-too-large 防护', () => {
    const len = Buffer.alloc(8)
    len.writeUInt32BE(1, 4) // BE-1 == LE 0x1_00000000 == 4 GiB
    expect(parseSafetensorsHeader(Buffer.concat([len, Buffer.alloc(64)]))).toEqual({
      ok: false,
      error: 'header-too-large'
    })
  })

  it('声明长度 >10MB 上限 → header-too-large（QA 超大头防护）', () => {
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(LORA_HEADER_MAX_BYTES + 1))
    expect(parseSafetensorsHeader(Buffer.concat([len, Buffer.alloc(64)]))).toEqual({
      ok: false,
      error: 'header-too-large'
    })
  })

  it('声明长度未截断（declared > present bytes）→ bad-header', () => {
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(200n) // claims 200 header bytes…
    expect(parseSafetensorsHeader(Buffer.concat([len, Buffer.alloc(50)]))).toEqual({
      ok: false,
      error: 'bad-header'
    }) // …only 50 present
  })

  it('头 JSON 语法损坏 / 顶层非对象 → bad-header', () => {
    const json = Buffer.from('{not json,,', 'utf-8')
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(json.length))
    expect(parseSafetensorsHeader(Buffer.concat([len, json]))).toEqual({ ok: false, error: 'bad-header' })
    const arr = Buffer.from('[1,2,3,4,5,6,7,8,9,10,11,12]', 'utf-8')
    len.writeBigUInt64LE(BigInt(arr.length))
    expect(parseSafetensorsHeader(Buffer.concat([len, arr]))).toEqual({ ok: false, error: 'bad-header' })
  })

  it('modelspec.* 架构键保留', () => {
    const res = parseSafetensorsHeader(safetensorsBytes({ 'modelspec.architecture': 'sdxl-v1-euler' }))
    expect(res.ok && res.meta['modelspec.architecture']).toBe('sdxl-v1-euler')
  })
})

describe('assertInsideModelsDir（gallery 包含校验同型）', () => {
  let root = ''
  let modelsDir = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'las-lora-'))
    modelsDir = join(root, 'models')
    mkdirSync(join(modelsDir, 'diffusion', 'lora'), { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('目录内文件通过；大小写不同的盘符/目录名同样通过', () => {
    expect(() => assertInsideModelsDir(join(modelsDir, 'diffusion/lora/a.safetensors'), modelsDir)).not.toThrow()
    const upper = `${modelsDir.slice(0, 1).toUpperCase()}${modelsDir.slice(1)}`
    expect(() => assertInsideModelsDir(join(upper, 'diffusion', 'x'), modelsDir.toLowerCase())).not.toThrow()
  })

  it('逃逸一律拒绝：../../、兄弟前缀目录、modelsDir 本身、绝对他路径', () => {
    expect(() => assertInsideModelsDir(join(modelsDir, '../../x.safetensors'), modelsDir)).toThrow(LoraPathError)
    expect(() => assertInsideModelsDir(join(`${modelsDir}-evil`, 'x.safetensors'), modelsDir)).toThrow(LoraPathError)
    expect(() => assertInsideModelsDir(modelsDir, modelsDir)).toThrow(LoraPathError)
    expect(() => assertInsideModelsDir(join(root, 'elsewhere.safetensors'), modelsDir)).toThrow(LoraPathError)
    try {
      assertInsideModelsDir('../../x.safetensors', modelsDir)
      expect.unreachable('must throw')
    } catch (e) {
      expect((e as LoraPathError).code).toBe('path-outside-models-dir')
    }
  })
})

describe('readLoraMetaFile（真实临时文件，containment 先行）', () => {
  let root = ''
  let modelsDir = ''
  const loraDir = () => join(modelsDir, 'diffusion', 'lora')
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'las-lorafile-'))
    modelsDir = join(root, 'models')
    mkdirSync(loraDir(), { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('目录内合法 safetensors → 过滤后的 meta', () => {
    const p = join(loraDir(), 'marblesh.safetensors')
    writeFileSync(p, safetensorsBytes(KOHYA_META))
    const res = readLoraMetaFile(p, modelsDir)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.meta['ss_tag_string']).toBe('marbled, abstract, art')
  })

  it('QA-fail：../../x.safetensors 逃逸路径被拒且不触盘', () => {
    const res = readLoraMetaFile(join(modelsDir, '..', '..', 'x.safetensors'), modelsDir)
    expect(res).toEqual({ ok: false, error: 'path-outside-models-dir' })
  })

  it('QA-fail：声明超大头（>10MB）的文件被拒（仅读前 8 字节即止损）', () => {
    const p = join(loraDir(), 'huge.safetensors')
    const len = Buffer.alloc(8)
    len.writeBigUInt64LE(BigInt(LORA_HEADER_MAX_BYTES + 1024))
    writeFileSync(p, Buffer.concat([len, Buffer.alloc(64)]))
    expect(readLoraMetaFile(p, modelsDir)).toEqual({ ok: false, error: 'header-too-large' })
  })

  it('非 safetensors（gguf lora）→ meta-unsupported；缺失文件 → file-not-found', () => {
    expect(readLoraMetaFile(join(loraDir(), 'a.gguf'), modelsDir)).toEqual({ ok: false, error: 'meta-unsupported' })
    expect(readLoraMetaFile(join(loraDir(), 'ghost.safetensors'), modelsDir)).toEqual({ ok: false, error: 'file-not-found' })
  })
})

describe('isLoraEntry / toLoraFiles / formatLoraSize', () => {
  it('diffusion/lora(s) 子目录全收；diffusion 根仅收名字含 lora 的直文件', () => {
    expect(isLoraEntry('diffusion/lora/marblesh.safetensors')).toBe(true)
    expect(isLoraEntry('diffusion/loras/extra/深层.safetensors')).toBe(true)
    expect(isLoraEntry('diffusion/my-lora-weapons.safetensors')).toBe(true)
    expect(isLoraEntry('diffusion/sdxl-base-1.0.safetensors')).toBe(false)
    expect(isLoraEntry('llm/qwen3.gguf')).toBe(false)
  })

  it('toLoraFiles 剔除损坏项与非权重格式，按 file 排序并给出 sizeLabel', () => {
    const entry = (file: string, over: Partial<ModelEntry> = {}): ModelEntry => ({
      name: file.split('/').pop()!.replace(/\.[^.]+$/, ''),
      file,
      path: `X:\\models\\${file.replace(/\//g, '\\')}`,
      size: 142_000_000,
      quant: 'UNKNOWN',
      arch: 'unknown',
      format: file.endsWith('.gguf') ? 'gguf' : 'safetensors',
      mtimeMs: 0,
      ...over
    })
    const files = toLoraFiles([
      entry('diffusion/lora/z-lora.gguf'),
      entry('diffusion/lora/a-lora.safetensors'),
      entry('diffusion/lora/bad.safetensors', { corrupted: true }),
      entry('diffusion/sdxl.safetensors'),
      entry('llm/x.gguf')
    ])
    expect(files.map((f) => f.file)).toEqual(['diffusion/lora/a-lora.safetensors', 'diffusion/lora/z-lora.gguf'])
    expect(files[0]).toMatchObject({ name: 'a-lora', sizeLabel: '135.4 MB', format: 'safetensors' })
  })

  it('formatLoraSize 边界', () => {
    expect(formatLoraSize(999)).toBe('999 B')
    expect(formatLoraSize(1024)).toBe('1.0 KB')
    expect(formatLoraSize(Number.NaN)).toBe('—')
  })
})

// --- IPC channels ------------------------------------------------------------

function entry(file: string, size = 20_000_000): ModelEntry {
  return {
    name: file.split('/').pop()!.replace(/\.[^.]+$/, ''),
    file,
    path: join(modelsFixture.dir, ...file.split('/')),
    size,
    quant: 'UNKNOWN',
    arch: 'unknown',
    format: 'safetensors',
    mtimeMs: 0
  }
}

const modelsFixture: { dir: string } = { dir: 'X:\\models' }

function harness(registry: { getModels: () => ModelEntry[]; reloadModels: () => ModelEntry[]; modelsDir: string }) {
  const deps = {
    services: { registry } as unknown as ServicesSurface,
    relay: { start: vi.fn(), abort: vi.fn() },
    downloads: { start: vi.fn(), cancel: vi.fn() },
    hfSearch: vi.fn(async () => []),
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
    safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() }
  }
  const handlers = buildIpcHandlers(deps)
  const ctx: HandlerContext = { send: vi.fn() }
  return { handlers, ctx }
}

describe('models:loraScan / models:loraMeta channels', () => {
  let root = ''
  let modelsDir = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'las-lorachan-'))
    modelsDir = join(root, 'models')
    mkdirSync(join(modelsDir, 'diffusion', 'lora'), { recursive: true })
    modelsFixture.dir = modelsDir
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('scan 投影 registry 条目；payload 严格 {}（多余键 → 400-shape）', async () => {
    const { handlers, ctx } = harness({ getModels: () => [entry('diffusion/lora/marblesh.safetensors')], reloadModels: () => [], modelsDir })
    const scan = (await handlers['models:loraScan']([{}], ctx)) as LoraScanReply
    expect(scan).toMatchObject({ ok: true, files: [{ name: 'marblesh', format: 'safetensors' }] })
    const bad = await handlers['models:loraScan']([{ evil: 1 }], ctx)
    expect(bad).toMatchObject({ ok: false, error: 'invalid-payload' })
  })

  it('meta：逃逸路径经通道仍被拒（不依赖 zod）', async () => {
    const { handlers, ctx } = harness({ getModels: () => [], reloadModels: () => [], modelsDir })
    const res = (await handlers['models:loraMeta']([{ path: join(modelsDir, '..', '..', 'etc', 'x.safetensors') }], ctx)) as LoraMetaReply
    expect(res).toEqual({ ok: false, error: 'path-outside-models-dir' })
    const empty = await handlers['models:loraMeta']([{}], ctx)
    expect(empty).toMatchObject({ ok: false, error: 'invalid-payload' })
  })

  it('meta：合法文件回传过滤 meta；损坏头回传 bad-header（UI 显示 unknown 仍可选）', async () => {
    const p = join(modelsDir, 'diffusion', 'lora', 'marblesh.safetensors')
    writeFileSync(p, safetensorsBytes(KOHYA_META))
    const { handlers, ctx } = harness({ getModels: () => [entry('diffusion/lora/marblesh.safetensors')], reloadModels: () => [], modelsDir })
    const ok = (await handlers['models:loraMeta']([{ path: p }], ctx)) as LoraMetaReply
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.meta['ss_network_dim']).toBe(32)
    const junk = join(modelsDir, 'diffusion', 'lora', 'junk.safetensors')
    // 合法长度 + 非法 JSON 体 → bad-header（随机垃圾前 8 字节会被判为
    // header-too-large，同样拒读，此处钉死 JSON 损坏路径）
    const badLen = Buffer.alloc(8)
    badLen.writeBigUInt64LE(19n)
    writeFileSync(junk, Buffer.concat([badLen, Buffer.from('{definitely not json!', 'utf-8')]))
    const bad = (await handlers['models:loraMeta']([{ path: junk }], ctx)) as LoraMetaReply
    expect(bad).toEqual({ ok: false, error: 'bad-header' })
  })

  it('scan 结果的路径可原样喂给 meta（roundtrip，Windows 大小写折叠）', async () => {
    const p = join(modelsDir, 'diffusion', 'lora', 'rt.safetensors')
    writeFileSync(p, safetensorsBytes({ ss_network_dim: '8' }))
    const { handlers, ctx } = harness({ getModels: () => [entry('diffusion/lora/rt.safetensors')], reloadModels: () => [], modelsDir })
    const scan = (await handlers['models:loraScan']([{}], ctx)) as LoraScanReply
    if (!scan.ok) throw new Error('scan failed')
    const upper = scan.files[0].path.toUpperCase()
    const res = (await handlers['models:loraMeta']([{ path: upper }], ctx)) as LoraMetaReply
    expect(res.ok).toBe(true)
    expect(readFileSync(p).length).toBeGreaterThan(0) // fixture sanity only
  })
})
