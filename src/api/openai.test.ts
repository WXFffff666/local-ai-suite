import { describe, it, expect, vi } from 'vitest'

import {
  OPENAI_HOST,
  OPENAI_PORT,
  OPENAI_BASE_URL,
  MODELS_PATH,
  CHAT_COMPLETIONS_PATH,
  EMBEDDINGS_PATH,
  handleOpenAiRequest,
  handleModels,
  handleChatCompletions,
  handleEmbeddings,
  createOpenAiHandler,
  createExpressMiddleware,
  createElysiaPlugin,
  createOpenAiServer,
  getModelsUrl,
  getChatCompletionsUrl,
  getEmbeddingsUrl,
  getOpenAiBaseUrl,
  isOllamaApiKey,
  extractApiKey,
  isAuthorized,
  openAiToOllama,
  openAiMessagesToPrompt,
  parseOllamaChatLine,
  ollamaChunkToOpenAIChunk,
} from './openai'

// helpers
function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })
}
function sseResponseFromNdjson(lines: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + '\n'))
      c.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}
async function collectSseText(res: Response): Promise<string> {
  const text = await res.text()
  return text
}

describe('openai constants — 127.0.0.1 invariant', () => {
  it('host/port/base 为 127.0.0.1:11434 且不暴露 wildcard', async () => {
    expect(OPENAI_HOST).toBe('127.0.0.1')
    expect(OPENAI_PORT).toBe(11434)
    expect(OPENAI_BASE_URL).toBe('http://127.0.0.1:11434')
    expect(getOpenAiBaseUrl()).toBe('http://127.0.0.1:11434/v1')
    expect(getModelsUrl()).toBe('http://127.0.0.1:11434/v1/models')
    expect(getChatCompletionsUrl()).toBe('http://127.0.0.1:11434/v1/chat/completions')
    expect(getEmbeddingsUrl()).toBe('http://127.0.0.1:11434/v1/embeddings')
    // 源码不应包含 wildcard 绑定
    const fs = await import('fs')
    const src = fs.readFileSync('src/api/openai.ts', 'utf-8')
    expect(src).not.toMatch(/0\.0\.0\.0/)
  })

  it('createOpenAiServer 拒绝非 127.0.0.1 host', () => {
    expect(() => createOpenAiServer({ host: '127.0.0.2' as never })).toThrow(/127\.0\.0\.1/)
  })
})

describe('auth — api_key=ollama 透传', () => {
  it('isOllamaApiKey 仅 ollama 通过', () => {
    expect(isOllamaApiKey('ollama')).toBe(true)
    expect(isOllamaApiKey('bad')).toBe(false)
    expect(isOllamaApiKey('')).toBe(false)
  })
  it('extractApiKey 支持 Bearer / x-api-key / query / url', () => {
    expect(extractApiKey({ headers: { authorization: 'Bearer ollama' } })).toBe('ollama')
    expect(extractApiKey({ headers: { 'x-api-key': 'ollama' } })).toBe('ollama')
    expect(extractApiKey({ query: { api_key: 'ollama' } as Record<string, string> })).toBe('ollama')
    expect(extractApiKey({ url: 'http://127.0.0.1:11434/v1/models?api_key=ollama' })).toBe('ollama')
    expect(extractApiKey({ headers: {} })).toBeUndefined()
  })
  it('isAuthorized 未携带放行，携带错误拒绝', () => {
    expect(isAuthorized({ headers: {} })).toBe(true)
    expect(isAuthorized({ headers: { authorization: 'Bearer ollama' } })).toBe(true)
    expect(isAuthorized({ headers: { authorization: 'Bearer wrong' } })).toBe(false)
  })
  it('handleOpenAiRequest 错误 api_key 返回 401', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/models', { headers: { authorization: 'Bearer wrong' } })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({ models: [] }) as never })
    expect(res!.status).toBe(401)
    const j = (await res!.json()) as { error: { message: string } }
    expect(j.error.message).toMatch(/ollama/)
  })
  it('正确 api_key 放行', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [] }))
    const req = new Request('http://127.0.0.1:11434/v1/models', { headers: { authorization: 'Bearer ollama' } })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
  })
  it('无 api_key 也放行', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [] }))
    const req = new Request('http://127.0.0.1:11434/v1/models')
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
  })
  it('query api_key 错误也 401', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/models?api_key=bad')
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({ models: [] }) as never })
    expect(res!.status).toBe(401)
  })
})

