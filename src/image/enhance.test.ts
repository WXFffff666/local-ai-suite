/**
 * enhance.test.ts — PromptEnhancer 单元测试：
 * pickEnhancerModel 选择规则 + enhancePrompt 三级降级 + extractEnhanceJson 稳健解析。
 */

import { describe, expect, it, vi } from 'vitest'

import type { ModelEntry } from '../models/registry'
import {
  createLlamaChat,
  enhancePrompt,
  extractEnhanceJson,
  pickEnhancerModel,
} from './enhance'

function entry(partial: Partial<ModelEntry> & Pick<ModelEntry, 'name' | 'file' | 'path'>): ModelEntry {
  return {
    size: 1000,
    quant: 'Q4_K_M',
    arch: 'qwen2',
    format: 'gguf',
    mtimeMs: 0,
    ...partial,
  }
}

describe('pickEnhancerModel', () => {
  it('仅接受 llm/ 目录未损坏 gguf，排除 embedding/whisper 等', () => {
    const picked = pickEnhancerModel([
      entry({ name: 'bge-m3', file: 'embedding/bge-m3.gguf', path: 'E' }),
      entry({ name: 'whisper-tiny', file: 'llm/whisper-tiny.gguf', path: 'W' }),
      entry({ name: 'qwen3-4b-instruct', file: 'llm/qwen3-4b-instruct-Q4_K_M.gguf', path: 'Q' }),
      entry({ name: 'bad', file: 'llm/bad.gguf', path: 'B', corrupted: true }),
    ])
    expect(picked).toBe('Q')
  })

  it('requested 子串匹配优先', () => {
    const entries = [
      entry({ name: 'qwen3-4b', file: 'llm/qwen3-4b.gguf', path: 'Q4' }),
      entry({ name: 'llama-3b', file: 'llm/llama-3b.gguf', path: 'L3' }),
    ]
    expect(pickEnhancerModel(entries, 'llama')).toBe('L3')
    expect(pickEnhancerModel(entries, 'nothing')).toBe('Q4') // 回退偏好 qwen
  })

  it('qwen/instruct 加分，同级取大', () => {
    const picked = pickEnhancerModel([
      entry({ name: 'mistral-7b', file: 'llm/mistral-7b.gguf', path: 'M', size: 100 }),
      entry({ name: 'qwen3-1.7b', file: 'llm/qwen3-1.7b-Q4_K_M.gguf', path: 'S', size: 50 }),
      entry({ name: 'qwen3-4b-instruct', file: 'llm/qwen3-4b-instruct-Q4_K_M.gguf', path: 'L', size: 90 }),
    ])
    expect(picked).toBe('L')
  })

  it('无候选返回 undefined', () => {
    expect(pickEnhancerModel([])).toBeUndefined()
    expect(pickEnhancerModel([entry({ name: 'x', file: 'diffusion/x.gguf', path: 'D' })])).toBeUndefined()
  })
})

describe('extractEnhanceJson', () => {
  it('裸 JSON 解析', () => {
    expect(extractEnhanceJson('{"positive":"a cat, detailed","negative":"blurry"}')).toEqual({
      positive: 'a cat, detailed',
      negative: 'blurry',
    })
  })
  it('容忍 ```json 包裹与前后杂文', () => {
    const text = '好的，以下是结果：\n```json\n{"positive":"a dog"}\n```\n希望有帮助'
    expect(extractEnhanceJson(text)).toEqual({ positive: 'a dog' })
  })
  it('非 JSON / 缺 positive 返回 null', () => {
    expect(extractEnhanceJson('no json here')).toBeNull()
    expect(extractEnhanceJson('{"negative":"x"}')).toBeNull()
    expect(extractEnhanceJson('{"positive":"  "}')).toBeNull()
  })
})

describe('enhancePrompt 三级降级', () => {
  it('LLM JSON 成功 → source=llm', async () => {
    const chat = vi.fn(async () => '{"positive":"a cyberpunk city at night, neon","negative":"blurry"}')
    const r = await enhancePrompt({ text: '赛博朋克城市夜景' }, { chat })
    expect(r.source).toBe('llm')
    expect(r.positive).toBe('a cyberpunk city at night, neon')
    expect(r.negative).toBe('blurry')
  })

  it('LLM 失败 → 查表直译 → source=table', async () => {
    const chat = vi.fn(async () => {
      throw new Error('no llama')
    })
    const r = await enhancePrompt({ text: '一只猫' }, { chat, lookupZh: (zh) => (zh === '一只猫' ? 'a cat' : undefined) })
    expect(r.source).toBe('table')
    expect(r.positive).toBe('a cat')
  })

  it('LLM 失败且无查表 → 原文兜底 source=raw', async () => {
    const chat = vi.fn(async () => {
      throw new Error('no llama')
    })
    const r = await enhancePrompt({ text: '夕阳下的海滩' }, { chat })
    expect(r.source).toBe('raw')
    expect(r.positive).toBe('夕阳下的海滩')
  })

  it('LLM 回复非 JSON 短文本 → 当作提示词采用', async () => {
    const chat = vi.fn(async () => 'a serene mountain lake at dawn, soft light, highly detailed')
    const r = await enhancePrompt({ text: '山湖清晨' }, { chat })
    expect(r.source).toBe('llm')
    expect(r.positive).toContain('mountain lake')
  })

  it('空输入直接原文兜底', async () => {
    const chat = vi.fn()
    const r = await enhancePrompt({ text: '  ' }, { chat })
    expect(r.source).toBe('raw')
    expect(chat).not.toHaveBeenCalled()
  })
})

describe('createLlamaChat', () => {
  it('POST chat/completions 并提取 message.content', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"positive":"p"}' } }] }), { status: 200 }),
    )
    const chat = createLlamaChat({
      resolveChatUrl: async () => 'http://127.0.0.1:11435/v1/chat/completions',
      fetchImpl: fetchImpl as never,
    })
    const out = await chat([{ role: 'user', content: 'hi' }])
    expect(out).toBe('{"positive":"p"}')
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11435/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('非 2xx 抛错（由 enhancePrompt 降级）', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const chat = createLlamaChat({ resolveChatUrl: async () => 'http://127.0.0.1:9/x', fetchImpl: fetchImpl as never })
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/)
  })
})
