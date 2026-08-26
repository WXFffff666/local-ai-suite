import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

import {
  OLLAMA_HOST,
  OLLAMA_PORT,
  OLLAMA_HEALTH_URL,
  OLLAMA_CHAT_URL,
  OLLAMA_TAGS_URL,
  OLLAMA_PS_URL,
  OLLAMA_NAME,
  OLLAMA_LOG_FILE,
  OLLAMA_API_KEY,
  DEFAULT_OLLAMA_BIN,
  DEFAULT_MODELS_DIR,
  resolveOllamaBin,
  resolveOllamaModelsDir,
  getOllamaHostEnv,
  buildOllamaArgs,
  getHealthUrl,
  getChatUrl,
  getTagsUrl,
  getPsUrl,
  createOllamaSidecarConfig,
  createOllamaSidecar,
  getOllamaEnvForSpawn,
  isOllamaApiKey,
  extractApiKey,
  isAuthorized,
  createOllamaAuthMiddleware,
  listTags,
  listRunning,
  checkOllamaHealth,
  parseOllamaChatLine,
  streamChat,
  chat,
  openAiToOllama,
  ollamaChunkToOpenAI,
  forwardToOllama,
  createOllamaMiddleware,
  OllamaSidecar,
} from './ollama'

function mockChildProcess(overrides: Partial<Record<string, unknown>> = {}) {
  const ee = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; exitCode: number | null; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter }
  ee.pid = 4242
  ee.killed = false
  ee.exitCode = null
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.kill = vi.fn(() => { ee.killed = true; ee.exitCode = null; return true })
  Object.assign(ee, overrides)
  return ee
}
function makeFsMock() {
  const writes: string[] = []
  const fakeStream: Record<string, unknown> = { write: vi.fn((s: string) => writes.push(s)), end: vi.fn(), on: vi.fn() }
  return {
    writes, fakeStream,
    deps: {
      createWriteStream: vi.fn(() => fakeStream as unknown as ReturnType<typeof import('fs').createWriteStream>),
      statSync: vi.fn(() => ({ size: 0 }) as unknown as ReturnType<typeof import('fs').statSync>),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
  }
}
function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } })
}
function ndJsonResponseFromLines(lines: string[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(l + '\n')); c.close() } })
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

describe('ollama constants (host 127.0.0.1:11434, OLLAMA_MODELS=models/)', () => {
  it('常量符合 spec：127.0.0.1:11434 / health / chat / tags / ps / 日志 / bin / api_key', () => {
    expect(OLLAMA_HOST).toBe('127.0.0.1')
    expect(OLLAMA_PORT).toBe(11434)
    expect(OLLAMA_HEALTH_URL).toBe('http://127.0.0.1:11434/api/tags')
    expect(OLLAMA_CHAT_URL).toBe('http://127.0.0.1:11434/api/chat')
    expect(OLLAMA_TAGS_URL).toBe('http://127.0.0.1:11434/api/tags')
    expect(OLLAMA_PS_URL).toBe('http://127.0.0.1:11434/api/ps')
    expect(OLLAMA_NAME).toBe('ollama')
    expect(OLLAMA_LOG_FILE).toBe('sidecar-ollama.log')
    expect(DEFAULT_OLLAMA_BIN).toBe('ollama')
    expect(DEFAULT_MODELS_DIR).toBe('models')
    expect(OLLAMA_API_KEY).toBe('ollama')
  })
  it('getHealthUrl / getChatUrl / getTagsUrl / getPsUrl 默认与自定义端口', () => {
    expect(getHealthUrl()).toBe(OLLAMA_HEALTH_URL)
    expect(getChatUrl()).toBe(OLLAMA_CHAT_URL)
    expect(getTagsUrl()).toBe(OLLAMA_TAGS_URL)
    expect(getPsUrl()).toBe(OLLAMA_PS_URL)
    expect(getHealthUrl(12000)).toBe('http://127.0.0.1:12000/api/tags')
    expect(getChatUrl(12000)).toBe('http://127.0.0.1:12000/api/chat')
  })
  it('resolveOllamaBin — explicit > env > default', () => {
    expect(resolveOllamaBin('/custom/ollama')).toBe('/custom/ollama')
    const prev = process.env['OLLAMA_BIN']
    process.env['OLLAMA_BIN'] = '/env/bin/ollama'
    expect(resolveOllamaBin()).toBe('/env/bin/ollama')
    delete process.env['OLLAMA_BIN']
    expect(resolveOllamaBin()).toBe(DEFAULT_OLLAMA_BIN)
    if (prev !== undefined) process.env['OLLAMA_BIN'] = prev
  })
  it('resolveOllamaModelsDir — explicit > OLLAMA_MODELS env > cwd/models', () => {
    const prev = process.env['OLLAMA_MODELS']
    process.env['OLLAMA_MODELS'] = 'custom-models'
    // explicit wins
    expect(resolveOllamaModelsDir('/tmp/my-models')).toContain('my-models')
    // env
    expect(resolveOllamaModelsDir()).toContain('custom-models')
    delete process.env['OLLAMA_MODELS']
    expect(resolveOllamaModelsDir()).toContain('models')
    if (prev !== undefined) process.env['OLLAMA_MODELS'] = prev
    else delete process.env['OLLAMA_MODELS']
  })
  it('getOllamaHostEnv / getOllamaEnvForSpawn', () => {
    expect(getOllamaHostEnv()).toBe('127.0.0.1:11434')
    expect(getOllamaHostEnv(12000)).toBe('127.0.0.1:12000')
    const env = getOllamaEnvForSpawn(11434, 'models')
    expect(env['OLLAMA_HOST']).toBe('127.0.0.1:11434')
    expect(env['OLLAMA_MODELS']).toContain('models')
  })
})

