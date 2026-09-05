/**
 * PromptEnhancer（阶段1）— 本地小模型"思考"层：把中文口语/关键词扩写为
 * 适配合图模型的专业英文提示词，再交给画图模型。
 *
 * 数据流：中文描述 → llama-server /v1/chat/completions（非流式，一次完成）
 *   → JSON {positive, negative} → ImageQueue job.enhancedPrompt → sd img_gen。
 *
 * 兜底链：
 *   1. LLM 可用 → 结构化扩写（Qwen3-4B 级质量）；
 *   2. LLM 失败/未配置 → zh2en 查表直译（prompt-weaver 数据，纯本地）；
 *   3. 都失败 → 原文直出（Z-Image 原生中文理解可兜住）。
 *
 * 设计约束：扩写模型与画图模型在 8GB 显存上必须串行——enhance 侧车默认以
 * CPU 层（-ngl 0）启动，零显存占用；若 llama 已在运行（聊天中）则直接复用，
 * 不重启不打断会话。
 *
 * MIT, 无 AGPL.
 */

import type { ModelEntry } from '../models/registry'

// ---------------------------------------------------------------------------
// 模型解析 — models/llm/** 目录约定（README「模型文件夹」）
// ---------------------------------------------------------------------------

export const LLM_DIR_PREFIX = 'llm/'

/** 简单否定/嵌入命名黑名单 — 不选 embedding/rerank/bge 等非对话模型 */
const LLM_NAME_EXCLUDE =
  /embed(ding|ings|s|ed)?|rerank|\bbge\b|clip|whisper|tts|vl\b|mmproj/i

/**
 * 从注册表挑选扩写用对话模型：
 * - 仅 llm/ 目录下未损坏 gguf 且不命中排除名单；
 * - requested 给出时优先名称/路径子串匹配；
 * - 否则偏好 qwen（中文最好），同前缀取较大者（4B > 1.7B，Q8 > Q4）；
 * - 找不到返回 undefined（调用方降级查表直译）。
 */
export function pickEnhancerModel(entries: readonly ModelEntry[], requested?: string): string | undefined {
  const candidates = entries.filter(
    (e) =>
      !e.corrupted &&
      e.format === 'gguf' &&
      e.file.toLowerCase().startsWith(LLM_DIR_PREFIX) &&
      !LLM_NAME_EXCLUDE.test(e.name),
  )
  if (candidates.length === 0) return undefined
  if (requested !== undefined && requested.trim() !== '') {
    const needle = requested.trim().toLowerCase()
    const matched = candidates.filter(
      (e) => e.name.toLowerCase().includes(needle) || e.file.toLowerCase().includes(needle),
    )
    if (matched.length > 0) return matched[0]!.path
  }
  const score = (e: ModelEntry): number => {
    let s = 0
    if (/qwen/i.test(e.name)) s += 4
    if (/instruct|chat|sft/i.test(e.name)) s += 2
    // 同级内取大（量化更高），跨档不贪大（避免 >8B 拖慢扩写）
    const mb = e.size / (1024 * 1024)
    s += mb >= 1024 && mb <= 3200 ? 1 : 0
    return s
  }
  return [...candidates].sort((a, b) => score(b) - score(a) || b.size - a.size)[0]!.path
}

// ---------------------------------------------------------------------------
// 提示词扩写
// ---------------------------------------------------------------------------

/** 扩写 system prompt：结构化输出 + 画图模型适配规则 */
export const ENHANCER_SYSTEM_PROMPT = `你是专业的 AI 绘画提示词工程师。用户会用中文口语描述想画的画面，你把它改写为给本地文生图模型（stable-diffusion.cpp，支持 Z-Image/SDXL/Flux）的英文提示词。

规则：
1. 只输出一个 JSON 对象，格式：{"positive": "...", "negative": "..."}，不要任何解释、代码块或多余文字。
2. positive：1-2 句流畅的英文画面描述（主体+动作+环境+光影+构图），后接逗号分隔的质量与风格词（如 masterpiece, best quality, highly detailed, cinematic lighting）。保留用户的具体意图，不添加用户没提的主体。
3. negative：固定的负面提示词，如 "lowres, bad anatomy, bad hands, blurry, watermark, signature, jpeg artifacts, worst quality, low quality"。
4. 用户描述很简短（几个词）时，合理补全环境与光影，但不改变主体。
5. 用户用中文描述就理解为中文；如果用户直接给的是英文提示词，保持原意并优化即可。`

