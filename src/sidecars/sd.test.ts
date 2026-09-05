import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

import {
  SD_HOST,
  SD_PORT,
  SD_HEALTH_URL,
  SD_GENERATE_URL,
  SD_IMG_GEN_URL,
  SD_NAME,
  SD_LOG_FILE,
  DEFAULT_SD_BIN,
  SD_QUANTIZATIONS,
  isValidSdQuantization,
  resolveSdBin,
  buildSdArgs,
  buildSdCpuFallbackArgs,
  buildLoraPromptTags,
  toGenerateBody,
  getGenerateUrl,
  getHealthUrl,
  getImgGenUrl,
  getJobUrl,
  createSdSidecarConfig,
  createSdSidecar,
  SdQueue,
  defaultSdQueue,
  generateImage,
  generateImageQueued,
  generateWithCpuFallback,
  checkSdHealth,
  SdSidecar,
} from './sd'

// --- helpers ---

/**
 * 原生异步任务流 mock（阶段0 升级 sd-server）：POST /sdcpp/v1/img_gen →
 * 202 {id, poll_url}；GET /sdcpp/v1/jobs/{id} → done + result.images。
 * 每次提交返回独立 job id（img1/img2/...）以验证队列串行语义。
 */
function jobFlowFetch(images: string[] = ['img1']): ReturnType<typeof vi.fn> {
  let submits = 0
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.includes('/sdcpp/v1/img_gen')) {
      submits += 1
      const id = `job_${submits}`
      return new Response(JSON.stringify({ id, poll_url: `/sdcpp/v1/jobs/${id}`, status: 'queued' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    }
    const m = u.match(/\/sdcpp\/v1\/jobs\/job_(\d+)/)
    if (m) {
      const n = Number(m[1])
      const b64 = images[n - 1] ?? `img${n}`
      return new Response(JSON.stringify({ id: m[0], status: 'done', result: { images: [{ b64_json: b64 }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('not found', { status: 404 })
  })
}

function submitBodyOf(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const submit = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/img_gen'))[callIndex]
  return JSON.parse(String((submit as [unknown, { body: string }])[1]?.body)) as Record<string, unknown>
}

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

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('sd sidecar constants (host 127.0.0.1:11436)', () => {
  it('常量符合 spec：127.0.0.1:11436 / health(v1/models) / img_gen / 日志', () => {
    expect(SD_HOST).toBe('127.0.0.1')
    expect(SD_PORT).toBe(11436)
    expect(SD_HEALTH_URL).toBe('http://127.0.0.1:11436/v1/models')
    expect(SD_GENERATE_URL).toBe('http://127.0.0.1:11436/generate')
    expect(SD_IMG_GEN_URL).toBe('http://127.0.0.1:11436/sdcpp/v1/img_gen')
    expect(SD_NAME).toBe('sd')
    expect(SD_LOG_FILE).toBe('sidecar-sd.log')
    expect(DEFAULT_SD_BIN).toBe('sd-server')
    expect(SD_QUANTIZATIONS).toEqual(expect.arrayContaining(['f32', 'f16', 'q4_0', 'q8_0']))
  })

  it('getHealthUrl / getGenerateUrl / getImgGenUrl 默认与自定义端口', () => {
    expect(getHealthUrl()).toBe(SD_HEALTH_URL)
    expect(getGenerateUrl()).toBe(SD_GENERATE_URL)
    expect(getHealthUrl(12000)).toBe('http://127.0.0.1:12000/v1/models')
    expect(getGenerateUrl(12000)).toBe('http://127.0.0.1:12000/generate')
    expect(getImgGenUrl(12000)).toBe('http://127.0.0.1:12000/sdcpp/v1/img_gen')
    expect(getJobUrl(12000, 'j1')).toBe('http://127.0.0.1:12000/sdcpp/v1/jobs/j1')
  })

  it('resolveSdBin — explicit > env > default', () => {
    expect(resolveSdBin('/custom/sd-cli')).toBe('/custom/sd-cli')
    const prev = process.env['SD_BIN']
    process.env['SD_BIN'] = '/env/bin/sd-cli'
    expect(resolveSdBin()).toBe('/env/bin/sd-cli')
    delete process.env['SD_BIN']
    expect(resolveSdBin()).toBe(DEFAULT_SD_BIN)
    if (prev !== undefined) process.env['SD_BIN'] = prev
  })

  it('isValidSdQuantization', () => {
    expect(isValidSdQuantization('q4_0')).toBe(true)
    expect(isValidSdQuantization('f16')).toBe(true)
    expect(isValidSdQuantization('q2_k')).toBe(false)
    expect(isValidSdQuantization('')).toBe(false)
  })
})

describe('buildSdArgs — GGUF 量化与 CPU 回退', () => {
  it('默认产出 --host 127.0.0.1 --port 11436', () => {
    expect(buildSdArgs()).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '11436'])
  })

  it('modelPath 追加 --model', () => {
    const args = buildSdArgs({ modelPath: 'models/sd-v1-5.gguf' })
    expect(args).toContain('--model')
    expect(args).toContain('models/sd-v1-5.gguf')
  })

  it('vaePath 追加 --vae', () => {
    const args = buildSdArgs({ vaePath: 'models/vae.gguf' })
    expect(args).toContain('--vae')
    expect(args).toContain('models/vae.gguf')
  })

  it('quantization 追加 --weight-type 且校验合法', () => {
    for (const q of SD_QUANTIZATIONS) {
      const args = buildSdArgs({ quantization: q })
      expect(args).toContain('--weight-type')
      expect(args).toContain(q)
    }
    expect(() => buildSdArgs({ quantization: 'q2_k' as never })).toThrow(/quantization/)
  })

  it('cpuFallback true 追加 --cpu', () => {
    expect(buildSdArgs({ cpuFallback: true })).toContain('--cpu')
    expect(buildSdArgs({ device: 'cpu' })).toContain('--cpu')
    expect(buildSdArgs({})).not.toContain('--cpu')
    expect(buildSdArgs({ device: 'cuda' })).toContain('--device')
    expect(buildSdArgs({ device: 'cuda' })).toContain('cuda')
  })

  it('buildSdCpuFallbackArgs 强制 --cpu', () => {
    const args = buildSdCpuFallbackArgs({ modelPath: 'm.gguf', quantization: 'q4_0' })
    expect(args).toContain('--cpu')
    expect(args).toContain('--model')
    expect(args).toContain('--weight-type')
  })

  it('threads 追加 --threads 且校验', () => {
    expect(buildSdArgs({ threads: 4 })).toContain('4')
    expect(() => buildSdArgs({ threads: 0 })).toThrow(/threads/)
  })

  it('extraArgs 透传', () => {
    expect(buildSdArgs({ extraArgs: ['--verbose'] })).toEqual(expect.arrayContaining(['--verbose']))
  })

  it('host 非 127.0.0.1 抛错', () => {
    expect(() => buildSdArgs({ host: '0.0.0.0' })).toThrow(/127\.0\.0\.1/)
    expect(() => buildSdArgs({ host: '192.168.1.1' })).toThrow(/127\.0\.0\.1/)
  })

  it('port 越界抛错', () => {
    expect(() => buildSdArgs({ port: 80 })).toThrow(/port/)
    expect(() => buildSdArgs({ port: 99999 })).toThrow(/port/)
  })

  it('device 非法抛错', () => {
    expect(() => buildSdArgs({ device: 'metal' as never })).toThrow(/device/)
  })
})

describe('createSdSidecarConfig / createSdSidecar (复用 SidecarManager)', () => {
  let fsMock: ReturnType<typeof makeFsMock>
  beforeEach(() => {
    vi.useFakeTimers()
    fsMock = makeFsMock()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('config 校验：host 127.0.0.1 / port 11436 / healthUrl 正确 / GGUF 量化透传', () => {
    const cfg = createSdSidecarConfig({ modelPath: 'models/sd.gguf', quantization: 'q4_0' })
    expect(cfg.name).toBe('sd')
    expect(cfg.bin).toBe(DEFAULT_SD_BIN)
    expect(cfg.port).toBe(11436)
    expect(cfg.healthUrl).toBe('http://127.0.0.1:11436/v1/models')
    expect(cfg.args).toContain('--listen-ip')
    expect(cfg.args).toContain('127.0.0.1')
    expect(cfg.args).toContain('--listen-port')
    expect(cfg.args).toContain('--weight-type')
    expect(cfg.args).toContain('q4_0')
    expect((cfg as unknown as { quantization: string }).quantization).toBe('q4_0')
    expect((cfg as unknown as { modelPath: string }).modelPath).toBe('models/sd.gguf')
  })

  it('SidecarManager 校验 — healthUrl 非 127.0.0.1 会被 Manager 拒绝', async () => {
    const { SidecarManager } = await import('../core/SidecarManager')
    expect(() => new SidecarManager({ name: 'bad', bin: 'bin', args: [], port: 11436, healthUrl: 'http://0.0.0.0:11436/health' }, { fsDeps: fsMock.deps as never })).toThrow(/127\.0\.0\.1/)
  })

  it('createSdSidecar spawn 使用 sd-server 且日志落盘 logs/sidecar-sd.log + CPU 回退参数', async () => {
    const proc = mockChildProcess()
    const spawner = vi.fn(() => proc as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = createSdSidecar({
      modelPath: 'models/sd.gguf',
      quantization: 'q8_0',
      cpuFallback: true,
      managerOptions: {
        spawner: spawner as never,
        fetcher: async () => true,
        fsDeps: fsMock.deps as never,
        probePort: async () => true,
      },
    })
    await m.start()
    expect(spawner).toHaveBeenCalledWith('sd-server', expect.arrayContaining(['--listen-ip', '127.0.0.1', '--listen-port', '11436', '--model', 'models/sd.gguf', '--weight-type', 'q8_0', '--cpu']), expect.objectContaining({ stdio: expect.anything() }))
    expect(fsMock.deps.mkdirSync).toHaveBeenCalled()
    const logCall = (fsMock.deps.createWriteStream as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(logCall).toContain('sidecar-sd.log')
    expect(logCall).toContain('logs')
    expect(m.isRunning()).toBe(true)
    expect(m.getStatus().port).toBe(11436)
    expect(m.getStatus().healthUrl).toBe(SD_HEALTH_URL)
    m.stop()
  })

  it('logPath 便捷访问与 restart 语义（退避 500ms 后才重新 spawn）', async () => {
    const proc1 = mockChildProcess({ pid: 111 } as never)
    const proc2 = mockChildProcess({ pid: 222 } as never)
    let call = 0
    const spawner = vi.fn(() => (call++ === 0 ? proc1 : proc2) as unknown as ReturnType<typeof import('child_process').spawn>)
    const m = createSdSidecar({
      managerOptions: { spawner: spawner as never, fetcher: async () => true, fsDeps: fsMock.deps as never, probePort: async () => true },
    })
    expect(m.logPath).toContain('sidecar-sd.log')
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

describe('SdQueue — POST /generate 队列', () => {
  it('串行执行：并发 enqueue 按序完成', async () => {
    const q = new SdQueue()
    const order: number[] = []
    const mk = (id: number, ms: number) => () => new Promise<number>((res) => setTimeout(() => { order.push(id); res(id) }, ms))
    const p1 = q.enqueue(mk(1, 20))
    const p2 = q.enqueue(mk(2, 10))
    const p3 = q.enqueue(mk(3, 5))
    expect(q.pending).toBe(3)
    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
    expect(q.pending).toBe(0)
    await q.drain()
  })

  it('失败不阻塞后续任务', async () => {
    const q = new SdQueue()
    const p1 = q.enqueue(async () => { throw new Error('boom') })
    const p2 = q.enqueue(async () => 42)
    await expect(p1).rejects.toThrow('boom')
    await expect(p2).resolves.toBe(42)
    expect(q.pending).toBe(0)
  })

  it('totalEnqueued 计数', async () => {
    const q = new SdQueue()
    expect(q.totalEnqueued).toBe(0)
    const p1 = q.enqueue(async () => 1)
    const p2 = q.enqueue(async () => 2)
    expect(q.totalEnqueued).toBe(2)
    await Promise.all([p1, p2])
    expect(q.pending).toBe(0)
  })

  it('defaultSdQueue 单例可用', () => {
    expect(defaultSdQueue).toBeInstanceOf(SdQueue)
  })
})

describe('POST /sdcpp/v1/img_gen — generateImage / queued / CPU回退（阶段0 原生任务流）', () => {
  it('generateImage — 提交 + 轮询 done 返回 b64', async () => {
    const fetchImpl = jobFlowFetch(['b64data'])
    const res = await generateImage({ prompt: 'a cat' }, { fetchImpl: fetchImpl as never, pollMs: 1 })
    expect(res.image).toBe('b64data')
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/sdcpp/v1/img_gen'),
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"prompt":"a cat"') }),
    )
  })

  it('generateImage — prompt 为空抛错', async () => {
    await expect(generateImage({ prompt: '' } as never)).rejects.toThrow(/prompt/)
    await expect(generateImage({ prompt: '   ' } as never)).rejects.toThrow(/prompt/)
  })

  it('generateImage — 提交 HTTP 非 2xx 抛错', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500, statusText: 'Internal' }))
    await expect(generateImage({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })).rejects.toThrow(/500/)
  })

  it('generateImage — 同步应答兼容（200 + images 数组）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ images: ['sync-b64'] }))
    const res = await generateImage({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })
    expect(res.image).toBe('sync-b64')
  })

  it('generateImageQueued — 通过队列串行', async () => {
    const q = new SdQueue()
    const fetchImpl = jobFlowFetch(['img1', 'img2'])
    const a = generateImageQueued({ prompt: 'a' }, { fetchImpl: fetchImpl as never, queue: q, pollMs: 1 })
    const b = generateImageQueued({ prompt: 'b' }, { fetchImpl: fetchImpl as never, queue: q, pollMs: 1 })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.image).toBe('img1')
    expect(rb.image).toBe('img2')
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('/img_gen'))).toHaveLength(2)
  })

  it('generateWithCpuFallback — GPU 失败时回退到 fallbackFetch', async () => {
    const q = new SdQueue()
    const primary = vi.fn(async () => new Response('CUDA out of memory', { status: 500, statusText: 'CUDA OOM' }))
    const fallback = jobFlowFetch(['cpu-b64'])
    const res = await generateWithCpuFallback({ prompt: 'hi' }, { fetchImpl: primary as never, fallbackFetchImpl: fallback as never, queue: q, pollMs: 1 })
    expect(res.image).toBe('cpu-b64')
    expect(primary).toHaveBeenCalledTimes(1)
  })

  it('generateWithCpuFallback — 非 GPU 错误直接抛错不重试', async () => {
    const primary = vi.fn(async () => new Response('bad prompt', { status: 400, statusText: 'Bad' }))
    await expect(generateWithCpuFallback({ prompt: 'hi' }, { fetchImpl: primary as never })).rejects.toThrow(/400/)
    expect(primary).toHaveBeenCalledTimes(1)
  })

  it('generateWithCpuFallback — 成功不触发回退', async () => {
    const primary = jobFlowFetch(['ok'])
    const fallback = jobFlowFetch(['fallback'])
    const res = await generateWithCpuFallback({ prompt: 'hi' }, { fetchImpl: primary as never, fallbackFetchImpl: fallback as never, pollMs: 1 })
    expect(res.image).toBe('ok')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('checkSdHealth — ok true / fail false / 异常 false', async () => {
    expect(await checkSdHealth(11436, async () => new Response('', { status: 200 }) as Response)).toBe(true)
    expect(await checkSdHealth(11436, async () => new Response('', { status: 500 }) as Response)).toBe(false)
    expect(await checkSdHealth(11436, async () => { throw new Error('net') })).toBe(false)
  })
})

describe('todo18 — LoRA args / apply-mode / prompt tag builder', () => {
  it('buildSdArgs 空 options 不变（LoRA 为纯增量）', () => {
    expect(buildSdArgs()).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '11436'])
  })

  it('loraModelDir 拼 --lora-model-dir <dir>', () => {
    const argv = buildSdArgs({ loraModelDir: 'D:\\models\\lora' })
    expect(argv).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '11436', '--lora-model-dir', 'D:\\models\\lora'])
  })

  it('显式 loraApplyMode 三枚举原样透传', () => {
    for (const mode of ['immediately', 'at_runtime', 'auto'] as const) {
      const argv = buildSdArgs({ loraModelDir: 'lora', loraApplyMode: mode })
      expect(argv).toContain('--lora-apply-mode')
      expect(argv).toContain(mode)
    }
  })

  it('量化权重默认 at_runtime（docs/lora.md：quantized -> at_runtime auto 规则）', () => {
    const argv = buildSdArgs({ loraModelDir: 'lora', quantization: 'q4_0' })
    expect(argv).toEqual(expect.arrayContaining(['--lora-apply-mode', 'at_runtime']))
    expect(argv.indexOf('--lora-apply-mode')).toBe(argv.indexOf('at_runtime') - 1)
  })

  it('非量化 (f16/f32/缺省) 不显式注入 apply-mode（留给 sd.cpp auto 选择 immediately）', () => {
    expect(buildSdArgs({ loraModelDir: 'lora', quantization: 'f16' })).not.toContain('--lora-apply-mode')
    expect(buildSdArgs({ loraModelDir: 'lora' })).not.toContain('--lora-apply-mode')
  })

  it('显式 mode 覆盖量化默认（immediately + q4_0 由调用方负责，sd.cpp 自行回退）', () => {
    const argv = buildSdArgs({ loraModelDir: 'lora', quantization: 'q4_0', loraApplyMode: 'immediately' })
    expect(argv).toContain('immediately')
    expect(argv).not.toContain('at_runtime')
  })

  it('非法 apply mode 抛错（运行时枚举校验，防 IPC 绕过 TS）', () => {
    expect(() => buildSdArgs({ loraModelDir: 'lora', loraApplyMode: 'YOLO' as never })).toThrow(/lora-apply-mode|apply mode/)
  })

  it('buildLoraPromptTags: <lora:name:scale> 拼接 + 尾随空格', () => {
    expect(buildLoraPromptTags([])).toBe('')
    expect(buildLoraPromptTags([{ name: 'marblesh', scale: 1 }])).toBe('<lora:marblesh:1> ')
    expect(buildLoraPromptTags([{ name: 'a', scale: 0.75 }, { name: 'b', scale: 0.5 }])).toBe('<lora:a:0.75> <lora:b:0.5> ')
  })

  it('buildLoraPromptTags: scale clamp 0-2 并吸附 0.05 网格', () => {
    expect(buildLoraPromptTags([{ name: 'x', scale: 5 }])).toBe('<lora:x:2> ')
    expect(buildLoraPromptTags([{ name: 'x', scale: -1 }])).toBe('<lora:x:0> ')
    expect(buildLoraPromptTags([{ name: 'x', scale: 0.77 }])).toBe('<lora:x:0.75> ')
    expect(buildLoraPromptTags([{ name: 'x', scale: Number.NaN }])).toBe('<lora:x:1> ')
  })

  it('buildLoraPromptTags: 空/非法 name 跳过，非法字符净化为 _', () => {
    expect(buildLoraPromptTags([{ name: '  ', scale: 1 }])).toBe('')
    expect(buildLoraPromptTags([{ name: 'a>b c', scale: 1 }])).toBe('<lora:a_b_c:1> ')
  })

  it('generateImage: loras 折叠进 prompt 前缀且不出现在 JSON body（Appendix R3 §A 18/20 锚点）', async () => {
    const fetchImpl = jobFlowFetch()
    await generateImage(
      { prompt: 'a lovely cat', loras: [{ name: 'marblesh', scale: 0.8 }] },
      { fetchImpl: fetchImpl as never, pollMs: 1 },
    )
    const body = submitBodyOf(fetchImpl)
    expect(body['prompt']).toBe('<lora:marblesh:0.8> a lovely cat')
    expect(body['loras']).toBeUndefined()
  })

  it('generateImage: 无 loras 时 body 不含 loras 键（回归保护）', async () => {
    const fetchImpl = jobFlowFetch()
    await generateImage({ prompt: 'plain' }, { fetchImpl: fetchImpl as never, pollMs: 1 })
    const body = submitBodyOf(fetchImpl)
    expect(body['prompt']).toBe('plain')
    expect('loras' in body).toBe(false)
  })
})

describe('todo20 — img2img/inpaint body mapping (阶段0: init/mask 转 base64 上传)', () => {
  it('toGenerateBody: 不携带 init/mask（文件读取在 generateImage 中进行），strength 直传', () => {
    const body = toGenerateBody({
      prompt: 'cat',
      initImagePath: 'C:\\tmp\\img-1.png',
      maskPath: 'C:\\tmp\\mask-1.png',
      strength: 0.65,
    })
    expect(body['prompt']).toBe('cat')
    expect(body['strength']).toBe(0.65)
    expect('initImagePath' in body).toBe(false)
    expect('maskPath' in body).toBe(false)
    expect('init_image' in body).toBe(false)
    expect('mask_image' in body).toBe(false)
  })

  it('txt2img 请求 body 不含 img2img 键（回归）', () => {
    const body = toGenerateBody({ prompt: 'cat' })
    expect('init_img' in body).toBe(false)
    expect('mask' in body).toBe(false)
    expect('strength' in body).toBe(false)
  })

  it('generateImage POST body 走同一映射', async () => {
    const fetchImpl = jobFlowFetch()
    await generateImage({ prompt: 'cat', strength: 0.5, initImagePath: 'C:\a.png' }, { fetchImpl: fetchImpl as never, pollMs: 1, fsRead: (p) => Buffer.from('bytes:' + p) })
    const body = submitBodyOf(fetchImpl)
    expect(body['init_image']).toBe(Buffer.from('bytes:C:\a.png').toString('base64'))
    expect(body['strength']).toBe(0.5)
    expect('init_img' in body).toBe(false)
  })
})

describe('SdSidecar wrapper', () => {
  let fsMock: ReturnType<typeof makeFsMock>
  beforeEach(() => {
    vi.useFakeTimers()
    fsMock = makeFsMock()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('封装 manager + generateUrl/healthUrl + queue + quantization，且仅绑定 127.0.0.1', () => {
    const s = new SdSidecar({
      modelPath: 'models/sd.gguf',
      quantization: 'q4_0',
      managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never },
    })
    expect(s.healthUrl).toBe(SD_HEALTH_URL)
    expect(s.generateUrl).toBe(SD_GENERATE_URL)
    expect(s.port).toBe(11436)
    expect(s.logPath).toContain('sidecar-sd.log')
    expect(s.config.healthUrl).toBe(SD_HEALTH_URL)
    expect(s.config.port).toBe(11436)
    expect(s.quantization).toBe('q4_0')
    expect(s.queue).toBeInstanceOf(SdQueue)
    s.stop()
  })

  it('SdSidecar.generate 队列代理到 img_gen 任务流', async () => {
    const s = new SdSidecar({
      managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never },
    })
    const fetchImpl = jobFlowFetch(['b64'])
    const res = await s.generate({ prompt: 'a cat, 8k' }, { fetchImpl: fetchImpl as never })
    expect(res.image).toBe('b64')
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/sdcpp/v1/img_gen'), expect.objectContaining({ method: 'POST' }))
    s.stop()
  })

  it('SdSidecar.generateWithFallback 触发 CPU 回退', async () => {
    const s = new SdSidecar({
      managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never },
    })
    const primary = vi.fn(async () => new Response('vulkan failed', { status: 500, statusText: 'Vulkan error' }))
    const fallback = jobFlowFetch(['cpu-ok'])
    const res = await s.generateWithFallback({ prompt: 'hi' }, { fetchImpl: primary as never, fallbackFetchImpl: fallback as never })
    expect(res.image).toBe('cpu-ok')
    s.stop()
  })

  it('SdSidecar.generateRaw 非队列直通', async () => {
    const s = new SdSidecar({
      managerOptions: { spawner: (() => mockChildProcess() as never) as never, fetcher: async () => true, fsDeps: fsMock.deps as never },
    })
    const fetchImpl = jobFlowFetch(['raw'])
    const res = await s.generateRaw({ prompt: 'hi' }, { fetchImpl: fetchImpl as never })
    expect(res.image).toBe('raw')
    s.stop()
  })
})
