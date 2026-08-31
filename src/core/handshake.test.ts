import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  HANDSHAKE_VERSION,
  SIDECARS_FILENAME,
  readSidecarsJson,
  writeSidecarsJson,
  type SidecarEntry,
} from './handshake'

let tmpRoot: string
let userData: string

const entries: SidecarEntry[] = [
  { name: 'llama', port: 20001, pid: 4242 },
  { name: 'ollama', port: 11434, pid: 5150 },
  { name: 'sd', port: 11436, pid: 6001 },
]

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'las-handshake-'))
  userData = path.join(tmpRoot, 'userData')
})

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // best-effort cleanup on Windows AV lock
  }
})

describe('handshake sidecars.json (schema v1)', () => {
  it('write → read 完整往返，字段逐一保真', () => {
    writeSidecarsJson(userData, entries)
    expect(readSidecarsJson(userData)).toEqual(entries)
  })

  it('落盘文件结构为 {version:1, entries:[...]} 且位于 userData/sidecars.json', () => {
    writeSidecarsJson(userData, entries)
    const raw = JSON.parse(fs.readFileSync(path.join(userData, SIDECARS_FILENAME), 'utf8')) as Record<string, unknown>
    expect(raw['version']).toBe(HANDSHAKE_VERSION)
    expect(raw['entries']).toEqual(entries)
  })

  it('原子覆盖写：重复 write 全量替换旧内容，且不留残 .tmp 文件', () => {
    writeSidecarsJson(userData, entries)
    const next: SidecarEntry[] = [{ name: 'llama', port: 20500, pid: 9999 }]
    writeSidecarsJson(userData, next)
    expect(readSidecarsJson(userData)).toEqual(next)
    const leftovers = fs.readdirSync(userData).filter((f) => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('自动创建不存在的 userData 目录层级', () => {
    const deep = path.join(tmpRoot, 'a', 'b', 'userData')
    writeSidecarsJson(deep, entries)
    expect(readSidecarsJson(deep)).toEqual(entries)
  })

  it('空 roster 合法：写入并读回空数组', () => {
    writeSidecarsJson(userData, [])
    expect(readSidecarsJson(userData)).toEqual([])
  })

  it('容忍缺失文件 → []', () => {
    const missing = path.join(tmpRoot, 'nope')
    expect(readSidecarsJson(missing)).toEqual([])
  })

  it('容忍损坏 JSON → []（不抛异常）', () => {
    const dir = path.join(tmpRoot, 'corrupt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SIDECARS_FILENAME), '{ not json !!', 'utf8')
    expect(readSidecarsJson(dir)).toEqual([])
  })

  it('容忍版本不匹配 / 非对象文档 → []', () => {
    const dir = path.join(tmpRoot, 'version')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, SIDECARS_FILENAME), JSON.stringify({ version: 2, entries }), 'utf8')
    expect(readSidecarsJson(dir)).toEqual([])
    fs.writeFileSync(path.join(dir, SIDECARS_FILENAME), JSON.stringify([1, 2, 3]), 'utf8')
    expect(readSidecarsJson(dir)).toEqual([])
    fs.writeFileSync(path.join(dir, SIDECARS_FILENAME), JSON.stringify({ version: 1, entries: 'nope' }), 'utf8')
    expect(readSidecarsJson(dir)).toEqual([])
  })

  it('逐条过滤畸形 entry，保留合法条目', () => {
    const dir = path.join(tmpRoot, 'partial')
    fs.mkdirSync(dir, { recursive: true })
    const doc = {
      version: 1,
      entries: [
        { name: 'llama', port: 20001, pid: 42 },
        { name: '', port: 20002, pid: 1 }, // 空名
        { name: 'x', port: 80, pid: 1 }, // 端口越界
        { name: 'y', port: 70000, pid: 1 }, // 端口越界
        { name: 'z', port: 12.5, pid: 1 }, // 非整数端口
        { name: 'w', port: 11436, pid: 0 }, // pid 非法
        { name: 'v', port: 11436 }, // 缺 pid
        'string-entry',
        null,
      ],
    }
    fs.writeFileSync(path.join(dir, SIDECARS_FILENAME), JSON.stringify(doc), 'utf8')
    expect(readSidecarsJson(dir)).toEqual([{ name: 'llama', port: 20001, pid: 42 }])
  })

  it('writeSidecarsJson 对畸形 entry 抛 TypeError（边界即校验）', () => {
    expect(() => writeSidecarsJson(userData, [{ name: 'ok', port: 20000, pid: 1 }, { name: 'bad', port: 999_999, pid: 2 }])).toThrow(TypeError)
    expect(() => writeSidecarsJson(userData, [{ name: 'ok', port: 20000, pid: -1 }])).toThrow(/invalid sidecar handshake entry/)
    // 失败写入不得破坏既有 roster
    writeSidecarsJson(userData, entries)
    expect(() => writeSidecarsJson(userData, [{ name: '', port: 20000, pid: 1 }])).toThrow(TypeError)
    expect(readSidecarsJson(userData)).toEqual(entries)
  })
})