export type EnhanceInput = {
  /** 用户原始输入（中文口语/关键词/任意语言） */
  text: string
  /** 可选风格倾向（如 "写实/动漫/水彩"），将并入指令 */
  style?: string
}

export type EnhanceResult = {
  positive: string
  negative?: string
  /** 扩写来源：llm=本地模型 / table=zh2en 查表 / raw=原文兜底 */
  source: 'llm' | 'table' | 'raw'
}

export type EnhanceDeps = {
  /**
   * 一次对话完成调用（非流式）。返回助手回复文本。
   * 抛错即降级（查表 → 原文）。
   */
  chat: (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>
  /** zh2en 查表直译兜底（prompt-weaver 数据，纯本地；允许异步懒加载） */
  lookupZh?: (zh: string) => string | undefined | Promise<string | undefined>
  /** 单测注入 fetch 等 */
}

/** 从模型回复中稳健提取 JSON（容忍 ```json 包裹 / 前后杂文） */
export function extractEnhanceJson(text: string): { positive: string; negative?: string } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (typeof obj['positive'] === 'string' && obj['positive'].trim() !== '') {
      return {
        positive: obj['positive'].trim(),
        ...(typeof obj['negative'] === 'string' && obj['negative'].trim() !== ''
          ? { negative: obj['negative'].trim() }
          : {}),
      }
    }
  } catch {
    /* fallthrough */
  }
  return null
}

/**
 * 主入口：中文一句话 → 专业英文提示词。永不抛错（失败降级）。
 */
export async function enhancePrompt(input: EnhanceInput, deps: EnhanceDeps): Promise<EnhanceResult> {
  const text = input.text.trim()
  if (text === '') return { positive: '', source: 'raw' }

  // 1) LLM 扩写
  try {
    const userMsg =
      (input.style !== undefined && input.style.trim() !== '' ? `风格倾向：${input.style.trim()}\n` : '') +
      `画面描述：${text}`
    const reply = await deps.chat([
      { role: 'system', content: ENHANCER_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ])
    const parsed = extractEnhanceJson(reply)
    if (parsed !== null) {
      return { positive: parsed.positive, ...(parsed.negative === undefined ? {} : { negative: parsed.negative }), source: 'llm' }
    }
    // 非 JSON 但有内容：当作纯英文提示词采用（小模型偶发不听 JSON 指令）
    const trimmed = reply.trim()
    if (trimmed !== '' && trimmed.length <= 1200) {
      return { positive: trimmed, source: 'llm' }
    }
  } catch {
    /* fallthrough to table */
  }

  // 2) zh2en 查表直译（整句 → 逐词拼接）
  if (deps.lookupZh !== undefined) {
    const whole = await deps.lookupZh(text)
    if (whole !== undefined && whole.trim() !== '') return { positive: whole.trim(), source: 'table' }
    const parts = text
      .split(/[，,。.、\s]+/)
      .map((p) => p.trim())
      .filter((p) => p !== '')
    const translated = (
      await Promise.all(parts.map(async (p) => deps.lookupZh?.(p)))
    )
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (translated.length > 0) {
      return { positive: translated.join(', '), source: 'table' }
    }
  }

  // 3) 原文兜底
  return { positive: text, source: 'raw' }
}

// ---------------------------------------------------------------------------
// 主进程侧组装 — llama-server 一次对话调用
// ---------------------------------------------------------------------------

export type EnhanceLlamaDeps = {
  /**
   * 解析本次扩写的 /v1/chat/completions 端点（由 services 提供）：
   * llama 已在运行（聊天中）→ 复用其端口；否则以 CPU 层加载扩写模型后返回
   * 端口。解析失败抛错 → enhancePrompt 统一降级。
   */
  resolveChatUrl: () => Promise<string>
  fetchImpl?: typeof globalThis.fetch
  maxTokens?: number
}

/**
 * 构建 EnhanceDeps.chat：主进程注入 services 后调用。
 * 失败抛错由 enhancePrompt 统一降级。
 */
export function createLlamaChat(deps: EnhanceLlamaDeps): EnhanceDeps['chat'] {
  const doFetch = deps.fetchImpl ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init))
  const maxTokens = deps.maxTokens ?? 300
  return async (messages) => {
    const url = await deps.resolveChatUrl()
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: false, max_tokens: maxTokens, temperature: 0.7 }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`enhancer chat failed ${res.status} ${t}`.trim())
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') throw new Error('enhancer: empty completion')
    return content
  }
}
