import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { ModelRegistry, detectQuant, detectArch, detectFormat, isModelFile, getModelsJsonPath } from './registry'

// 工具：写入一个最小合法 GGUF（magic GGUF + 补足 2KB 避免 <1KB 探针误判）
function writeGguf(filePath: string, size = 2048, quantSuffix = ''): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const buf = Buffer.alloc(size, 0)
  buf.write('GGUF', 0, 'utf-8')
  // 若需要让文件头后续可扩展，这里不动
  writeFileSync(filePath, buf)
  void quantSuffix
}

function writeSafetensors(filePath: string, size = 2048): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // safetensors 最小头：8 字节 JSON length + JSON
  const header = Buffer.from(JSON.stringify({ __metadata__: {} }), 'utf-8')
  const lenBuf = Buffer.alloc(8)
  lenBuf.writeBigUInt64LE(BigInt(header.length), 0)
  const total = Buffer.concat([lenBuf, header])
  const pad = Buffer.alloc(Math.max(0, size - total.length), 0)
  writeFileSync(filePath, Buffer.concat([total, pad]))
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-models-'))
})

afterEach(async () => {
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe('registry — detect helpers', () => {
  it('detectQuant: 命中 Q4_K_M / Q8_0 / F16 / unknown', () => {
    expect(detectQuant('qwen2-7b-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(detectQuant('llama-8b-Q8_0.gguf')).toBe('Q8_0')
    expect(detectQuant('model-F16.gguf')).toBe('F16')
    expect(detectQuant('bf16-model.safetensors')).toBe('BF16')
    expect(detectQuant('noquant.gguf')).toBe('UNKNOWN')
  })

  it('detectArch: qwen/llama/mistral/unknown', () => {
    expect(detectArch('qwen2-7b-Q4_K_M.gguf')).toBe('qwen2')
    expect(detectArch('Qwen3-4B-Q8_0.gguf')).toBe('qwen3')
    expect(detectArch('llama-3-8b-F16.gguf')).toBe('llama')
    expect(detectArch('mistral-7b-v0.1-Q4_0.gguf')).toBe('mistral')
    expect(detectArch('bge-m3.safetensors')).toBe('bge')
    expect(detectArch('random.bin')).toBe('unknown')
  })

  it('detectFormat / isModelFile / getModelsJsonPath', () => {
    expect(detectFormat('a.gguf')).toBe('gguf')
    expect(detectFormat('a.safetensors')).toBe('safetensors')
    expect(detectFormat('a.onnx')).toBe('onnx')
    expect(detectFormat('a.bin')).toBe('bin')
    expect(detectFormat('a.txt')).toBe('unknown')
    expect(isModelFile('a.gguf')).toBe(true)
    expect(isModelFile('a.txt')).toBe(false)
    expect(getModelsJsonPath('/tmp/models')).toBe(join('/tmp/models', 'models.json'))
    expect(getModelsJsonPath('/tmp/models', 'custom.json')).toBe(join('/tmp/models', 'custom.json'))
  })
})

describe('registry — scan / models.json / 隔离', () => {
  it('scan 空目录 -> [] 且写入 models.json=[]', () => {
    const reg = new ModelRegistry(tmpDir)
    const models = reg.scan()
    expect(models).toEqual([])
    expect(existsSync(getModelsJsonPath(tmpDir))).toBe(true)
    expect(JSON.parse(readFileSync(getModelsJsonPath(tmpDir), 'utf-8'))).toEqual([])
  })

  it('拖入 GGUF 自动识别 quant/arch/size 并写入 models.json', () => {
    const ggufPath = join(tmpDir, 'qwen2-7b-instruct-Q4_K_M.gguf')
    writeGguf(ggufPath, 4096)
    const reg = new ModelRegistry(tmpDir)
    const models = reg.scan()
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('qwen2-7b-instruct-Q4_K_M')
    expect(models[0].quant).toBe('Q4_K_M')
    expect(models[0].arch).toBe('qwen2')
    expect(models[0].format).toBe('gguf')
    expect(models[0].size).toBe(4096)
    expect(models[0].file).toBe('qwen2-7b-instruct-Q4_K_M.gguf')

    const persisted = JSON.parse(readFileSync(getModelsJsonPath(tmpDir), 'utf-8')) as typeof models
    expect(persisted).toHaveLength(1)
    expect(persisted[0].quant).toBe('Q4_K_M')
    expect(persisted[0].arch).toBe('qwen2')
  })

  it('子目录模型同样识别 file 为 POSIX 相对路径', () => {
    writeGguf(join(tmpDir, 'llm', 'qwen3-4b-instruct', 'model-Q8_0.gguf'), 3000)
    const reg = new ModelRegistry(tmpDir)
    const models = reg.scan()
    expect(models).toHaveLength(1)
    expect(models[0].file).toBe('llm/qwen3-4b-instruct/model-Q8_0.gguf')
    expect(models[0].quant).toBe('Q8_0')
    expect(models[0].arch).toBe('qwen3')
  })

  it('拖入 safetensors 自动识别', () => {
    writeSafetensors(join(tmpDir, 'bge-m3.safetensors'), 3000)
    const reg = new ModelRegistry(tmpDir)
    const models = reg.scan()
    expect(models).toHaveLength(1)
    expect(models[0].format).toBe('safetensors')
    expect(models[0].arch).toBe('bge')
    expect(models[0].file).toBe('bge-m3.safetensors')
  })

  it('损坏文件隔离：0 字节伪 GGUF 不崩且不入 models.json', () => {
    // 正常文件
    writeGguf(join(tmpDir, 'good-Q4_K_M.gguf'), 4096)
    // 损坏：0 字节 / 无 GGUF magic 的小文件
    writeFileSync(join(tmpDir, 'bad-Q4_K_M.gguf'), Buffer.alloc(10, 0x41))
    writeFileSync(join(tmpDir, 'also-bad.gguf'), Buffer.alloc(0))
    // 非模型文件应被忽略，不算损坏
    writeFileSync(join(tmpDir, 'readme.txt'), 'hello')

    const reg = new ModelRegistry(tmpDir)
    const models = reg.scan()
    // 仅 good 入表，损坏被隔离，不抛错
    expect(models).toHaveLength(1)
    expect(models[0].file).toBe('good-Q4_K_M.gguf')
    const persisted = JSON.parse(readFileSync(getModelsJsonPath(tmpDir), 'utf-8')) as unknown[]
    expect(persisted).toHaveLength(1)
  })

  it('损坏的 models.json 隔离：readPersisted 返回 [] 且下次 scan 重建', () => {
    const reg = new ModelRegistry(tmpDir)
    reg.scan()
    // 人为损坏 models.json
    writeFileSync(getModelsJsonPath(tmpDir), '{ broken json', 'utf-8')
    expect(reg.readPersisted()).toEqual([])
    // 再拖入新模型应重建
    writeGguf(join(tmpDir, 'llama-3-8b-Q4_0.gguf'), 2048)
    const models = reg.scan()
    expect(models).toHaveLength(1)
    // 重建后 models.json 变为合法 JSON
    expect(() => JSON.parse(readFileSync(getModelsJsonPath(tmpDir), 'utf-8'))).not.toThrow()
  })

  it('删除文件后 scan 反映 unlink，models.json 同步更新', () => {
    const p = join(tmpDir, 'qwen2-Q4_K_M.gguf')
    writeGguf(p, 2048)
    const reg = new ModelRegistry(tmpDir)
    expect(reg.scan()).toHaveLength(1)
    rmSync(p)
    expect(reg.scan()).toHaveLength(0)
    expect(JSON.parse(readFileSync(getModelsJsonPath(tmpDir), 'utf-8'))).toEqual([])
  })

  it('stat 失败隔离：单文件 stat 抛错不影响其他', () => {
    writeGguf(join(tmpDir, 'good.gguf'), 2048)
    writeGguf(join(tmpDir, 'will-fail.gguf'), 2048)
    const origStat = statSync
    const fakeFs = {
      existsSync,
      mkdirSync,
      readdirSync: (dir: string, opts?: unknown) => {
        // delegate to real fs
        const fs = require('fs') as typeof import('fs')
        return opts ? (fs.readdirSync as unknown as (d: string, o: unknown) => unknown)(dir, opts) : fs.readdirSync(dir)
      },
      readFileSync,
      writeFileSync,
      renameSync: (a: string, b: string) => require('fs').renameSync(a, b),
      statSync: ((p: string) => {
        if (p.endsWith('will-fail.gguf')) throw new Error('EACCES mock')
        return origStat(p)
      }) as unknown as typeof statSync,
    }
    const reg = new ModelRegistry(tmpDir, { fsDeps: fakeFs as unknown as never, logger: { warn() {}, error() {}, log() {} } })
    const models = reg.scan()
    expect(models).toHaveLength(1)
    expect(models[0].file).toBe('good.gguf')
  })

  it('onUpdate 监听与 scheduleScan 去抖（注入 watcher）', async () => {
    // 注入 fake watcher，手动触发 add/change
    let addCb: (() => void) | null = null
    const fakeFactory = (_dir: string, _opts: unknown) => {
      return {
        on(ev: string, cb: (..._a: unknown[]) => void) {
          if (ev === 'add') addCb = cb as () => void
          if (ev === 'error') {} // ignore
          return this
        },
        close: async () => {},
      }
    }
    const reg = new ModelRegistry(tmpDir, { watcherFactory: fakeFactory as unknown as never, logger: { warn() {}, error() {}, log() {} } })
    const updates: number[] = []
    reg.onUpdate((ms) => updates.push(ms.length))
    await reg.startWatch()
    // 初始 scan 空 -> 触发一次
    expect(updates[0]).toBe(0)
    // 模拟外部拖入：先落盘，再触发 watcher add
    writeGguf(join(tmpDir, 'mistral-7b-Q4_K_M.gguf'), 2048)
    expect(addCb).not.toBeNull()
    addCb!()
    // debounce 120ms，等待
    await new Promise((r) => setTimeout(r, 250))
    expect(updates[updates.length - 1]).toBe(1)
    // 监听取消
    const off = reg.onUpdate(() => {
      throw new Error('should be removed')
    })
    off()
    // 再触发一次不应抛（被隔离）
    writeGguf(join(tmpDir, 'another-Q4_0.gguf'), 2048)
    addCb!()
    await new Promise((r) => setTimeout(r, 250))
    expect(reg.getModels()).toHaveLength(2)
    await reg.close()
  })

  it('models.json 原子写入：tmp -> rename', () => {
    writeGguf(join(tmpDir, 'qwen2-Q4_K_M.gguf'), 2048)
    const reg = new ModelRegistry(tmpDir)
    reg.scan()
    expect(existsSync(join(tmpDir, 'models.json.tmp'))).toBe(false)
    expect(existsSync(getModelsJsonPath(tmpDir))).toBe(true)
  })

  it('非模型文件（txt/exe）不入注册表', () => {
    writeFileSync(join(tmpDir, 'evil.exe'), Buffer.alloc(2048, 0))
    writeFileSync(join(tmpDir, 'notes.txt'), 'hi')
    writeGguf(join(tmpDir, 'ok.gguf'), 2048)
    const reg = new ModelRegistry(tmpDir)
    const models = reg.scan()
    expect(models).toHaveLength(1)
    expect(models[0].file).toBe('ok.gguf')
  })
})