describe('buildOllamaArgs', () => {
  it('默认产出 serve', () => {
    expect(buildOllamaArgs()).toEqual(['serve'])
  })
  it('extraArgs 透传', () => {
    expect(buildOllamaArgs({ extraArgs: ['--verbose'] })).toContain('--verbose')
  })
  it('host 非 127.0.0.1 抛错', () => {
    expect(() => buildOllamaArgs({ host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/)
  })
  it('port 越界抛错', () => {
    expect(() => buildOllamaArgs({ port: 80 })).toThrow(/out of range/)
  })
})

describe('createOllamaSidecarConfig / createOllamaSidecar (复用 SidecarManager)', () => {
  let fsMock: ReturnType<typeof makeFsMock>
  beforeEach(() => { vi.useFakeTimers(); fsMock = makeFsMock() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('config 校验：host 127.0.0.1 / port 11434 / healthUrl 正确 / OLLAMA_MODELS=models/', () => {
    const cfg = createOllamaSidecarConfig({ modelsDir: 'models' })
    expect(cfg.name).toBe('ollama')
    expect(cfg.bin).toBe(DEFAULT_OLLAMA_BIN)
    expect(cfg.port).toBe(11434)
    expect(cfg.healthUrl).toBe('http://127.0.0.1:11434/api/tags')
    expect(cfg.args).toContain('serve')
    expect(cfg.modelsDir).toContain('models')
  })
  it('SidecarManager 校验 — healthUrl 非 127.0.0.1 会被 Manager 拒绝', async () => {
    const { SidecarManager } = await import('../core/SidecarManager')
    expect(() => new SidecarManager({ name: 'bad', bin: 'bin', args: [], port: 11434, healthUrl: 'http://0.0.0.0:11434/api/tags' } as never, { fsDeps: fsMock.deps as never })).toThrow(/127\.0\.0\.1/)
  })
  it('createOllamaSidecar spawn 使用 ollama serve 且日志落盘 logs/sidecar-ollama.log', () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = createOllamaSidecar({ managerOptions: { spawner: spawner as never, fetcher: async () => true, fsDeps: fsMock.deps as never } })
    m.start()
    expect(spawner).toHaveBeenCalledWith('ollama', expect.arrayContaining(['serve']), expect.objectContaining({ stdio: expect.anything() }))
    const logCall = (fsMock.deps.createWriteStream as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(logCall).toContain('sidecar-ollama.log')
    expect(logCall).toContain('logs')
    expect(m.isRunning()).toBe(true)
    expect(m.getStatus().port).toBe(11434)
    expect(m.getStatus().healthUrl).toBe(OLLAMA_HEALTH_URL)
    m.stop()
  })
  it('OllamaManager env 合并：OLLAMA_HOST + OLLAMA_MODELS 注入 spawn env', () => {
    const proc = mockChildProcess()
    let capturedEnv: Record<string, string> | undefined
    const spawner = vi.fn((_bin: string, _args: string[], opts: Record<string, unknown>) => { capturedEnv = (opts.env as Record<string, string>); return proc as unknown as ReturnType<typeof import('child_process').spawn> })
    const m = createOllamaSidecar({ modelsDir: 'models', managerOptions: { spawner: spawner as never, fetcher: async () => true, fsDeps: fsMock.deps as never } })
    m.start()
    expect(capturedEnv?.['OLLAMA_HOST']).toBe('127.0.0.1:11434')
    expect(capturedEnv?.['OLLAMA_MODELS']).toContain('models')
    m.stop()
  })
  it('logPath 便捷访问与 restart 语义', () => {
    const proc1 = mockChildProcess({ pid: 111 } as never)
    const proc2 = mockChildProcess({ pid: 222 } as never)
    let call = 0
    const spawner = vi.fn(() => (call++ === 0 ? proc1 : proc2) as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = createOllamaSidecar({ managerOptions: { spawner: spawner as never, fetcher: async () => true, fsDeps: fsMock.deps as never } })
    expect(m.logPath).toContain('sidecar-ollama.log')
    m.start()
    expect(m.getStatus().restarts).toBe(0)
    m.restart()
    expect(spawner).toHaveBeenCalledTimes(2)
    expect(m.getStatus().restarts).toBe(1)
    m.stop()
  })
})

describe('api_key=ollama 兼容', () => {
  it('isOllamaApiKey 仅 ollama 通过', () => {
    expect(isOllamaApiKey('ollama')).toBe(true)
    expect(isOllamaApiKey('OLLAMA')).toBe(false)
    expect(isOllamaApiKey('')).toBe(false)
    expect(isOllamaApiKey(undefined)).toBe(false)
  })
  it('extractApiKey 支持 Bearer / x-api-key / api_key query / url', () => {
    expect(extractApiKey({ headers: { authorization: 'Bearer ollama' } })).toBe('ollama')
    expect(extractApiKey({ headers: { Authorization: 'Bearer ollama' } })).toBe('ollama')
    expect(extractApiKey({ headers: { 'x-api-key': 'ollama' } })).toBe('ollama')
    expect(extractApiKey({ headers: { 'api-key': 'ollama' } })).toBe('ollama')
    expect(extractApiKey({ query: { api_key: 'ollama' } as Record<string, string> })).toBe('ollama')
    expect(extractApiKey({ query: new URLSearchParams('api_key=ollama') })).toBe('ollama')
    expect(extractApiKey({ url: 'http://127.0.0.1:11434/api/tags?api_key=ollama' })).toBe('ollama')
    expect(extractApiKey({ headers: {} as Record<string, string> })).toBeUndefined()
  })
  it('isAuthorized 仅 ollama 放行', () => {
    expect(isAuthorized({ headers: { authorization: 'Bearer ollama' } })).toBe(true)
    expect(isAuthorized({ headers: { authorization: 'Bearer wrong' } })).toBe(false)
    expect(isAuthorized({ headers: {} as Record<string, string> })).toBe(false)
  })
  it('createOllamaAuthMiddleware — allowWithoutKey 与 401', () => {
    const strict = createOllamaAuthMiddleware()
    expect(strict.check({ authorization: 'Bearer ollama' })).toBe(true)
    expect(strict.check({ authorization: 'Bearer bad' })).toBe(false)
    expect(strict.check({})).toBe(false)
    const lax = createOllamaAuthMiddleware({ allowWithoutKey: true })
    expect(lax.check({})).toBe(true)
    // express-style
    const next = vi.fn()
    const res = strict.middleware({ headers: { authorization: 'Bearer bad' } } as never, {}, next)
    expect((res as { status: number })?.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
    strict.middleware({ headers: { authorization: 'Bearer ollama' } } as never, {}, next)
    expect(next).toHaveBeenCalled()
  })
})

describe('/api/tags /api/ps /api/chat', () => {
  it('listTags 成功与非 2xx 抛错', async () => {
    const ok = await listTags({ fetchImpl: async () => jsonResponse({ models: [{ name: 'qwen3:4b', model: 'qwen3:4b', size: 100, digest: 'abc', modified_at: '2024-01-01T00:00:00Z' }] }) as never })
    expect(ok.models[0].name).toBe('qwen3:4b')
    await expect(listTags({ fetchImpl: async () => new Response('err', { status: 500, statusText: 'fail' }) as Response as never })).rejects.toThrow(/500/)
  })
  it('listRunning 成功与非 2xx 抛错', async () => {
    const ok = await listRunning({ fetchImpl: async () => jsonResponse({ models: [{ name: 'qwen3:4b', model: 'qwen3:4b', size: 100 }] }) as never })
    expect(ok.models[0].name).toBe('qwen3:4b')
    await expect(listRunning({ fetchImpl: async () => new Response('err', { status: 500 }) as Response as never })).rejects.toThrow(/500/)
  })
  it('checkOllamaHealth — ok true / fail false / 异常 false', async () => {
    expect(await checkOllamaHealth(11434, async () => new Response('', { status: 200 }) as never)).toBe(true)
    expect(await checkOllamaHealth(11434, async () => new Response('', { status: 500 }) as never)).toBe(false)
    expect(await checkOllamaHealth(11434, (async () => { throw new Error('net') }) as never)).toBe(false)
  })
  it('parseOllamaChatLine — NDJSON / data: / [DONE] / response 兼容', () => {
    expect(parseOllamaChatLine('{"message":{"role":"assistant","content":"hi"},"done":false}')).toEqual(expect.objectContaining({ done: false }))
    expect(parseOllamaChatLine('{"response":"hi","done":false}')).toEqual(expect.objectContaining({ content: 'hi' }))
    expect(parseOllamaChatLine('data: {"message":{"role":"assistant","content":"tok"},"done":false}')).toEqual(expect.objectContaining({ done: false }))
    expect(parseOllamaChatLine('data: [DONE]')).toBeNull()
    expect(parseOllamaChatLine('')).toBeNull()
    expect(parseOllamaChatLine('not json')).toBeNull()
    expect(parseOllamaChatLine('{"done":true}')).toEqual(expect.objectContaining({ done: true }))
  })
  it('streamChat — NDJSON 多 chunk 逐个产出', async () => {
    const fetchImpl = vi.fn(async () => ndJsonResponseFromLines([
      JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: ' world' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
    ])) as unknown as typeof fetch
    const chunks: string[] = []
    for await (const c of streamChat({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: fetchImpl as never })) {
      const txt = c.message?.content ?? c.content ?? ''
      chunks.push(txt)
      if (c.done) break
    }
    expect(chunks).toEqual(['Hello', ' world', ''])
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/chat'), expect.objectContaining({ method: 'POST' }))
  })
  it('streamChat — HTTP 非 2xx 抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500, statusText: 'Internal' })) as unknown as typeof fetch
    await expect(async () => { for await (const _ of streamChat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: fetchImpl as never })) { /*noop*/ } }).rejects.toThrow(/500/)
  })
  it('chat — 非流式', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { role: 'assistant', content: 'answer' }, done: true })) as unknown as typeof fetch
    const res = await chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: fetchImpl as never })
    expect(res.message.content).toBe('answer')
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/chat'), expect.objectContaining({ body: expect.stringContaining('"stream":false') }))
  })
  it('chat — 非 2xx 抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 422, statusText: 'Unprocessable' })) as unknown as typeof fetch
    await expect(chat({ model: 'm', messages: [] }, { fetchImpl: fetchImpl as never })).rejects.toThrow(/422/)
  })
})

