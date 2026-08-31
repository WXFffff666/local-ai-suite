import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  SidecarManager,
  HEALTH_INTERVAL_MS,
  MAX_FAILURES,
  MAX_RESTARTS,
  RESTART_BASE_MS,
  SIDECAR_HOST,
  type SidecarEventType,
  type SidecarManagerOptions,
} from './SidecarManager'
import { DYNAMIC_PORT_MAX, DYNAMIC_PORT_MIN, FIXED_API_PORT, deterministicPort } from './ports'
import type { ISidecar } from './types'

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

/** Default in unit tests: every port free (real net probing belongs to ports.test.ts). */
const freeProbe = async (): Promise<boolean> => true

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

  it('start 触发 spawn 且日志写入 logs/sidecar-*.log 且状态 running', async () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      healthIntervalMs: HEALTH_INTERVAL_MS,
    })
    await m.start()
    expect(spawner).toHaveBeenCalledWith('fake-bin', baseConfig.args, expect.objectContaining({ stdio: expect.anything() }))
    expect(fsMock.deps.mkdirSync).toHaveBeenCalled()
    expect(fsMock.deps.createWriteStream).toHaveBeenCalledWith(expect.stringContaining('sidecar-test-sidecar.log'), expect.anything())
    expect(m.isRunning()).toBe(true)
    expect(m.getStatus().running).toBe(true)
    expect(m.getStatus().port).toBe(11435)
    expect(m.getStatus().healthUrl).toBe(baseConfig.healthUrl)
    expect(m.getStatus().state).toBe('running')
    m.stop()
    expect(proc.kill).toHaveBeenCalled()
  })

  it('start 重复调用不重复 spawn', async () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    await m.start()
    expect(spawner).toHaveBeenCalledTimes(1)
    m.stop()
  })

  it('stop 清理定时器与进程', async () => {
    // 每次 spawn 返回全新子进程 mock（已 kill 的 mock 不能复用）
    const spawner = vi.fn(() => mockChildProcess() as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    expect(m.isRunning()).toBe(true)
    m.stop()
    expect(m.isRunning()).toBe(false)
    expect(m.getStatus().running).toBe(false)
    expect(m.getStatus().state).toBe('stopped')
    // stop 后可再次 start（failed 终态才禁止）
    await m.start()
    expect(m.isRunning()).toBe(true)
    expect(spawner).toHaveBeenCalledTimes(2)
    m.stop()
  })

  it('restart 增加 restarts 计数并重置 failures 且退避后重新 spawn', async () => {
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
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    expect(m.getStatus().restarts).toBe(0)
    m.restart()
    expect(m.getStatus().restarts).toBe(1)
    expect(m.getStatus().failures).toBe(0)
    expect(m.getStatus().state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(RESTART_BASE_MS)
    expect(spawner).toHaveBeenCalledTimes(2)
    expect(m.getStatus().state).toBe('running')
    m.stop()
  })

  it('restart 退避为 500ms·2^n：第1次 500ms 前不 spawn、到点 spawn；第2次 1000ms', async () => {
    const mkProc = () => mockChildProcess()
    const spawner = vi.fn(() => mkProc() as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    m.restart()
    await vi.advanceTimersByTimeAsync(499)
    expect(spawner).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawner).toHaveBeenCalledTimes(2)
    m.restart()
    await vi.advanceTimersByTimeAsync(999)
    expect(spawner).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(spawner).toHaveBeenCalledTimes(3)
    m.stop()
  })

  it('restart 预算耗尽 → failed 终态：第6次失败不再 spawn，事件 restarting×5 + failed×1', async () => {
    const procs: ReturnType<typeof mockChildProcess>[] = []
    const spawner = vi.fn(() => {
      const p = mockChildProcess({ pid: 100 + procs.length } as never)
      procs.push(p)
      return p as unknown as ReturnType<typeof import('child_process').spawn>
    })
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => false,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      maxFailures: 1,
      // 慢脉冲：循环内手动 healthCheck 驱动失败，避免自动脉冲干扰重启预算计数
      healthIntervalMs: 600_000,
    })
    const events: SidecarEventType[] = []
    m.onSidecarEvent((e) => events.push(e))
    await m.start()
    expect(spawner).toHaveBeenCalledTimes(1)
    // 5 次失败 → 5 次退避重启（第2..6个 spawn）
    const delays = [500, 1000, 2000, 4000, 8000]
    for (let i = 0; i < MAX_RESTARTS; i++) {
      expect(await m.healthCheck()).toBe(false)
      expect(m.getStatus().restarts).toBe(i + 1)
      await vi.advanceTimersByTimeAsync(delays[i])
      expect(spawner).toHaveBeenCalledTimes(i + 2)
      expect(m.isRunning()).toBe(true)
    }
    // 第 6 次失败：预算耗尽 → failed 终态，不再有第 6 次 restart spawn
    expect(await m.healthCheck()).toBe(false)
    expect(m.getStatus().state).toBe('failed')
    expect(m.getStatus().restarts).toBe(MAX_RESTARTS)
    expect(spawner).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(spawner).toHaveBeenCalledTimes(6)
    expect(events.filter((e) => e === 'restarting')).toHaveLength(MAX_RESTARTS)
    expect(events.filter((e) => e === 'failed')).toHaveLength(1)
    // failed 为终态：手动 start 也不再生效
    await m.start()
    expect(spawner).toHaveBeenCalledTimes(6)
    expect(m.getStatus().state).toBe('failed')
  })

  it('onSidecarEvent 返回退订函数，failed 事件携带终态 status', async () => {
    const m = new SidecarManager(baseConfig, {
      spawner: (() => mockChildProcess() as unknown as never) as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      maxRestarts: 0,
    })
    const seen: Array<[SidecarEventType, string]> = []
    const off = m.onSidecarEvent((e, s) => seen.push([e, s.state]))
    await m.start()
    m.restart()
    expect(m.getStatus().state).toBe('failed')
    expect(seen).toEqual([['failed', 'failed']])
    off()
    m.restart()
    expect(seen).toHaveLength(1) // 退订后不再收到事件
    m.stop()
  })

  it('restart 处于 backoff 时 stop 取消未决重启', async () => {
    const spawner = vi.fn(() => mockChildProcess() as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    m.restart()
    m.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawner).toHaveBeenCalledTimes(1)
    expect(m.getStatus().state).toBe('stopped')
  })

  it('端口预检未完成时 stop 使在途 start 放弃 spawn（supersede 守卫）', async () => {
    const spawner = vi.fn(() => mockChildProcess() as unknown as ReturnType<typeof import('child_process').spawn>)
    let releaseProbe: (() => void) | undefined
    const m = new SidecarManager(baseConfig, {
      spawner: spawner as never,
      fetcher: async () => true,
      probePort: () => new Promise<boolean>((resolve) => { releaseProbe = () => resolve(true) }),
      fsDeps: fsMock.deps as never,
    })
    const starting = m.start()
    m.stop()
    releaseProbe?.()
    await starting
    expect(spawner).not.toHaveBeenCalled()
    expect(m.isRunning()).toBe(false)
  })

  it('healthCheck 成功清零 failures', async () => {
    const proc = mockChildProcess()
    let fetchOk = false
    const fetcher = vi.fn(async () => fetchOk)
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: fetcher as never,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    // 先失败一次
    expect(await m.healthCheck()).toBe(false)
    expect(m.getStatus().failures).toBe(1)
    // 再成功
    fetchOk = true
    expect(await m.healthCheck()).toBe(true)
    expect(m.getStatus().failures).toBe(0)
    m.stop()
  })

  it('health 失败2次不重启、3次触发退避后重启（阈值 MAX_FAILURES=3）', async () => {
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
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      maxFailures: 3,
    })
    await m.start()
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
    // 第3次失败 — 触发重启（退避 500ms 后才真正 spawn）
    expect(await m.healthCheck()).toBe(false)
    expect(spawner).toHaveBeenCalledTimes(1)
    expect(m.getStatus().restarts).toBe(1)
    expect(m.getStatus().failures).toBe(0) // 重启计数清零
    await vi.advanceTimersByTimeAsync(500)
    expect(spawner).toHaveBeenCalledTimes(2)
    m.stop()
  })

  it('health pulse 每 5s 自动触发 healthCheck', async () => {
    const fetcher = vi.fn(async () => true)
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: fetcher as never,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      healthIntervalMs: 5000,
    })
    await m.start()
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

  it('日志轮转 — 超过阈值重命名为 .1 并重开流', async () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      logMaxBytes: 1024,
    })
    await m.start()
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

  it('日志轮转 — 未超限不重命名', async () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
      logMaxBytes: 5 * 1024 * 1024,
    })
    await m.start()
    fsMock.deps.existsSync.mockReturnValue(true)
    fsMock.deps.statSync.mockReturnValue({ size: 100 } as never)
    m.checkLogRotation()
    expect(fsMock.deps.renameSync).not.toHaveBeenCalled()
    m.stop()
  })

  it('日志轮转 — 文件不存在不操作', async () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
    fsMock.deps.existsSync.mockReturnValue(false)
    m.checkLogRotation()
    expect(fsMock.deps.renameSync).not.toHaveBeenCalled()
    m.stop()
  })

  it('stdout/stderr 写入日志', async () => {
    const proc = mockChildProcess()
    const m = new SidecarManager(baseConfig, {
      spawner: (() => proc as unknown as never) as never,
      fetcher: async () => true,
      probePort: freeProbe,
      fsDeps: fsMock.deps as never,
    })
    await m.start()
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

  it('常量导出符合 spec：5s 脉冲、3次重启、127.0.0.1、重启上限5、退避500ms、端口策略', () => {
    expect(HEALTH_INTERVAL_MS).toBe(5000)
    expect(MAX_FAILURES).toBe(3)
    expect(SIDECAR_HOST).toBe('127.0.0.1')
    expect(MAX_RESTARTS).toBe(5)
    expect(RESTART_BASE_MS).toBe(500)
    expect(FIXED_API_PORT).toBe(11434)
    expect(DYNAMIC_PORT_MIN).toBe(20000)
    expect(DYNAMIC_PORT_MAX).toBe(30000)
  })

  it('子进程意外退出 → 立即视为失败，外部端口响应者不能伪装健康（归属修复）', async () => {
    const child = mockChildProcess()
    const fsMock = makeFsMock()
    const m = new SidecarManager(baseConfig, {
      logDir: 'logs-test',
      spawner: vi.fn(() => child as unknown as ReturnType<typeof import('child_process').spawn>),
      // 模拟“外来进程”占着端口并返回健康 —— 归属修复前这会被误判为 healthy
      fetcher: vi.fn(async () => true),
      probePort: freeProbe,
      fsDeps: fsMock.deps as NonNullable<SidecarManagerOptions['fsDeps']>,
    })
    await m.start()
    expect(m.isRunning()).toBe(true)

    ;(child as unknown as EventEmitter).emit('exit', 1, null)
    expect(m.isRunning()).toBe(false)
    expect(m.getStatus().failures).toBe(1)

    await expect(m.healthCheck()).resolves.toBe(false)
    m.stop()
  })

  it('主动 stop() 的退出事件不计入失败', async () => {
    const child = mockChildProcess()
    const fsMock = makeFsMock()
    const m = new SidecarManager(baseConfig, {
      logDir: 'logs-test',
      spawner: vi.fn(() => child as unknown as ReturnType<typeof import('child_process').spawn>),
      fetcher: vi.fn(async () => false),
      probePort: freeProbe,
      fsDeps: fsMock.deps as NonNullable<SidecarManagerOptions['fsDeps']>,
    })
    await m.start()
    m.stop()
    expect(m.getStatus().failures).toBe(0)
  })

  describe('端口预检与动态端口 (W0-2)', () => {
    it('端口空闲 → 不触发动态分配，probe 只查一次配置端口', async () => {
      const probed: number[] = []
      const m = new SidecarManager(baseConfig, {
        spawner: (() => mockChildProcess() as unknown as never) as never,
        fetcher: async () => true,
        probePort: async (_h, p) => { probed.push(p); return true },
        fsDeps: fsMock.deps as never,
      })
      await m.start()
      expect(probed).toEqual([11435])
      expect(m.config.port).toBe(11435)
      m.stop()
    })

    it('端口被占 → 优先确定性候选端口，port/healthUrl/args 全部改写并贯穿 config', async () => {
      const first = deterministicPort('test-sidecar')
      const probed: number[] = []
      const spawner = vi.fn(() => mockChildProcess() as unknown as ReturnType<typeof import('child_process').spawn>)
      const m = new SidecarManager(baseConfig, {
        spawner: spawner as never,
        fetcher: async () => true,
        probePort: async (_h, p) => { probed.push(p); return p === first },
        fsDeps: fsMock.deps as never,
      })
      await m.start()
      expect(probed).toEqual([11435, first])
      expect(m.config.port).toBe(first)
      expect(m.getStatus().port).toBe(first)
      expect(m.getStatus().healthUrl).toBe(`http://127.0.0.1:${first}/health`)
      expect(spawner).toHaveBeenCalledWith('fake-bin', ['--port', String(first), '--host', '127.0.0.1'], expect.anything())
      m.stop()
    })

    it('确定性候选也被占 → 向后线性扫描下一个空闲端口', async () => {
      const first = deterministicPort('test-sidecar')
      const probed: number[] = []
      const m = new SidecarManager(baseConfig, {
        spawner: (() => mockChildProcess() as unknown as never) as never,
        fetcher: async () => true,
        probePort: async (_h, p) => { probed.push(p); return p === first + 1 },
        fsDeps: fsMock.deps as never,
      })
      await m.start()
      expect(probed).toEqual([11435, first, first + 1])
      expect(m.config.port).toBe(first + 1)
      m.stop()
    })

    it('11434 被占 → 绝不动态化，端口/healthUrl 原样保留（冲突由调用方 todo10 处置）', async () => {
      const cfg: ISidecar = {
        name: 'ollama',
        bin: 'ollama',
        args: ['serve'],
        port: FIXED_API_PORT,
        healthUrl: 'http://127.0.0.1:11434/api/tags',
      }
      const spawner = vi.fn(() => mockChildProcess() as unknown as ReturnType<typeof import('child_process').spawn>)
      const m = new SidecarManager(cfg, {
        spawner: spawner as never,
        fetcher: async () => true,
        probePort: async () => false, // 全部端口都被占
        fsDeps: fsMock.deps as never,
      })
      await m.start()
      expect(m.config.port).toBe(FIXED_API_PORT)
      expect(m.config.healthUrl).toBe('http://127.0.0.1:11434/api/tags')
      expect(m.getStatus().port).toBe(FIXED_API_PORT)
      expect(spawner).toHaveBeenCalledTimes(1)
      m.stop()
    })

    it('动态范围全部耗尽 → start() 抛出明确错误', async () => {
      const m = new SidecarManager(baseConfig, {
        spawner: (() => mockChildProcess() as unknown as never) as never,
        fetcher: async () => true,
        probePort: async () => false,
        dynamicPortRange: [20000, 20002] as const,
        fsDeps: fsMock.deps as never,
      })
      await expect(m.start()).rejects.toThrow(/no free dynamic port in 20000-20002/)
    })

    it('退避重启后的再次 start 复用已解析端口并重新预检', async () => {
      const first = deterministicPort('test-sidecar')
      const probed: number[] = []
      const m = new SidecarManager(baseConfig, {
        spawner: (() => mockChildProcess() as unknown as never) as never,
        fetcher: async () => true,
        probePort: async (_h, p) => { probed.push(p); return p === first },
        fsDeps: fsMock.deps as never,
      })
      await m.start()
      m.restart()
      await vi.advanceTimersByTimeAsync(500)
      expect(probed).toEqual([11435, first, first])
      expect(m.config.port).toBe(first)
      m.stop()
    })
  })
})
