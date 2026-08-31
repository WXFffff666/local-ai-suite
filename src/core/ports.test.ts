import { describe, it, expect } from 'vitest'
import * as net from 'net'

import {
  applyPortToConfig,
  deterministicPort,
  findFreeDynamicPort,
  probePortFree,
  DYNAMIC_PORT_MAX,
  DYNAMIC_PORT_MIN,
  type PortProbe,
} from './ports'
import type { ISidecar } from './types'

function listenEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port })
      else server.close(() => reject(new Error('no ephemeral port')))
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('probePortFree (真实 net 实现)', () => {
  it('被独占监听的端口 → 不空闲；关闭后 → 空闲', async () => {
    const { server, port } = await listenEphemeral()
    expect(await probePortFree('127.0.0.1', port)).toBe(false)
    await closeServer(server)
    expect(await probePortFree('127.0.0.1', port)).toBe(true)
  })
})

describe('deterministicPort', () => {
  it('同名稳定、落在 [min,max] 区间内', () => {
    const a = deterministicPort('llama')
    const b = deterministicPort('llama')
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(DYNAMIC_PORT_MIN)
    expect(a).toBeLessThanOrEqual(DYNAMIC_PORT_MAX)
    // 默认参数与显式全区间参数一致
    expect(deterministicPort('llama', [DYNAMIC_PORT_MIN, DYNAMIC_PORT_MAX])).toBe(a)
  })

  it('自定义小区间内仍确定且合法', () => {
    const p = deterministicPort('sd', [20000, 20002])
    expect([20000, 20001, 20002]).toContain(p)
    expect(deterministicPort('sd', [20000, 20002])).toBe(p)
  })
})

describe('findFreeDynamicPort', () => {
  it('确定性候选端口优先被探测（deterministic-first）', async () => {
    const probed: number[] = []
    const probe: PortProbe = async (_h, p) => {
      probed.push(p)
      return true
    }
    const picked = await findFreeDynamicPort('test-sidecar', probe, [20000, 20009])
    expect(picked).toBe(deterministicPort('test-sidecar', [20000, 20009]))
    expect(probed[0]).toBe(picked)
    expect(probed).toHaveLength(1)
  })

  it('候选被占 → 线性扫描并在到达 max 后回绕到 min', async () => {
    const min = 20000
    const max = 20004
    const first = deterministicPort('scan-sidecar', [min, max])
    const free = first === min ? max : first - 1 // 回绕段的最后一格才空闲
    const probed: number[] = []
    const probe: PortProbe = async (_h, p) => {
      probed.push(p)
      return p === free
    }
    const picked = await findFreeDynamicPort('scan-sidecar', probe, [min, max])
    expect(picked).toBe(free)
    // 探测顺序：first, first+1, ..., max, min, ..., first-1 —— 全区间恰好一轮
    expect(probed[0]).toBe(first)
    expect(probed).toHaveLength(max - min + 1)
    expect(probed[probed.length - 1]).toBe(free)
    expect(new Set(probed).size).toBe(max - min + 1) // 不重复探测
  })

  it('全区间耗尽 → 抛出带范围与名称的明确错误', async () => {
    await expect(
      findFreeDynamicPort('dead-sidecar', async () => false, [20000, 20003]),
    ).rejects.toThrow(/no free dynamic port in 20000-20003 for sidecar "dead-sidecar"/)
  })
})

describe('applyPortToConfig', () => {
  const cfg: ISidecar = {
    name: 'llama',
    bin: 'llama-server',
    args: ['--host', '127.0.0.1', '--port', '11435', '--ctx-size', '4096'],
    port: 11435,
    healthUrl: 'http://127.0.0.1:11435/health',
  }

  it('port / healthUrl 端口段 / args 中等于旧端口的 token 全部改写，其余不变', () => {
    const next = applyPortToConfig(cfg, 20007)
    expect(next.port).toBe(20007)
    expect(next.healthUrl).toBe('http://127.0.0.1:20007/health')
    expect(next.args).toEqual(['--host', '127.0.0.1', '--port', '20007', '--ctx-size', '4096'])
    expect(next.name).toBe('llama')
    expect(next.bin).toBe('llama-server')
  })

  it('不改动原对象（返回新 config，ISidecar 字段集不变）', () => {
    const next = applyPortToConfig(cfg, 20007)
    expect(cfg.port).toBe(11435)
    expect(cfg.args).toEqual(['--host', '127.0.0.1', '--port', '11435', '--ctx-size', '4096'])
    expect(Object.keys(next).sort()).toEqual(Object.keys(cfg).sort())
  })

  it('healthUrl 无显式端口或非法 URL 时保持原样，仅 port/args 改写', () => {
    const noPort: ISidecar = { ...cfg, healthUrl: 'http://127.0.0.1/health' }
    expect(applyPortToConfig(noPort, 20008).healthUrl).toBe('http://127.0.0.1/health')
    const bad: ISidecar = { ...cfg, healthUrl: 'not-a-url' }
    expect(applyPortToConfig(bad, 20008).healthUrl).toBe('not-a-url')
    expect(applyPortToConfig(bad, 20008).port).toBe(20008)
  })
})