describe('/v1/* 中间件转发', () => {
  it('openAiToOllama 映射', () => {
    const out = openAiToOllama({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7, max_tokens: 100, stop: ['</s>'] })
    expect(out.model).toBe('qwen3:4b')
    expect(out.temperature).toBe(0.7)
    expect(out.num_predict).toBe(100)
    expect(out.stop).toEqual(['</s>'])
  })
  it('ollamaChunkToOpenAI done 与 delta 形态', () => {
    const c1 = ollamaChunkToOpenAI({ message: { role: 'assistant', content: 'tok' }, done: false }, 'qwen3:4b')
    expect((c1['choices'] as Array<Record<string, unknown>>)[0]['delta']).toEqual(expect.objectContaining({ content: 'tok' }))
    const c2 = ollamaChunkToOpenAI({ done: true }, 'qwen3:4b')
    expect((c2['choices'] as Array<Record<string, unknown>>)[0]['finish_reason']).toBe('stop')
  })
  it('forwardToOllama — 错误 api_key 返回 401', async () => {
    const req = new Request('http://127.0.0.1:11434/api/tags', { headers: { authorization: 'Bearer wrong' } })
    const res = await forwardToOllama(req, { fetchImpl: async () => jsonResponse({ models: [] }) as never })
    expect(res.status).toBe(401)
  })
  it('forwardToOllama — /v1/models 转 /api/tags', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [{ name: 'qwen3:4b', model: 'qwen3:4b', modified_at: '2024-01-01T00:00:00Z', size: 1, digest: 'abc' }] })) as unknown as typeof fetch
    const req = new Request('http://127.0.0.1:11434/v1/models', { headers: { authorization: 'Bearer ollama' } })
    const res = await forwardToOllama(req, { fetchImpl: fetchImpl as never })
    expect(res.status).toBe(200)
    const j = await res.json() as { data: Array<{ id: string }> }
    expect(j.data[0].id).toBe('qwen3:4b')
  })
  it('forwardToOllama — /v1/chat/completions 非流式转 /api/chat', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/chat')) return jsonResponse({ message: { role: 'assistant', content: 'hi' }, done: true, usage: { prompt_tokens: 1, completion_tokens: 1 } })
      return jsonResponse({ models: [] })
    }) as unknown as typeof fetch
    const req = new Request('http://127.0.0.1:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ollama' },
      body: JSON.stringify({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    })
    const res = await forwardToOllama(req, { fetchImpl: fetchImpl as never })
    expect(res.status).toBe(200)
    const j = await res.json() as { choices: Array<{ message: { content: string } }> }
    expect(j.choices[0].message.content).toBe('hi')
  })
  it('forwardToOllama — /api/tags 透传', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [{ name: 'a', model: 'a', size: 1, digest: 'd', modified_at: '' }] })) as unknown as typeof fetch
    const req = new Request('http://127.0.0.1:11434/api/tags', { headers: { authorization: 'Bearer ollama' } })
    const res = await forwardToOllama(req, { fetchImpl: fetchImpl as never })
    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/tags'), expect.anything())
  })
  it('forwardToOllama — 未知路径 404', async () => {
    const req = new Request('http://127.0.0.1:11434/unknown', { headers: { authorization: 'Bearer ollama' } })
    const res = await forwardToOllama(req, { fetchImpl: async () => jsonResponse({}) as never })
    expect(res.status).toBe(404)
  })
  it('createOllamaMiddleware — 非 ollama 路由返回 null，ollama 路由转发', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ models: [] })) as unknown as typeof fetch
    const h = createOllamaMiddleware({ fetchImpl: fetchImpl as never })
    expect(await h(new Request('http://127.0.0.1:11434/health'))).toBeNull()
    const r2 = await h(new Request('http://127.0.0.1:11434/api/tags', { headers: { authorization: 'Bearer ollama' } }))
    expect(r2?.status).toBe(200)
  })
})

