/**
 * imageTool（阶段1）— 对话页"说画就画"：LLM 以 [[IMG:描述]] 标记表达画图意图，
 * store 在 chat:done 后解析标记 → image:generate（AI 润色开）→ 图片卡片回填会话。
 *
 * 模式对齐 Ollama web_search 的思路：模型用标记调用"工具"，宿主执行真实动作。
 * 描述统一交中文口语 → PromptEnhancer（enhance.ts）扩写 → sd img_gen。
 *
 * MIT, 无 AGPL.
 */

/** 画图标记系统提示词（发送时作为 system 消息前插，只影响本轮） */
export const IMAGE_TOOL_SYSTEM_PROMPT = `你可以调用画图工具生成本地图片。当用户想要生成/画一张图片时（如"画一张…""生成…的图"），在回复中输出一个标记，格式如下（单独一行）：
[[IMG:对画面的中文描述，尽量具体]]
规则：
1. 标记里只写画面描述（主体+场景+风格+光影），不要写"一张图片"之类的元话语。
2. 用户想要多张图时输出多个标记。
3. 输出标记后，用一句话自然地确认（如"已开始为你绘制"）。不要假装图片已经显示。
4. 与画图无关的正常问题照常回答，不要输出标记。`

export const IMAGE_MARK_RE = /\[\[IMG:([\s\S]{1,2000}?)\]\]/g

/** 从完整文本中提取全部画图标记，返回标记列表与剔除标记后的正文 */
export function extractImageMarks(text: string): { marks: string[]; clean: string } {
  const marks: string[] = []
  const clean = text.replace(IMAGE_MARK_RE, (_m, desc: string) => {
    const d = String(desc).trim()
    if (d !== '') marks.push(d)
    return ''
  })
  return { marks, clean: clean.trim() }
}

/**
 * 等待一个生图 job 终态并返回结果（dataURL 或抛错）。
 * 订阅 image:queue:status，匹配 jobId，done → image:queue:status 拉终态。
 */
export type ImageJobApi = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (payload: { jobId?: string; type?: string }) => void) => () => void
}

/** 宽化 ChatIpcApi（受限通道联合）→ ImageJobApi 的适配器 */
export function asImageJobApi(api: unknown): ImageJobApi {
  const a = api as {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    on: (channel: string, listener: (payload: { jobId?: string; type?: string }) => void) => () => void
  }
  return {
    invoke: (channel, ...args) => a.invoke(channel, ...args),
    on: (channel, listener) => a.on(channel, listener as never),
  }
}

export function runImageJob(
  api: ImageJobApi,
  prompt: string,
  opts: { enhance?: boolean } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let jobId: string | null = null
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      off()
      fn()
    }
    const off = api.on('image:queue:status', (ev) => {
      if (jobId === null || ev.jobId !== jobId) return
      if (ev.type === 'failed') {
        void (api.invoke('image:queue:status', { jobId }) as Promise<{ job?: { error?: string } }>)
          .then((st) => finish(() => reject(new Error(st.job?.error ?? '生成失败'))))
          .catch(() => finish(() => reject(new Error('生成失败'))))
      }
      if (ev.type === 'cancelled') finish(() => reject(new Error('已取消')))
      if (ev.type === 'done') {
        void (api.invoke('image:queue:status', { jobId }) as Promise<{ job?: { result?: { b64?: string } } }>)
          .then((st) => {
            const b64 = st.job?.result?.b64
            if (typeof b64 === 'string' && b64.startsWith('iVBOR')) {
              finish(() => resolve(`data:image/png;base64,${b64}`))
            } else {
              finish(() => reject(new Error('生成结果不是 PNG')))
            }
          })
          .catch(() => finish(() => reject(new Error('结果获取失败'))))
      }
    })
    void (api.invoke('image:generate', { prompt, enhance: opts.enhance ?? true }) as Promise<{ ok?: boolean; jobId?: string; error?: string; issues?: { message: string }[] }>)
      .then((reply) => {
        if (reply?.ok && reply.jobId) {
          jobId = reply.jobId
          return
        }
        const detail = reply?.issues?.map((i) => i.message).join('; ')
        finish(() => reject(new Error(detail || reply?.error || '生成请求被拒绝')))
      })
      .catch((e: unknown) => finish(() => reject(new Error(e instanceof Error ? e.message : String(e)))))
  })
}
