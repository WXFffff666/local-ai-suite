/**
 * executor.test.ts — 生图执行器（阶段0）单元测试：
 * pickDiffusionModel 目录/匹配/回退规则 + createSdJobHandler 契约
 * （no-diffusion-model、ensureSd 端口透传、b64 PNG 契约、进度回调、loras 透传）。
 */

import { describe, expect, it, vi } from 'vitest'

import type { ModelEntry } from '../models/registry'
import { createSdJobHandler, pickDiffusionModel } from './executor'

function entry(partial: Partial<ModelEntry> & Pick<ModelEntry, 'name' | 'file' | 'path'>): ModelEntry {
  return {
    size: 1000,
    quant: 'Q8_0',
    arch: 'unknown',
    format: 'gguf',
    mtimeMs: 0,
    ...partial,
  }
}

const baseCtx = (onProgress = vi.fn()) => ({
  onProgress,
  signal: new AbortController().signal,
})

describe('pickDiffusionModel', () => {
  it('仅接受 diffusion/ 目录下的未损坏 gguf/safetensors', () => {
    const picked = pickDiffusionModel([
      entry({ name: 'qwen3-4b', file: 'llm/qwen3-4b.gguf', path: 'X:\\m\\llm\\qwen3-4b.gguf' }),
      entry({ name: 'sd15', file: 'diffusion/sd15.gguf', path: 'X:\\m\\diffusion\\sd15.gguf' }),
      entry({ name: 'bad', file: 'diffusion/bad.gguf', path: 'X:\\m\\diffusion\\bad.gguf', corrupted: true }),
      entry({ name: 'lora-x', file: 'diffusion/lora-x.safetensors', path: 'X:\\m\\diffusion\\lora-x.safetensors' }),
    ])
    expect(picked).toBe('X:\\m\\diffusion\\sd15.gguf')
  })

  it('requested 按名称子串匹配（大小写不敏感）', () => {
    const entries = [
      entry({ name: 'sd15-turbo', file: 'diffusion/sd15-turbo.gguf', path: 'P1' }),
      entry({ name: 'sdxl-base', file: 'diffusion/sdxl-base.safetensors', path: 'P2' }),
    ]
    expect(pickDiffusionModel(entries, 'SDXL')).toBe('P2')
    expect(pickDiffusionModel(entries, 'turbo')).toBe('P1')
  })

  it('requested 无命中回退候选集（多个取最大文件）', () => {
    const entries = [
      entry({ name: 'a', file: 'diffusion/a.gguf', path: 'SMALL', size: 100 }),
      entry({ name: 'b', file: 'diffusion/b.gguf', path: 'BIG', size: 900 }),
    ]
    expect(pickDiffusionModel(entries, 'zzz-none')).toBe('BIG')
    expect(pickDiffusionModel(entries)).toBe('BIG')
  })

  it('无候选返回 undefined', () => {
    expect(pickDiffusionModel([entry({ name: 'llm', file: 'llm/x.gguf', path: 'P' })])).toBeUndefined()
    expect(pickDiffusionModel([])).toBeUndefined()
  })
})

describe('createSdJobHandler', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg'

  it('正常链路：resolveModel → ensureSd 端口 → generate → PNG b64 契约', async () => {
    const onProgress = vi.fn()
    const handler = createSdJobHandler({
      resolveModel: () => 'X:\\m\\diffusion\\m.gguf',
      ensureSd: vi.fn(async () => ({ port: 11436 })),
      generate: vi.fn(async () => ({ image: PNG_B64, images: [PNG_B64], seed: 42 })),
      tickMs: 5,
    })
    const result = (await handler(
      {
        prompt: '一只猫',
        id: 'j1',
        status: 'running',
        progress: 0,
        createdAt: 0,
        attempt: 0,
        maxRetries: 2,
        retryBackoffMs: 1,
        downgraded: false,
        effectiveModel: 'm',
      },
      baseCtx(onProgress),
    )) as { b64: string; seed?: number }

    expect(result.b64).toBe(PNG_B64)
    expect(result.seed).toBe(42)
    // 启动 + 绘制 tick + 回传 三段进度
    expect(onProgress).toHaveBeenCalledWith(5, '正在启动画图引擎…')
    expect(onProgress).toHaveBeenCalledWith(92, '正在回传图片…')
  })

  it('未找到画图模型抛 no-diffusion-model 且不拉起侧车', async () => {
    const ensureSd = vi.fn(async () => ({ port: 11436 }))
    const handler = createSdJobHandler({ resolveModel: () => undefined, ensureSd })
    await expect(handler({ prompt: 'x' } as never, baseCtx())).rejects.toThrow('no-diffusion-model')
    expect(ensureSd).not.toHaveBeenCalled()
  })

  it('非 PNG 结果（如 JPEG）抛错', async () => {
    const handler = createSdJobHandler({
      resolveModel: () => 'M',
      ensureSd: async () => ({ port: 11436 }),
      generate: async () => ({ image: '/9j/4AAQSkZJRg' }),
      tickMs: 5,
    })
    await expect(handler({ prompt: 'x' } as never, baseCtx())).rejects.toThrow('PNG')
  })

  it('空结果抛错（引擎未返回图片数据）', async () => {
    const handler = createSdJobHandler({
      resolveModel: () => 'M',
      ensureSd: async () => ({ port: 11436 }),
      generate: async () => ({}),
      tickMs: 5,
    })
    await expect(handler({ prompt: 'x' } as never, baseCtx())).rejects.toThrow('未返回图片')
  })

  it('job 参数完整透传给 sd 请求（img2img/strength/loras/seed）', async () => {
    const generate = vi.fn(async () => ({ image: PNG_B64 }))
    const handler = createSdJobHandler({
      resolveModel: () => 'M',
      ensureSd: async () => ({ port: 12345 }),
      generate,
      tickMs: 5,
    })
    await handler(
      {
        prompt: 'p',
        width: 768,
        height: 512,
        steps: 8,
        cfg_scale: 1,
        seed: 7,
        loras: [{ name: 'x', scale: 0.8 }],
        initImagePath: 'C:\\tmp\\init.png',
        strength: 0.6,
      } as never,
      baseCtx(),
    )
    const req = generate.mock.calls[0]![0]
    expect(req.width).toBe(768)
    expect(req.height).toBe(512)
    expect(req.steps).toBe(8)
    expect(req.cfg_scale).toBe(1)
    expect(req.seed).toBe(7)
    expect(req.loras).toEqual([{ name: 'x', scale: 0.8 }])
    expect(req.initImagePath).toBe('C:\\tmp\\init.png')
    expect(req.strength).toBe(0.6)
    expect(generate.mock.calls[0]![1].port).toBe(12345)
  })
})