describe('OllamaSidecar wrapper', () => {
  let fsMock: ReturnType<typeof makeFsMock>
  beforeEach(() => { vi.useFakeTimers(); fsMock = makeFsMock() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  it('封装 manager + chat/tags/ps/health 透出，且仅绑定 127.0.0.1', () => {
    const s = new OllamaSidecar({ managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never } })
    expect(s.healthUrl).toBe(OLLAMA_HEALTH_URL)
    expect(s.chatUrl).toBe(OLLAMA_CHAT_URL)
    expect(s.tagsUrl).toBe(OLLAMA_TAGS_URL)
    expect(s.psUrl).toBe(OLLAMA_PS_URL)
    expect(s.port).toBe(11434)
    expect(s.logPath).toContain('sidecar-ollama.log')
    expect(s.config.healthUrl).toBe(OLLAMA_HEALTH_URL)
    expect(s.modelsDir).toContain('models')
    s.stop()
  })
  it('OllamaSidecar stream/generate/tags/ps 代理到对应端口', async () => {
    const s = new OllamaSidecar({ port: 11434, managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never } })
    // stream
    const fetchStream = vi.fn(async () => ndJsonResponseFromLines([JSON.stringify({ message: { role: 'assistant', content: 'tok' }, done: false }), JSON.stringify({ done: true })])) as unknown as typeof fetch
    const chunks: string[] = []
    for await (const c of s.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: fetchStream as never })) { chunks.push(c.message?.content ?? c.content ?? ''); if (c.done) break }
    expect(chunks).toContain('tok')
    // generate
    const fetchJson = vi.fn(async () => jsonResponse({ message: { role: 'assistant', content: 'final' }, done: true }))
    const out = await s.generate({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { fetchImpl: fetchJson as never })
    expect(out.message.content).toBe('final')
    // tags/ps
    const ft = vi.fn(async () => jsonResponse({ models: [{ name: 'm', model: 'm', size: 1, digest: 'd', modified_at: '' }] }))
    expect((await s.tags({ fetchImpl: ft as never })).models[0].name).toBe('m')
    const fp = vi.fn(async () => jsonResponse({ models: [{ name: 'm', model: 'm', size: 1 }] }))
    expect((await s.ps({ fetchImpl: fp as never })).models[0].name).toBe('m')
    // middleware
    const mw = s.middleware({ fetchImpl: ft as never })
    expect(typeof mw).toBe('function')
    s.stop()
  })
})
