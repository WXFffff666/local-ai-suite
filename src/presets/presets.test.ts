import { describe, it, expect, vi } from 'vitest'
import {
  CHAT_PRESET_THINKING_DEMO,
  CHAT_PRESET_CODE_REVIEW,
  CHAT_PRESET_CREATIVE_WRITE,
  IMAGE_PRESET_ANIME_GHIBLI,
  IMAGE_PRESET_PHOTO_REAL,
  CHAT_PRESETS,
  IMAGE_PRESETS,
  ALL_PRESETS,
  getChatPreset,
  getImagePreset,
  getPreset,
  fillChatPreset,
  fillImagePreset,
  fillPreset,
  applyPreset,
  createPresetClickHandler,
  isChatPresetId,
  isImagePresetId,
} from './presets'

describe('presets — 3对话+2生图常量', () => {
  it('导出 5 个预设常量且 kind/id 正确', () => {
    expect(CHAT_PRESET_THINKING_DEMO.kind).toBe('chat')
    expect(CHAT_PRESET_THINKING_DEMO.id).toBe('chat-thinking-demo')
    expect(CHAT_PRESET_CODE_REVIEW.id).toBe('chat-code-review')
    expect(CHAT_PRESET_CREATIVE_WRITE.id).toBe('chat-creative-write')
    expect(IMAGE_PRESET_ANIME_GHIBLI.kind).toBe('image')
    expect(IMAGE_PRESET_ANIME_GHIBLI.id).toBe('image-anime-ghibli')
    expect(IMAGE_PRESET_PHOTO_REAL.id).toBe('image-photo-real')
  })

  it('CHAT_PRESETS 长度 3，IMAGE_PRESETS 长度 2，ALL 5', () => {
    expect(CHAT_PRESETS.length).toBe(3)
    expect(IMAGE_PRESETS.length).toBe(2)
    expect(ALL_PRESETS.length).toBe(5)
  })

  it('每个预设都有 title/prompt/description 且 prompt 非空', () => {
    for (const p of ALL_PRESETS) {
      expect(p.title.trim().length).toBeGreaterThan(0)
      expect(p.prompt.trim().length).toBeGreaterThan(10)
      expect(p.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('对话预设含 reasoningEffort，生图预设含尺寸与 style', () => {
    expect(CHAT_PRESET_THINKING_DEMO.reasoningEffort).toBe('high')
    expect(CHAT_PRESET_CODE_REVIEW.reasoningEffort).toBe('medium')
    expect(CHAT_PRESET_CREATIVE_WRITE.reasoningEffort).toBe('low')
    expect(IMAGE_PRESET_ANIME_GHIBLI.width).toBeGreaterThan(0)
    expect(IMAGE_PRESET_ANIME_GHIBLI.height).toBeGreaterThan(0)
    expect(IMAGE_PRESET_ANIME_GHIBLI.style).toBeTruthy()
    expect(IMAGE_PRESET_PHOTO_REAL.steps).toBeGreaterThan(0)
    expect(IMAGE_PRESET_PHOTO_REAL.negativePrompt).toBeTruthy()
  })

  it('思考演示预设覆盖 thinking 透传场景', () => {
    expect(CHAT_PRESET_THINKING_DEMO.prompt).toMatch(/思考过程|逐步思考/)
    expect(CHAT_PRESET_THINKING_DEMO.tags).toContain('thinking')
  })

  it('id 唯一不重复', () => {
    const ids = ALL_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('查询 helpers', () => {
  it('getChatPreset / getImagePreset / getPreset', () => {
    expect(getChatPreset('chat-thinking-demo')?.title).toBe('思考演示')
    expect(getImagePreset('image-anime-ghibli')?.title).toBe('吉卜力风格')
    expect(getPreset('chat-code-review')?.kind).toBe('chat')
    expect(getPreset('image-photo-real')?.kind).toBe('image')
    expect(getPreset('not-exist')).toBeUndefined()
    expect(getChatPreset('image-anime-ghibli')).toBeUndefined()
  })

  it('isChatPresetId / isImagePresetId', () => {
    expect(isChatPresetId('chat-thinking-demo')).toBe(true)
    expect(isImagePresetId('image-anime-ghibli')).toBe(true)
    expect(isChatPresetId('image-anime-ghibli')).toBe(false)
    expect(isImagePresetId('unknown')).toBe(false)
  })
})

describe('填充逻辑 — 点击自动填充', () => {
  it('fillChatPreset 返回 ChatFillResult', () => {
    const r = fillChatPreset('chat-thinking-demo')!
    expect(r.kind).toBe('chat')
    expect(r.prompt).toBe(CHAT_PRESET_THINKING_DEMO.prompt)
    expect(r.reasoningEffort).toBe('high')
    expect(r.presetId).toBe('chat-thinking-demo')
    // 传入对象也可用
    const r2 = fillChatPreset(CHAT_PRESET_CODE_REVIEW)!
    expect(r2.prompt).toContain('review')
    expect(fillChatPreset('not-exist')).toBeNull()
  })

  it('fillImagePreset 返回 ImageFillResult 含生图参数', () => {
    const r = fillImagePreset('image-anime-ghibli')!
    expect(r.kind).toBe('image')
    expect(r.prompt).toBe(IMAGE_PRESET_ANIME_GHIBLI.prompt)
    expect(r.width).toBe(768)
    expect(r.height).toBe(512)
    expect(r.negativePrompt).toBeTruthy()
    expect(r.style).toBe('anime')
    const r2 = fillImagePreset(IMAGE_PRESET_PHOTO_REAL)!
    expect(r2.steps).toBe(28)
    expect(fillImagePreset('unknown')).toBeNull()
  })

  it('fillPreset 通用分发', () => {
    expect(fillPreset('chat-creative-write')?.kind).toBe('chat')
    expect(fillPreset('image-photo-real')?.kind).toBe('image')
    expect(fillPreset('nope')).toBeNull()
  })

  it('applyPreset 点击回调分发 chat/image/onFill', () => {
    const onChatFill = vi.fn()
    const onImageFill = vi.fn()
    const onFill = vi.fn()

    expect(applyPreset('chat-thinking-demo', { onChatFill, onImageFill, onFill })).toBe(true)
    expect(onChatFill).toHaveBeenCalledTimes(1)
    expect(onChatFill.mock.calls[0][0].presetId).toBe('chat-thinking-demo')
    expect(onImageFill).not.toHaveBeenCalled()
    expect(onFill).toHaveBeenCalledTimes(1)

    onChatFill.mockClear(); onFill.mockClear()
    expect(applyPreset('image-anime-ghibli', { onChatFill, onImageFill, onFill })).toBe(true)
    expect(onImageFill).toHaveBeenCalledTimes(1)
    expect(onImageFill.mock.calls[0][0].prompt).toBe(IMAGE_PRESET_ANIME_GHIBLI.prompt)
    expect(onChatFill).not.toHaveBeenCalled()

    expect(applyPreset('not-exist', { onChatFill })).toBe(false)
  })

  it('createPresetClickHandler 返回可点击函数', () => {
    const onChatFill = vi.fn()
    const handler = createPresetClickHandler('chat-code-review', { onChatFill })
    expect(typeof handler).toBe('function')
    const ok = handler()
    expect(ok).toBe(true)
    expect(onChatFill).toHaveBeenCalled()
    expect(onChatFill.mock.calls[0][0].reasoningEffort).toBe('medium')
  })

  it('applyPreset 模拟真实填充：setChatInput 收到 prompt', () => {
    let chatInput = ''
    let imagePrompt = ''
    applyPreset('chat-thinking-demo', {
      onChatFill: (d) => { chatInput = d.prompt },
    })
    expect(chatInput).toBe(CHAT_PRESET_THINKING_DEMO.prompt)

    applyPreset('image-photo-real', {
      onImageFill: (d) => { imagePrompt = d.prompt },
    })
    expect(imagePrompt).toBe(IMAGE_PRESET_PHOTO_REAL.prompt)
  })
})
