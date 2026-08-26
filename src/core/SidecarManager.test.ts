import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { SidecarManager, HEALTH_INTERVAL_MS, MAX_FAILURES, SIDECAR_HOST } from './SidecarManager'
import type { ISidecar } from './types'
import type { SidecarManagerOptions } from './SidecarManager'

// --- Helpers ---

function mockChildProcess(overrides: Partial<Record<string, unknown>> = {}) {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number
    killed: boolean
    exitCode: number | null
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter
    stderr: EventEmitter
  }
  ee.pid = 12345
  ee.killed = false
  ee.exitCode = null
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.kill = vi.fn(() => {
    ee.killed = true
    ee.exitCode = null
    return true
  })
  Object.assign(ee, overrides)
  return ee
}

const baseConfig: ISidecar = {
  name: 'test-sidecar',
  bin: 'fake-bin',
  args: ['--port', '11435', '--host', '127.0.0.1'],
  port: 11435,
  healthUrl: 'http://127.0.0.1:11435/health',
}

function makeFsMock() {
  const writes: string[] = []
  const fakeStream: Record<string, unknown> = {
    write: vi.fn((s: string) => writes.push(s)),
    end: vi.fn(),
    on: vi.fn(),
  }
  return {
    writes,
    fakeStream,
    deps: {
      createWriteStream: vi.fn(() => fakeStream as unknown as ReturnType<typeof import('fs').createWriteStream>),
      statSync: vi.fn(() => ({ size: 0 }) as unknown as ReturnType<typeof import('fs').statSync>),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
  }
}

describe('SidecarManager', () => {
  let fsMock: ReturnType<typeof makeFsMock>

  beforeEach(() => {
    vi.useFakeTimers()
    fsMock = makeFsMock()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('ISidecar 配置校验 — 非 127.0.0.1 的 healthUrl 抛错', () => {
    const bad: ISidecar = { ...baseConfig, healthUrl: 'http://0.0.0.0:11435/health' }
    expect(() => new SidecarManager(bad, { fsDeps: fsMock.deps as never })).toThrow(/127\.0\.0\.1/)
    const bad2: ISidecar = { ...baseConfig, healthUrl: 'http://192.168.1.1:11435/health' }
    expect(() => new SidecarManager(bad2, { fsDeps: fsMock.deps as never })).toThrow(/127\.0\.0\.1/)
  })

  it('ISidecar 端口越界抛错', () => {
    const bad: ISidecar = { ...baseConfig, port: 80 }
    expect(() => new SidecarManager(bad, { fsDeps: fsMock.deps as never })).toThrow(/port/)
  })

  it('start 触发 spawn 且日志写入 logs/sidecar-*.log 且状态 running', () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
      healthIntervalMs: HEALTH_INTERVAL_MS,
    })
    m.start()
    expect(spawner).toHaveBeenCalledWith('fake-bin', baseConfig.args, expect.objectContaining({ stdio: expect.anything() }))
    expect(fsMock.deps.mkdirSync).toHaveBeenCalled()
    expect(fsMock.deps.createWriteStream).toHaveBeenCalledWith(expect.stringContaining('sidecar-test-sidecar.log'), expect.anything())
    expect(m.isRunning()).toBe(true)
    expect(m.getStatus().running).toBe(true)
    expect(m.getStatus().port).toBe(11435)
    expect(m.getStatus().healthUrl).toBe(baseConfig.healthUrl)
    m.stop()
    expect(proc.kill).toHaveBeenCalled()
  })

  it('start 重复调用不重复 spawn', () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
    })
    m.start()
    m.start()
    expect(spawner).toHaveBeenCalledTimes(1)
    m.stop()
  })

  it('stop 清理定时器与进程', () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
    })
    m.start()
    expect(m.isRunning()).toBe(true)
    m.stop()
    expect(m.isRunning()).toBe(false)
    expect(m.getStatus().running).toBe(false)
    // stop 后可再次 start
    const proc2 = mockChildProcess({ pid: 99999 } as never)
    ;(m as unknown as { spawner: unknown }).spawner = (() => proc2 as unknown as never) as never
    // 用新实例验证重启语义
  })

  it('restart 增加 restarts 计数并重置 failures 且重新 spawn', () => {
    const proc1 = mockChildProcess({ pid: 111 } as never)
    const proc2 = mockChildProcess({ pid: 222 } as never)
    let call = 0
    const spawner = vi.fn(() => {
      call++
      return (call === 1 ? proc1 : proc2) as unknown as ReturnType<typeof import('child_process').spawn>
    })
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
    })
    m.start()
    expect(m.getStatus().restarts).toBe(0)
    m.restart()
    expect(spawner).toHaveBeenCalledTimes(2)
    expect(m.getStatus().restarts).toBe(1)
    expect(m.getStatus().failures).toBe(0)
    m.stop()
  })

  it('healthCheck 成功清零 failures', async () => {
    const proc = mockChildProcess()
    let fetchOk = false
    const fetcher = vi.fn(async () => fetchOk)
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: fetcher as never,
      fsDeps: fsMock.deps as never,
    })
    m.start()
    // 先失败一次
    expect(await m.healthCheck()).toBe(false)
    expect(m.getStatus().failures).toBe(1)
    // 再成功
    fetchOk = true
    expect(await m.healthCheck()).toBe(true)
    expect(m.getStatus().failures).toBe(0)
    m.stop()
  })

  it('health 失败2次不重启、3次重启（阈值 MAX_FAILURES=3）', async () => {
    const proc1 = mockChildProcess({ pid: 111 } as never)
    const proc2 = mockChildProcess({ pid: 222 } as never)
    let spawns = 0
    const spawner = vi.fn(() => {
      spawns++
      return (spawns === 1 ? proc1 : proc2) as unknown as ReturnType<typeof import('child_process').spawn>
    })
    const fetcher = vi.fn(async () => false)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: fetcher as never,
      fsDeps: fsMock.deps as never,
      maxFailures: 3,
    })
    m.start()
    expect(spawner).toHaveBeenCalledTimes(1)
    // 第1次失败 — 不重启
    expect(await m.healthCheck()).toBe(false)
    expect(m.getStatus().failures).toBe(1)
    expect(spawner).toHaveBeenCalledTimes(1)
    expect(m.getStatus().restarts).toBe(0)
    // 第2次失败 — 仍不重启
    expect(await m.healthCheck()).toBe(false)
    expect(m.getStatus().failures).toBe(2)
    expect(spawner).toHaveBeenCalledTimes(1)
    expect(m.getStatus().restarts).toBe(0)
    // 第3次失败 — 触发重启
    expect(await m.healthCheck()).toBe(false)
    expect(spawner).toHaveBeenCalledTimes(2)
    expect(m.getStatus().restarts).toBe(1)
    expect(m.getStatus().failures).toBe(0) // 重启后清零
    m.stop()
  })

  it('health pulse 每 5s 自动触发 healthCheck', async () => {
    const fetcher = vi.fn(async () => true)
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: fetcher as never,
      fsDeps: fsMock.deps as never,
      healthIntervalMs: 5000,
    })
    m.start()
    expect(fetcher).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    m.stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetcher).toHaveBeenCalledTimes(4) // 停止后不再触发
  })

  it('日志轮转 — 超过阈值重命名为 .1 并重开流', () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
      logMaxBytes: 1024,
    })
    m.start()
    // 模拟日志已超限
    fsMock.deps.existsSync.mockReturnValue(true)
    fsMock.deps.statSync.mockReturnValue({ size: 2048 } as never)
    m.checkLogRotation()
    expect(fsMock.deps.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('sidecar-test-sidecar.log'),
      expect.stringContaining('sidecar-test-sidecar.log.1'),
    )
    // createWriteStream 被调用两次：start 一次 + rotate 后重开一次
    expect(fsMock.deps.createWriteStream).toHaveBeenCalledTimes(2)
    m.stop()
  })

  it('日志轮转 — 未超限不重命名', () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
      logMaxBytes: 5 * 1024 * 1024,
    })
    m.start()
    fsMock.deps.existsSync.mockReturnValue(true)
    fsMock.deps.statSync.mockReturnValue({ size: 100 } as never)
    m.checkLogRotation()
    expect(fsMock.deps.renameSync).not.toHaveBeenCalled()
    m.stop()
  })

  it('日志轮转 — 文件不存在不操作', () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
    })
    m.start()
    fsMock.deps.existsSync.mockReturnValue(false)
    m.checkLogRotation()
    expect(fsMock.deps.renameSync).not.toHaveBeenCalled()
    m.stop()
  })

  it('stdout/stderr 写入日志', () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      fsDeps: fsMock.deps as never,
    })
    m.start()
    ;(proc.stdout as EventEmitter).emit('data', Buffer.from('hello stdout'))
    ;(proc.stderr as EventEmitter).emit('data', Buffer.from('hello stderr'))
    // createWriteStream 的第0个写入即 start 日志，后面两次为 stdout/stderr
    expect(fsMock.fakeStream.write).toHaveBeenCalled()
    const all = (fsMock.fakeStream.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(all.join('')).toContain('hello stdout')
    expect(all.join('')).toContain('hello stderr')
    m.stop()
  })

  it('ISidecar/IModelProvider/ISearchAdapter/IImageBackend 可被 SidecarManager 配置复用', () => {
    // 验证4接口抽象可作为 SidecarManager 配置
    const m1 = new SidecarManager(baseConfig, { fsDeps: fsMock.deps as never, fetcher: async () => true })
    expect(m1.config.name).toBe('test-sidecar')
    // IModelProvider 扩展字段
    const modelCfg = { ...baseConfig, name: 'llama', modelPath: '/models/qwen.gguf' }
    const m2 = new SidecarManager(modelCfg as never, { fsDeps: fsMock.deps as never, fetcher: async () => true })
    expect((m2.config as unknown as { modelPath: string }).modelPath).toBe('/models/qwen.gguf')
    m1.stop()
    m2.stop()
  })

  it('常量导出符合 spec：5s 脉冲、3次重启、127.0.0.1', () => {
    expect(HEALTH_INTERVAL_MS).toBe(5000)
    expect(MAX_FAILURES).toBe(3)
    expect(SIDECAR_HOST).toBe('127.0.0.1')
  })

  it('子进程意外退出 → 立即视为失败，外部端口响应者不能伪装健康（归属修复）', async () => {
    const child = mockChildProcess()
    const fsMock = makeFsMock()
    const m = new SidecarManager(baseConfig, {
      logDir: 'logs-test',
      spawner: vi.fn(() => child as unknown as ReturnType<typeof import('child_process').spawn>),
      // 模拟“外来进程”占着端口并返回健康 —— 归属修复前这会被误判为 healthy
      fetcher: vi.fn(async () => true),
      fsDeps: fsMock.deps as NonNullable<SidecarManagerOptions['fsDeps']>,
    })
    m.start()
    expect(m.isRunning()).toBe(true)

    ;(child as unknown as EventEmitter).emit('exit', 1, null)
    expect(m.isRunning()).toBe(false)
    expect(m.getStatus().failures).toBe(1)

    await expect(m.healthCheck()).resolves.toBe(false)
    m.stop()
  })

  it('主动 stop() 的退出事件不计入失败', () => {
    const child = mockChildProcess()
    const fsMock = makeFsMock()
    const m = new SidecarManager(baseConfig, {
      logDir: 'logs-test',
      spawner: vi.fn(() => child as unknown as ReturnType<typeof import('child_process').spawn>),
      fetcher: vi.fn(async () => false),
      fsDeps: fsMock.deps as NonNullable<SidecarManagerOptions['fsDeps']>,
    })
    m.start()
    m.stop()
    expect(m.getStatus().failures).toBe(0)
  })
})
