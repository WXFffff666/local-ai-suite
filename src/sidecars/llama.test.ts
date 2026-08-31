import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

import {
  LLAMA_HOST,
  LLAMA_PORT,
  LLAMA_HEALTH_URL,
  LLAMA_COMPLETION_URL,
  LLAMA_NAME,
  LLAMA_LOG_FILE,
  DEFAULT_CTX_SIZE,
  DEFAULT_LLAMA_BIN,
  buildLlamaArgs,
  getCompletionUrl,
  getHealthUrl,
  resolveLlamaBin,
  createLlamaSidecarConfig,
  createLlamaSidecar,
  parseSseLine,
  streamCompletion,
  complete,
  checkLlamaHealth,
  LlamaSidecar,
} from './llama'

// --- helpers ---

function mockChildProcess(overrides: Partial<Record<string, unknown>> = {}) {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number
    killed: boolean
    exitCode: number | null
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter
    stderr: EventEmitter
  }
  ee.pid = 4242
  ee.killed = false
  ee.exitCode = null
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.kill = vi.fn(() => {
    ee.killed = true
    ee.exitCode = null
    return true
  })
  Object.assign(ee, overrides)
  return ee
}

function makeFsMock() {
  const writes: string[] = []
  const fakeStream: Record<string, unknown> = {
    write: vi.fn((s: string) => writes.push(s)),
    end: vi.fn(),
    on: vi.fn(),
  }
  return {
    writes,
    fakeStream,
    deps: {
      createWriteStream: vi.fn(() => fakeStream as unknown as ReturnType<typeof import('fs').createWriteStream>),
      statSync: vi.fn(() => ({ size: 0 }) as unknown as ReturnType<typeof import('fs').statSync>),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
  }
}

// SSE mock response helpers
function sseResponseFromChunks(chunks: string[]): Response {
  // Build a ReadableStream that emits Uint8Array chunks line-by-line
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('llama sidecar constants (host 127.0.0.1:11435)', () => {
  it('常量符合 spec：127.0.0.1:11435 / health / completion / 日志', () => {
    expect(LLAMA_HOST).toBe('127.0.0.1')
    expect(LLAMA_PORT).toBe(11435)
    expect(LLAMA_HEALTH_URL).toBe('http://127.0.0.1:11435/health')
    expect(LLAMA_COMPLETION_URL).toBe('http://127.0.0.1:11435/completion')
    expect(LLAMA_NAME).toBe('llama')
    expect(LLAMA_LOG_FILE).toBe('sidecar-llama.log')
    expect(DEFAULT_CTX_SIZE).toBe(4096)
    expect(DEFAULT_LLAMA_BIN).toBe('llama-server')
  })

  it('getHealthUrl / getCompletionUrl 默认与自定义端口', () => {
    expect(getHealthUrl()).toBe(LLAMA_HEALTH_URL)
    expect(getCompletionUrl()).toBe(LLAMA_COMPLETION_URL)
    expect(getHealthUrl(12000)).toBe('http://127.0.0.1:12000/health')
    expect(getCompletionUrl(12000)).toBe('http://127.0.0.1:12000/completion')
  })

  it('resolveLlamaBin — explicit > env > default', () => {
    expect(resolveLlamaBin('/custom/llama-server')).toBe('/custom/llama-server')
    const prev = process.env['LLAMA_BIN']
    process.env['LLAMA_BIN'] = '/env/bin/llama-server'
    expect(resolveLlamaBin()).toBe('/env/bin/llama-server')
    delete process.env['LLAMA_BIN']
    expect(resolveLlamaBin()).toBe(DEFAULT_LLAMA_BIN)
    if (prev !== undefined) process.env['LLAMA_BIN'] = prev
  })
})

describe('buildLlamaArgs', () => {
  it('默认产出 --host 127.0.0.1 --port 11435 --ctx-size 4096', () => {
    expect(buildLlamaArgs()).toEqual(['--host', '127.0.0.1', '--port', '11435', '--ctx-size', '4096'])
  })

  it('modelPath 追加 --model', () => {
    const args = buildLlamaArgs({ modelPath: 'models/qwen.gguf' })
    expect(args).toContain('--model')
    expect(args).toContain('models/qwen.gguf')
    // order: host/port/ctx-size then model
    expect(args.indexOf('--model')).toBeGreaterThan(args.indexOf('--ctx-size'))
  })

  it('ctxSize / port 自定义', () => {
    expect(buildLlamaArgs({ ctxSize: 8192 })).toContain('8192')
    expect(buildLlamaArgs({ port: 12000 })).toContain('12000')
  })

  it('extraArgs 透传', () => {
    expect(buildLlamaArgs({ extraArgs: ['--threads', '8'] })).toEqual(
      expect.arrayContaining(['--threads', '8']),
    )
  })

  it('host 非 127.0.0.1 抛错', () => {
    expect(() => buildLlamaArgs({ host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/)
    expect(() => buildLlamaArgs({ host: '192.168.1.1' })).toThrow(/127\.0\.0\.1/)
  })
})

describe('createLlamaSidecarConfig / createLlamaSidecar (复用 SidecarManager)', () => {
  let fsMock: ReturnType<typeof makeFsMock>
  beforeEach(() => {
    vi.useFakeTimers()
    fsMock = makeFsMock()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('config 校验：host 127.0.0.1 / port 11435 / healthUrl 正确', () => {
    const cfg = createLlamaSidecarConfig({ modelPath: 'models/qwen.gguf' })
    expect(cfg.name).toBe('llama')
    expect(cfg.bin).toBe(DEFAULT_LLAMA_BIN)
    expect(cfg.port).toBe(11435)
    expect(cfg.healthUrl).toBe('http://127.0.0.1:11435/health')
    expect(cfg.args).toContain('--host')
    expect(cfg.args).toContain('127.0.0.1')
    expect(cfg.args).toContain('--port')
    expect(cfg.modelPath).toBe('models/qwen.gguf')
  })

  it('SidecarManager 校验 — healthUrl 非 127.0.0.1 会被 Manager 拒绝 (通过篡改配置验证)', async () => {
    // SidecarManager 本身会校验 healthUrl host；此处验证 llama 默认就是 127.0.0.1
    const { SidecarManager } = await import('../core/SidecarManager')
    expect(() => new SidecarManager({ name: 'bad', bin: 'bin', args: [], port: 11435, healthUrl: 'http://0.0.0.0:11435/health' }, { fsDeps: fsMock.deps as never })).toThrow(/127\.0\.0\.1/)
  })

  it('createLlamaSidecar spawn 使用 llama-server 且日志落盘 logs/sidecar-llama.log', async () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = createLlamaSidecar({
      modelPath: 'models/qwen.gguf',
      managerOptions: {
        spawner: spawner as never,
        fetcher: async () => true,
        fsDeps: fsMock.deps as never,
        probePort: async () => true,
      },
    })
    await m.start()
    expect(spawner).toHaveBeenCalledWith('llama-server', expect.arrayContaining(['--host', '127.0.0.1', '--port', '11435', '--model', 'models/qwen.gguf']), expect.objectContaining({ stdio: expect.anything() }))
    expect(fsMock.deps.mkdirSync).toHaveBeenCalled()
    // log path must be sidecar-llama.log
    const logCall = (fsMock.deps.createWriteStream as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(logCall).toContain('sidecar-llama.log')
    expect(logCall).toContain('logs')
    expect(m.isRunning()).toBe(true)
    expect(m.getStatus().port).toBe(11435)
    expect(m.getStatus().healthUrl).toBe(LLAMA_HEALTH_URL)
    m.stop()
  })

  it('logPath 便捷访问与 restart 语义（退避 500ms 后才重新 spawn）', async () => {
    const proc1 = mockChildProcess({ pid: 111 } as never)
    const proc2 = mockChildProcess({ pid: 222 } as never)
    let call = 0
    const spawner = vi.fn(() => (call++ === 0 ? proc1 : proc2) as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = createLlamaSidecar({
      managerOptions: { spawner: spawner as never, fetcher: async () => true, fsDeps: fsMock.deps as never, probePort: async () => true },
    })
    expect(m.logPath).toContain('sidecar-llama.log')
    await m.start()
    expect(m.getStatus().restarts).toBe(0)
    m.restart()
    expect(m.getStatus().restarts).toBe(1)
    expect(m.getStatus().state).toBe('backoff')
    expect(spawner).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(spawner).toHaveBeenCalledTimes(2)
    m.stop()
  })
})

describe('SSE /completion 解析与流式', () => {
  it('parseSseLine — data JSON 抽取 content/stop', () => {
    expect(parseSseLine('data: {"content":"hi","stop":false}')).toEqual(expect.objectContaining({ content: 'hi', stop: false }))
    expect(parseSseLine('data: {"content":" world","stop":true}')).toEqual(expect.objectContaining({ content: ' world', stop: true }))
    // [DONE] sentinel ignored
    expect(parseSseLine('data: [DONE]')).toBeNull()
    // empty / non-data ignored
    expect(parseSseLine('')).toBeNull()
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('event: ping')).toBeNull()
    // invalid JSON ignored
    expect(parseSseLine('data: not-json')).toBeNull()
    // delta wrapper
    expect(parseSseLine('data: {"delta":{"content":"tok"}}')).toEqual(expect.objectContaining({ content: 'tok' }))
  })

  it('streamCompletion — SSE 多 chunk 逐个产出', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponseFromChunks([
        'data: {"content":"Hello","stop":false}\n',
        'data: {"content":" world","stop":false}\n',
        'data: {"content":"","stop":true}\n',
        'data: [DONE]\n',
      ]),
    ) as unknown as typeof fetch

    const chunks: string[] = []
    for await (const c of streamCompletion({ prompt: 'hi', stream: true }, { fetchImpl: fetchImpl as never })) {
      chunks.push(c.content)
    }
    expect(chunks).toEqual(['Hello', ' world', ''])
    // payload is POST /completion with stream:true
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/completion'),
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"prompt":"hi"') }),
    )
  })

  it('streamCompletion — 对非 SSE content-type 回退为 JSON 单 chunk', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: 'full answer', stop: true }))
    const out: string[] = []
    for await (const c of streamCompletion({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })) {
      out.push(c.content)
    }
    expect(out).toEqual(['full answer'])
  })

  it('streamCompletion — HTTP 非 2xx 抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500, statusText: 'Internal' }))
    await expect(async () => {
      for await (const _ of streamCompletion({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })) { /* noop */ }
    }).rejects.toThrow(/500/)
  })

  it('complete — 非流式 JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: 'answer', stop: true, tokens_predicted: 2 }))
    const res = await complete({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })
    expect(res.content).toBe('answer')
    expect(res.stop).toBe(true)
    // verify stream:false in body
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/completion'), expect.objectContaining({ body: expect.stringContaining('"stream":false') }))
  })

  it('complete — 非 2xx 抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 422, statusText: 'Unprocessable' }))
    await expect(complete({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })).rejects.toThrow(/422/)
  })

  it('checkLlamaHealth — ok true / fail false / 异常 false', async () => {
    expect(await checkLlamaHealth(11435, async () => new Response('', { status: 200 }) as Response)).toBe(true)
    expect(await checkLlamaHealth(11435, async () => new Response('', { status: 500 }) as Response)).toBe(false)
    expect(await checkLlamaHealth(11435, async () => { throw new Error('net') })).toBe(false)
  })
})

