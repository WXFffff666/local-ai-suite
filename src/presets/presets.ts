/**
 * presets.ts — Wave7 T36
 * 3 对话预设 + 2 生图风格预设，开箱演示思考与生图，点击自动填充
 * MIT, 无 AGPL。纯常量 + 纯函数，无副作用，易测试。
 */

export type PresetKind = 'chat' | 'image'

// ---------------------------------------------------------------------------
// 对话预设
// ---------------------------------------------------------------------------

export type ChatPreset = {
  kind: 'chat'
  id: string
  title: string
  description: string
  prompt: string
  /** 推荐 reasoning_effort，透传给 Thinking / chat 请求 */
  reasoningEffort?: 'low' | 'medium' | 'high'
  tags?: string[]
}

export type ImageStylePreset = {
  kind: 'image'
  id: string
  title: string
  description: string
  /** 正向 prompt */
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  style?: string
  tags?: string[]
}

export type AnyPreset = ChatPreset | ImageStylePreset

// ---------------------------------------------------------------------------
// 5 个预设常量（3 chat + 2 image）— 直接导出，供 UI 点击填充与测试断言
// ---------------------------------------------------------------------------

/** 对话预设 1：思考演示 — 触发 Thinking 折叠流式 + reasoning_content 透传 */
export const CHAT_PRESET_THINKING_DEMO: ChatPreset = {
  kind: 'chat',
  id: 'chat-thinking-demo',
  title: '思考演示',
  description: '演示推理模型思考过程折叠与流式透传',
  prompt:
    '请逐步思考并解决：鸡兔同笼，共有 35 个头、94 只脚，鸡和兔各多少只？要求先展示思考过程，再给出答案。',
  reasoningEffort: 'high',
  tags: ['thinking', 'demo', 'reasoning'],
}

/** 对话预设 2：代码 Review — 演示长上下文 + 结构化思考 */
export const CHAT_PRESET_CODE_REVIEW: ChatPreset = {
  kind: 'chat',
  id: 'chat-code-review',
  title: '代码 Review',
  description: '让模型以思考模式 review 代码并给出优化建议',
  prompt:
    '请 review 下面这段 TypeScript 代码，逐步思考潜在的边界条件、性能与可读性问题，然后给出重构建议：\n```ts\nfunction sum(a: number, b: number) { return a + b }\n```',
  reasoningEffort: 'medium',
  tags: ['code', 'review', 'thinking'],
}

/** 对话预设 3：创意写作 — 轻量思考 / 无需高强度推理 */
export const CHAT_PRESET_CREATIVE_WRITE: ChatPreset = {
  kind: 'chat',
  id: 'chat-creative-write',
  title: '创意写作',
  description: '科幻短篇开箱预设，演示普通对话填充',
  prompt: '以“最后一座离线图书馆”为题，写一个 300 字左右的科幻短篇，氛围温暖克制。',
  reasoningEffort: 'low',
  tags: ['creative', 'writing'],
}

/** 生图风格预设 1：吉卜力/二次元 — 演示生图 prompt 一键填充 */
export const IMAGE_PRESET_ANIME_GHIBLI: ImageStylePreset = {
  kind: 'image',
  id: 'image-anime-ghibli',
  title: '吉卜力风格',
  description: '柔光二次元，适合人物与风景',
  prompt: 'a cozy street in spring, ghibli style, soft light, warm colors, highly detailed, anime illustration',
  negativePrompt: 'blurry, low quality, extra limbs, distorted face, text, watermark',
  width: 768,
  height: 512,
  steps: 20,
  cfgScale: 7,
  style: 'anime',
  tags: ['anime', 'ghibli', 'illustration'],
}

/** 生图风格预设 2：超写实摄影 — 演示另一风格 + 更高 steps */
export const IMAGE_PRESET_PHOTO_REAL: ImageStylePreset = {
  kind: 'image',
  id: 'image-photo-real',
  title: '超写实摄影',
  description: '8K 自然光摄影，适合产品与人像',
  prompt: 'ultra photorealistic portrait of a young architect in a sunlit studio, 8k, natural light, shallow depth of field, highly detailed skin texture',
  negativePrompt: 'cartoon, anime, illustration, over-saturated, blurry, lowres, jpeg artifacts',
  width: 512,
  height: 768,
  steps: 28,
  cfgScale: 7.5,
  style: 'photographic',
  tags: ['photo', 'realistic', '8k'],
}

