/**
 * imageTool.test.ts — [[IMG:…]] 标记解析 + runImageJob 事件驱动流程。
 */

import { describe, expect, it, vi } from 'vitest'

import { extractImageMarks, runImageJob } from './imageTool'

describe('extractImageMarks', () => {
  it('提取标记并剔除正文', () => {
    const { marks, clean } = extractImageMarks('已开始绘制\n[[IMG:一只橙色的猫]]\n请稍等')
    expect(marks).toEqual(['一只橙色的猫'])
    expect(clean).toBe('已开始绘制\n\n请稍等')
  })
  it('多标记全提取', () => {
    const { marks } = extractImageMarks('[[IMG:猫]] 中间的话 [[IMG:狗]]')
    expect(marks).toEqual(['猫', '狗'])
  })
  it('无标记返回原文', () => {
    const { marks, clean } = extractImageMarks('普通回答')
    expect(marks).toEqual([])
    expect(clean).toBe('普通回答')
  })
  it('空白标记跳过', () => {
    const { marks } = extractImageMarks('[[IMG:   ]]')
    expect(marks).toEqual([])
  })
})

describe('runImageJob', () => {
  type Listener = (payload: { jobId?: string; type?: string }) => void
  function fakeApi() {
    const listeners = new Set<Listener>()
    return {
      api: {
        invoke: vi.fn(async (channel: string, ...callArgs: unknown[]): Promise<unknown> => {
          if (channel === 'image:generate') {
            expect((callArgs[0] as { enhance?: boolean }).enhance).toBe(true)
            return { ok: true, jobId: 'j1' }
          }
          if (channel === 'image:queue:status') {
            return { job: { result: { b64: 'iVBORpng' } } }
          }
          return {}
        }),
        on: vi.fn((channel: string, l: Listener) => {
          expect(channel).toBe('image:queue:status')
          listeners.add(l)
          return () => listeners.delete(l)
        }),
      },
      emit: (ev: { jobId?: string; type?: string }): void => {
        for (const l of [...listeners]) l(ev)
      },
    }
  }

  it('done → 解析 b64 → dataURL', async () => {
    const { api, emit } = fakeApi()
    const p = runImageJob(api, '一只猫')
    await Promise.resolve()
    await Promise.resolve()
    emit({ jobId: 'j1', type: 'progress' })
    emit({ jobId: 'j1', type: 'done' })
    await expect(p).resolves.toBe('data:image/png;base64,iVBORpng')
  })

  it('failed → 拒绝并带 job.error', async () => {
    const { api, emit } = fakeApi()
    api.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'image:queue:status') return { job: { error: 'no-diffusion-model' } }
      if (channel === 'image:generate') return { ok: true, jobId: 'j1' }
      return {}
    })
    const p = runImageJob(api, 'x')
    await Promise.resolve()
    await Promise.resolve()
    emit({ jobId: 'j1', type: 'failed' })
    await expect(p).rejects.toThrow('no-diffusion-model')
  })

  it('请求被拒（无模型等）→ 立即拒绝', async () => {
    const { api } = fakeApi()
    api.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'image:generate') return { ok: false, issues: [{ message: 'init-image-missing' }] } as never
      return {}
    })
    await expect(runImageJob(api, 'x')).rejects.toThrow('init-image-missing')
  })
})