describe('GET /v1/models 转发到 Ollama/llama 127.0.0.1', () => {
  it('成功映射为 OpenAI {object:list,data:[{id,object:model,created,owned_by:local}]}', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [{ name: 'qwen3:4b', modified_at: '2024-01-01T00:00:00Z', size: 100, digest: 'abc' }] }),
    )
    const req = new Request('http://127.0.0.1:11434/v1/models')
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    const j = (await res!.json()) as { object: string; data: Array<{ id: string; object: string; owned_by: string }> }
    expect(j.object).toBe('list')
    expect(j.data[0].id).toBe('qwen3:4b')
    expect(j.data[0].object).toBe('model')
    expect(j.data[0].owned_by).toBe('local')
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/tags'), expect.anything())
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('127.0.0.1'), expect.anything())
  })
  it('空 models 返回空 data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [] }))
    const req = new Request('http://127.0.0.1:11434/v1/models/')
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    const j = (await res!.json()) as { data: unknown[] }
    expect(j.data).toEqual([])
  })
  it('Ollama 非 2xx 返回 502', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }))
    const req = new Request('http://127.0.0.1:11434/v1/models')
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(502)
  })
  it('handleModels 直接调用', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [{ name: 'a', model: 'a' }] }))
    const req = new Request('http://127.0.0.1:11434/v1/models')
    const res = await handleModels(req, { fetchImpl: fetchImpl as never })
    expect(res.status).toBe(200)
  })
  it('非 GET 返回 405', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/models', { method: 'POST' })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({ models: [] }) as never })
    expect(res!.status).toBe(405)
  })
})

describe('POST /v1/chat/completions — 非流式', () => {
  it('model/messages 校验 400', async () => {
    const req1 = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect((await handleOpenAiRequest(req1, { fetchImpl: async () => jsonResponse({}) as never }))!.status).toBe(400)
    const req2 = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    expect((await handleOpenAiRequest(req2, { fetchImpl: async () => jsonResponse({}) as never }))!.status).toBe(400)
  })

  it('非流式转发到 Ollama /api/chat 返回 OpenAI chat.completion', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain('/api/chat')
      expect(init.body).toContain('"stream":false')
      return jsonResponse({ message: { role: 'assistant', content: 'hello world' }, done: true })
    })
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    const j = (await res!.json()) as { id: string; object: string; choices: Array<{ message: { content: string }; finish_reason: string }> }
    expect(j.object).toBe('chat.completion')
    expect(j.id).toMatch(/^chatcmpl-/)
    expect(j.choices[0].message.content).toBe('hello world')
    expect(j.choices[0].finish_reason).toBe('stop')
  })

  it('非法 json 返回 400', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res!.status).toBe(400)
  })

  it('handleChatCompletions 直接调用非流式', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { role: 'assistant', content: 'ok' }, done: true }))
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    const res = await handleChatCompletions(req, { fetchImpl: fetchImpl as never })
    expect(res.status).toBe(200)
  })

  it('Ollama 失败回退到 llama /completion', async () => {
    let call = 0
    const fetchImpl = vi.fn(async (url: string) => {
      call++
      if (url.includes('/api/chat')) return new Response('err', { status: 500 })
      if (url.includes('/completion')) return jsonResponse({ content: 'llama answer', stop: true })
      return jsonResponse({})
    })
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    const j = (await res!.json()) as { choices: Array<{ message: { content: string } }> }
    expect(j.choices[0].message.content).toBe('llama answer')
    expect(call).toBeGreaterThanOrEqual(2)
  })
})