// 聚合数组 — 便于 UI 渲染
export const CHAT_PRESETS: readonly ChatPreset[] = [
  CHAT_PRESET_THINKING_DEMO,
  CHAT_PRESET_CODE_REVIEW,
  CHAT_PRESET_CREATIVE_WRITE,
] as const

export const IMAGE_PRESETS: readonly ImageStylePreset[] = [
  IMAGE_PRESET_ANIME_GHIBLI,
  IMAGE_PRESET_PHOTO_REAL,
] as const

export const ALL_PRESETS: readonly AnyPreset[] = [...CHAT_PRESETS, ...IMAGE_PRESETS] as const

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

const CHAT_MAP = new Map<string, ChatPreset>(CHAT_PRESETS.map((p) => [p.id, p]))
const IMAGE_MAP = new Map<string, ImageStylePreset>(IMAGE_PRESETS.map((p) => [p.id, p]))
const ALL_MAP = new Map<string, AnyPreset>(ALL_PRESETS.map((p) => [p.id, p]))

export function getChatPreset(id: string): ChatPreset | undefined {
  return CHAT_MAP.get(id)
}

export function getImagePreset(id: string): ImageStylePreset | undefined {
  return IMAGE_MAP.get(id)
}

export function getPreset(id: string): AnyPreset | undefined {
  return ALL_MAP.get(id)
}

// ---------------------------------------------------------------------------
// 填充逻辑 — 点击预设自动填充到对应输入
// ---------------------------------------------------------------------------

export type ChatFillResult = {
  kind: 'chat'
  prompt: string
  reasoningEffort?: string
  presetId: string
  title: string
}

export type ImageFillResult = {
  kind: 'image'
  prompt: string
  negativePrompt?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  style?: string
  presetId: string
  title: string
}

export type FillResult = ChatFillResult | ImageFillResult

/** 将对话预设转为填充数据（纯函数，不操作 DOM/store） */
export function fillChatPreset(preset: ChatPreset | string): ChatFillResult | null {
  const p = typeof preset === 'string' ? getChatPreset(preset) : preset
  if (!p) return null
  return {
    kind: 'chat',
    prompt: p.prompt,
    reasoningEffort: p.reasoningEffort,
    presetId: p.id,
    title: p.title,
  }
}

/** 将生图预设转为填充数据（纯函数） */
export function fillImagePreset(preset: ImageStylePreset | string): ImageFillResult | null {
  const p = typeof preset === 'string' ? getImagePreset(preset) : preset
  if (!p) return null
  return {
    kind: 'image',
    prompt: p.prompt,
    negativePrompt: p.negativePrompt,
    width: p.width,
    height: p.height,
    steps: p.steps,
    cfgScale: p.cfgScale,
    style: p.style,
    presetId: p.id,
    title: p.title,
  }
}

/** 通用填充：任意 id → FillResult | null */
export function fillPreset(id: string): FillResult | null {
  const p = getPreset(id)
  if (!p) return null
  if (p.kind === 'chat') return fillChatPreset(p as ChatPreset)
  return fillImagePreset(p as ImageStylePreset)
}

/**
 * 点击自动填充 — 适配 UI 的一站式调用
 * 传入 setChatInput / setImagePrompt 等回调，内部按 kind 分发
 * 返回是否命中预设
 */
export function applyPreset(
  id: string,
  handlers: {
    onChatFill?: (data: ChatFillResult) => void
    onImageFill?: (data: ImageFillResult) => void
    /** 兼容单一回调，按 FillResult 分流 */
    onFill?: (data: FillResult) => void
  },
): boolean {
  const result = fillPreset(id)
  if (!result) return false
  if (result.kind === 'chat') {
    handlers.onChatFill?.(result)
  } else {
    handlers.onImageFill?.(result)
  }
  handlers.onFill?.(result)
  return true
}

/**
 * 便捷：生成 click handler，适用于 <button onClick={createPresetClickHandler(id, handlers)}>
 */
export function createPresetClickHandler(
  id: string,
  handlers: {
    onChatFill?: (data: ChatFillResult) => void
    onImageFill?: (data: ImageFillResult) => void
    onFill?: (data: FillResult) => void
  },
): () => boolean {
  return () => applyPreset(id, handlers)
}

/** 是否为对话预设 id */
export function isChatPresetId(id: string): boolean {
  return CHAT_MAP.has(id)
}

/** 是否为生图预设 id */
export function isImagePresetId(id: string): boolean {
  return IMAGE_MAP.has(id)
}