describe('LlamaSidecar wrapper', () => {
  let fsMock: ReturnType<typeof makeFsMock>
  beforeEach(() => {
    vi.useFakeTimers()
    fsMock = makeFsMock()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('封装 manager + completionUrl/healthUrl 透出，且仅绑定 127.0.0.1', () => {
    const s = new LlamaSidecar({
      modelPath: 'models/qwen.gguf',
      managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never },
    })
    expect(s.healthUrl).toBe(LLAMA_HEALTH_URL)
    expect(s.completionUrl).toBe(LLAMA_COMPLETION_URL)
    expect(s.port).toBe(11435)
    expect(s.logPath).toContain('sidecar-llama.log')
    expect(s.config.healthUrl).toBe(LLAMA_HEALTH_URL)
    expect(s.config.port).toBe(11435)
    s.stop()
  })

  it('LlamaSidecar.stream / generate 代理到对应端口的 /completion', async () => {
    const s = new LlamaSidecar({
      port: 11435,
      managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never },
    })

    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/health')) return new Response('', { status: 200 })
      // simulate SSE for stream and JSON for generate
      const body = url.includes('/completion') ? '' : ''
      void body
      // We will handle via passed fetchImpl; return SSE for stream path
      return sseResponseFromChunks(['data: {"content":"tok","stop":false}\n', 'data: {"content":"","stop":true}\n'])
    }) as unknown as typeof fetch

    // stream
    const chunks: string[] = []
    for await (const c of s.stream({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })) {
      chunks.push(c.content)
    }
    expect(chunks).toContain('tok')

    // generate (non-stream) — use json mock
    const fetchJson = vi.fn(async () => jsonResponse({ content: 'final', stop: true }))
    const out = await s.generate({ prompt: 'hi' }, { fetchImpl: fetchJson as never })
    expect(out.content).toBe('final')

    s.stop()
  })
})