describe('POST /v1/chat/completions — SSE 流式 (含 DONE)', () => {
  it('stream:true 透传 Ollama NDJSON 转 SSE，每 chunk data: ... 终以 data: [DONE]', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponseFromNdjson([
        JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: ' world' }, done: false }),
        JSON.stringify({ done: true }),
      ]),
    )
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    expect(res!.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await collectSseText(res!)
    expect(text).toContain('data: ')
    expect(text).toContain('"delta"')
    expect(text).toContain('Hello')
    expect(text).toContain('data: [DONE]')
    // 必须以 DONE 结尾
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
  })

  it('默认 stream=false 时走非流式；显式 stream 未传按 false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { role: 'assistant', content: 'hi' }, done: true }))
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    expect(res!.headers.get('content-type')).toMatch(/application\/json/)
  })

  it('非法方法返回 405', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', { method: 'GET' })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res!.status).toBe(405)
  })

  it('openAiToOllama 映射 max_tokens->num_predict, stop 归一', () => {
    const out = openAiToOllama({ model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stop: '</s>' as never })
    expect(out.num_predict).toBe(100)
    expect(out.stop).toEqual(['</s>'])
  })

  it('parseOllamaChatLine / ollamaChunkToOpenAIChunk 单测', () => {
    expect(parseOllamaChatLine('{"message":{"role":"assistant","content":"tok"},"done":false}')?.done).toBe(false)
    expect(parseOllamaChatLine('data: [DONE]')).toBeNull()
    expect(parseOllamaChatLine('')).toBeNull()
    const c1 = ollamaChunkToOpenAIChunk({ message: { role: 'assistant', content: 'tok' }, done: false }, 'm', 'id1', 123)
    expect((c1['choices'] as Array<{ delta: { content: string } }>)[0].delta.content).toBe('tok')
    const c2 = ollamaChunkToOpenAIChunk({ done: true }, 'm', 'id1', 123)
    expect((c2['choices'] as Array<{ finish_reason: string }>)[0].finish_reason).toBe('stop')
  })

  it('openAiMessagesToPrompt 拼接', () => {
    const p = openAiMessagesToPrompt([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hello' },
    ])
    expect(p).toContain('System: you are helpful')
    expect(p).toContain('User: hello')
    expect(p).toContain('Assistant:')
  })
})

describe('POST /v1/embeddings 转发到 Ollama', () => {
  it('单 input 转 /api/embed 返回 OpenAI embeddings', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('127.0.0.1')
      return jsonResponse({ model: 'bge-m3', embeddings: [[0.1, 0.2, 0.3]] })
    })
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: 'hello' }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    const j = (await res!.json()) as { object: string; data: Array<{ embedding: number[]; index: number }>; model: string }
    expect(j.object).toBe('list')
    expect(j.data[0].embedding).toEqual([0.1, 0.2, 0.3])
    expect(j.data[0].index).toBe(0)
    expect(j.model).toBe('bge-m3')
  })

  it('批量 input 数组', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ model: 'bge-m3', embeddings: [[0.1], [0.2]] }))
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: ['a', 'b'] }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    const j = (await res!.json()) as { data: Array<{ index: number }> }
    expect(j.data).toHaveLength(2)
    expect(j.data[1].index).toBe(1)
  })

  it('兼容 Ollama embedding 单值 {embedding:[...]}', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ embedding: [0.4, 0.5] }))
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bge-m3', input: 'hi' }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: fetchImpl as never })
    const j = (await res!.json()) as { data: Array<{ embedding: number[] }> }
    expect(j.data[0].embedding).toEqual([0.4, 0.5])
  })

  it('model 缺失 400', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi' }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res!.status).toBe(400)
  })

  it('input 缺失 400', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm' }),
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res!.status).toBe(400)
  })

  it('非法 json 400', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'bad',
    })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res!.status).toBe(400)
  })

  it('非 POST 返回 405', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', { method: 'GET' })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res!.status).toBe(405)
  })

  it('handleEmbeddings 直接调用 /api/embeddings fallback 404 重试', async () => {
    let call = 0
    const fetchImpl = vi.fn(async (url: string) => {
      call++
      if (url.endsWith('/api/embed')) return new Response('not found', { status: 404 })
      return jsonResponse({ embedding: [0.1, 0.2] })
    })
    const req = new Request('http://127.0.0.1:11434/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'hi' }),
    })
    const res = await handleEmbeddings(req, { fetchImpl: fetchImpl as never })
    expect(res.status).toBe(200)
    expect(call).toBe(2)
  })
})

describe('路由 — 未命中与 createOpenAiHandler', () => {
  it('未知路径返回 null', async () => {
    const req = new Request('http://127.0.0.1:11434/v1/unknown', { method: 'GET' })
    const res = await handleOpenAiRequest(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res).toBeNull()
  })
  it('createOpenAiHandler 可挂载', async () => {
    const handler = createOpenAiHandler({ fetchImpl: async () => jsonResponse({ models: [] }) as never })
    const req = new Request('http://127.0.0.1:11434/v1/models')
    const res = await handler(req)
    expect(res!.status).toBe(200)
  })
})

