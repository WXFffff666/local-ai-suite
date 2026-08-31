import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HOOK_TIMEOUT_MS,
  registerShutdownHook,
  resetShutdownState,
  shutdownServices,
  ShutdownHookTimeoutError
} from './shutdown'

describe('shutdown — 统一退出钩子', () => {
  beforeEach(() => {
    resetShutdownState()
  })

  it('钩子按 LIFO 顺序执行（最后注册的最先停）', async () => {
    const order: string[] = []
    registerShutdownHook(() => {
      order.push('a')
    })
    registerShutdownHook(() => {
      order.push('b')
    })
    registerShutdownHook(() => {
      order.push('c')
    })

    const result = await shutdownServices()

    expect(order).toEqual(['c', 'b', 'a'])
    expect(result.errors).toHaveLength(0)
  })

  it('异步钩子顺序等待：前一个完成（或超时）后才跑下一个', async () => {
    const order: string[] = []
    registerShutdownHook(() => {
      order.push('first-done')
    })
    registerShutdownHook(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      order.push('slow-done')
    })

    await shutdownServices(500)

    // LIFO: slow hook (registered last) runs first and is awaited before 'first-done'
    expect(order).toEqual(['slow-done', 'first-done'])
  })

  it('幂等：重复调用返回同一 Promise，钩子只跑一次', async () => {
    let runs = 0
    registerShutdownHook(() => {
      runs += 1
    })

    const first = shutdownServices()
    const second = shutdownServices()
    const [r1, r2] = await Promise.all([first, second])

    expect(first).toBe(second)
    expect(r1).toBe(r2)
    expect(runs).toBe(1)
  })

  it('钩子抛错（同步）不中断其余钩子，错误进 errors 而非悬挂', async () => {
    const order: string[] = []
    registerShutdownHook(() => {
      order.push('b')
    })
    registerShutdownHook(() => {
      throw new Error('boom-a')
    })

    const result = await shutdownServices()

    expect(order).toEqual(['b'])
    expect(result.errors).toHaveLength(1)
    const [failure] = result.errors
    expect((failure?.reason as Error).message).toBe('boom-a')
    expect(failure?.hookIndex).toBe(0)
  })

  it('钩子 reject（异步）同样被收集，后续钩子继续', async () => {
    const order: string[] = []
    registerShutdownHook(() => {
      order.push('c')
    })
    registerShutdownHook(async () => {
      await Promise.resolve()
      throw new Error('boom-b')
    })
    registerShutdownHook(() => {
      order.push('a')
    })

    const result = await shutdownServices()

    // LIFO: last registered (push 'a') runs first, then the rejecting hook, then push 'c'.
    expect(order).toEqual(['a', 'c'])
    expect(result.errors).toHaveLength(1)
    expect((result.errors[0]?.reason as Error).message).toBe('boom-b')
    expect(result.errors[0]?.hookIndex).toBe(1)
  })

  it('悬挂钩子在超时后强制放行，不阻塞退出流程', async () => {
    const neverSettles = new Promise<void>(() => {
      /* intentionally never resolves — simulates a hung sidecar stop() */
    })
    registerShutdownHook(() => neverSettles)

    const started = Date.now()
    const result = await shutdownServices(10)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.reason).toBeInstanceOf(ShutdownHookTimeoutError)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('默认超时为 3s（计划验收：3s per-hook timeout）', () => {
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(3000)
  })
})