describe('Express/Elysia 中间件转发', () => {
  it('Express 中间件命中 /v1/models 返回 json', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [{ name: 'm1', modified_at: '2024-01-01T00:00:00Z', size: 1, digest: 'd' }] }))
    const mw = createExpressMiddleware({ fetchImpl: fetchImpl as never })
    const json = vi.fn()
    const status = vi.fn(() => ({ json, status } as never))
    const res = { status, json, setHeader: vi.fn(), write: vi.fn(), end: vi.fn(), headersSent: false } as unknown as Parameters<typeof mw>[1]
    const next = vi.fn()
    await mw({ method: 'GET', url: '/v1/models', headers: { host: '127.0.0.1:11434' } }, res, next)
    expect(status).toHaveBeenCalledWith(200)
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ object: 'list' }))
    expect(next).not.toHaveBeenCalled()
  })
  it('Express 非命中路径走 next()', async () => {
    const mw = createExpressMiddleware({ fetchImpl: async () => jsonResponse({ models: [] }) as never })
    const res = { status: vi.fn(() => res as never), json: vi.fn(), setHeader: vi.fn(), write: vi.fn(), end: vi.fn() } as unknown as Parameters<typeof mw>[1]
    const next = vi.fn()
    await mw({ method: 'GET', url: '/health', headers: {} }, res, next)
    expect(next).toHaveBeenCalled()
  })
  it('Express chat stream SSE 写入', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponseFromNdjson([JSON.stringify({ message: { role: 'assistant', content: 'tok' }, done: false }), JSON.stringify({ done: true })]),
    )
    const mw = createExpressMiddleware({ fetchImpl: fetchImpl as never })
    const writes: string[] = []
    const res: Parameters<typeof mw>[1] = {
      status: vi.fn(() => res) as never,
      json: vi.fn() as never,
      setHeader: vi.fn(),
      write: vi.fn((c: string) => writes.push(c)),
      end: vi.fn(),
    }
    const next = vi.fn()
    // pre-parsed body via mw req.body
    await mw(
      { method: 'POST', url: '/v1/chat/completions', headers: { host: '127.0.0.1:11434', 'content-type': 'application/json' }, body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true } } as never,
      res,
      next,
    )
    expect(writes.join('')).toContain('data: ')
    expect(writes.join('')).toContain('data: [DONE]')
  })
  it('Elysia 插件注册 get/post 三路由', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/tags')) return jsonResponse({ models: [{ name: 'm', modified_at: '2024-01-01T00:00:00Z', size: 1, digest: 'd' }] })
      if (url.includes('/api/chat')) return jsonResponse({ message: { role: 'assistant', content: 'hi' }, done: true })
      if (url.includes('/api/embed')) return jsonResponse({ embeddings: [[0.1]] })
      return jsonResponse({})
    })
    const getCalls: string[] = []
    const postCalls: string[] = []
    const mockApp = {
      get: vi.fn((p: string) => { getCalls.push(p); return mockApp }),
      post: vi.fn((p: string) => { postCalls.push(p); return mockApp }),
    } as unknown as Parameters<ReturnType<typeof createElysiaPlugin>>[0]
    const plugin = createElysiaPlugin({ fetchImpl: fetchImpl as never })
    const ret = plugin(mockApp)
    expect(getCalls).toContain(MODELS_PATH)
    expect(postCalls).toContain(CHAT_COMPLETIONS_PATH)
    expect(postCalls).toContain(EMBEDDINGS_PATH)
    expect(ret).toBe(mockApp)
  })
  it('Elysia 插件 handler 可执行 (models)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [{ name: 'x', modified_at: '', size: 1, digest: 'd' }] }))
    const handlers: Record<string, (ctx: unknown) => Promise<unknown>> = {}
    const mockApp: Parameters<ReturnType<typeof createElysiaPlugin>>[0] = {
      get: vi.fn((p: string, h: (ctx: unknown) => Promise<unknown>) => { handlers[p] = h; return mockApp }) as never,
      post: vi.fn((p: string, h: (ctx: unknown) => Promise<unknown>) => { handlers[p] = h; return mockApp }) as never,
    }
    createElysiaPlugin({ fetchImpl: fetchImpl as never })(mockApp)
    const ctx = { request: new Request('http://127.0.0.1:11434/v1/models'), set: {} as Record<string, unknown> }
    const out = (await handlers[MODELS_PATH]!(ctx)) as { object: string }
    expect(out.object).toBe('list')
  })
})

describe('createOpenAiServer — 127.0.0.1 绑定', () => {
  it('端口越界抛错', () => {
    expect(() => createOpenAiServer({ port: 80 })).toThrow(/out of range/)
  })
  it('host 非 127.0.0.1 抛错', () => {
    expect(() => createOpenAiServer({ host: 'localhost' as never })).toThrow(/127\.0\.0\.1/)
  })
})
