import { describe, it, expect, vi } from 'vitest'
import {
  VRAM_THRESH_SD15_Q4_MB,
  VRAM_THRESH_SDXL_WARN_MB,
  VRAM_THRESH_FLUX_MB,
  classifyVram,
  gradeVram,
  gradeModelRequest,
  formatQueueSse,
  sseHeaders,
  ImageQueue,
  defaultImageQueue,
  createImageQueueHandler,
} from './queue'

// ---------------------------------------------------------------------------
// VRAM 分级
// ---------------------------------------------------------------------------

describe('VRAM 分级 thresholds', () => {
  it('阈值常量符合 spec', () => {
    expect(VRAM_THRESH_SD15_Q4_MB).toBe(4096)
    expect(VRAM_THRESH_SDXL_WARN_MB).toBe(6144)
    expect(VRAM_THRESH_FLUX_MB).toBe(12288)
  })

  it('classifyVram <4GB low, <6GB medium, <=12 high, >12 ultra', () => {
    expect(classifyVram(2048)).toBe('low')
    expect(classifyVram(4095)).toBe('low')
    expect(classifyVram(4096)).toBe('medium')
    expect(classifyVram(5000)).toBe('medium')
    expect(classifyVram(6144)).toBe('high')
    expect(classifyVram(8000)).toBe('high')
    expect(classifyVram(12288)).toBe('high')
    expect(classifyVram(12289)).toBe('ultra')
    expect(classifyVram(24576)).toBe('ultra')
    expect(classifyVram(null)).toBe('low')
    expect(classifyVram(undefined)).toBe('low')
  })

  it('gradeVram <4GB downgradeToQ4 true', () => {
    const g = gradeVram(3072)
    expect(g.downgradeToQ4).toBe(true)
    expect(g.warnSdxl).toBe(true)
    expect(g.fluxUnlocked).toBe(false)
    expect(g.recommended).toBe('sd1.5-q4')
    expect(g.message).toMatch(/降级/)
  })

  it('gradeVram <6GB warnSdxl true', () => {
    const g = gradeVram(5000)
    expect(g.downgradeToQ4).toBe(false)
    expect(g.warnSdxl).toBe(true)
    expect(g.recommended).toBe('sdxl')
    expect(g.message).toMatch(/SDXL/)
  })

  it('gradeVram >12GB fluxUnlocked', () => {
    const g = gradeVram(16384)
    expect(g.fluxUnlocked).toBe(true)
    expect(g.recommended).toBe('flux')
    expect(g.message).toMatch(/FLUX/)
  })

  it('gradeVram 未知显存降级兜底', () => {
    const g = gradeVram(null)
    expect(g.downgradeToQ4).toBe(true)
    expect(g.recommended).toBe('sd1.5-q4')
  })
})

describe('gradeModelRequest — <4GB SD1.5 Q4降级 / <6GB 警告SDXL / >12GB 解锁FLUX', () => {
  it('<4GB 请求 SDXL 自动降级为 SD1.5 Q4', () => {
    const r = gradeModelRequest(3500, 'sdxl')
    expect(r.downgraded).toBe(true)
    expect(r.effectiveModel).toBe('sd1.5-q4')
    expect(r.warning).toMatch(/降级/)
    expect(r.allowed).toBe(true)
  })

  it('<4GB 请求 FLUX 也降级', () => {
    const r = gradeModelRequest(2048, 'flux')
    expect(r.effectiveModel).toBe('sd1.5-q4')
    expect(r.downgraded).toBe(true)
  })

  it('<6GB 请求 SDXL 警告但允许', () => {
    const r = gradeModelRequest(5000, 'sdxl')
    expect(r.allowed).toBe(true)
    expect(r.downgraded).toBe(false)
    expect(r.warning).toMatch(/OOM|显存/)
    expect(r.effectiveModel).toBe('sdxl')
  })

  it('<6GB 请求 SD1.5 不警告', () => {
    const r = gradeModelRequest(5000, 'sd1.5')
    expect(r.warning).toBeUndefined()
  })

  it('>12GB 解锁 FLUX', () => {
    const r = gradeModelRequest(16384, 'flux')
    expect(r.allowed).toBe(true)
    expect(r.effectiveModel).toBe('flux')
  })

  it('<=12GB 请求 FLUX 未解锁回退 SDXL', () => {
    const r = gradeModelRequest(8192, 'flux')
    expect(r.allowed).toBe(false)
    expect(r.effectiveModel).toBe('sdxl')
    expect(r.warning).toMatch(/未解锁|12GB/)
  })

  it('正常显存 8GB 请求 SDXL 无降级无警告', () => {
    const r = gradeModelRequest(8192, 'sdxl')
    expect(r.allowed).toBe(true)
    expect(r.downgraded).toBe(false)
    expect(r.warning).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

describe('SSE helpers', () => {
  it('formatQueueSse 含 event 与 data', () => {
    const s = formatQueueSse({ type: 'progress', jobId: 'abc', progress: 42, status: 'running', message: 'half' })
    expect(s).toContain('event: progress')
    expect(s).toContain('"progress":42')
    expect(s).toContain('"jobId":"abc"')
  })
  it('sseHeaders 含 text/event-stream', () => {
    const h = sseHeaders()
    expect(h['content-type']).toBe('text/event-stream')
    expect(h['cache-control']).toContain('no-cache')
  })
})

// ---------------------------------------------------------------------------
// ImageQueue — 队列 + SSE 进度 + 重试
// ---------------------------------------------------------------------------

describe('ImageQueue 串行队列', () => {
  it('并发入队按序串行执行', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 10 })
    const order: string[] = []
    q.setHandler(async (job, ctx) => {
      ctx.onProgress(50)
      await new Promise((r) => setTimeout(r, 15))
      order.push(job.prompt)
      return { ok: true, prompt: job.prompt }
    })
    const a = q.enqueue({ prompt: 'a' })
    const b = q.enqueue({ prompt: 'b' })
    const c = q.enqueue({ prompt: 'c' })
    expect(q.pending).toBe(3)
    await q.drain()
    expect(order).toEqual(['a', 'b', 'c'])
    expect(q.getJob(a)!.status).toBe('done')
    expect(q.getJob(b)!.status).toBe('done')
    expect(q.getJob(c)!.status).toBe('done')
  })

  it('重试: 可重试错误自动重试后成功', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultMaxRetries: 2, defaultBackoffMs: 5 })
    let calls = 0
    q.setHandler(async () => {
      calls++
      if (calls === 1) throw new Error('CUDA out of memory')
      return { b64: 'ok' }
    })
    const id = q.enqueue({ prompt: 'hi' })
    const events: string[] = []
    q.subscribe((ev) => events.push(ev.type))
    await q.waitFor(id)
    const job = q.getJob(id)!
    expect(job.status).toBe('done')
    expect(calls).toBe(2)
    expect(events).toContain('retry')
    expect(job.attempt).toBe(1)
  })

  it('重试: 不可重试错误直接失败不重试', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultMaxRetries: 2, defaultBackoffMs: 5 })
    let calls = 0
    q.setHandler(async () => {
      calls++
      throw new Error('400 bad prompt invalid')
    })
    const id = q.enqueue({ prompt: 'hi' })
    await q.waitFor(id)
    const job = q.getJob(id)!
    expect(job.status).toBe('failed')
    expect(calls).toBe(1)
    expect(job.error).toMatch(/400/)
  })

  it('SSE 进度: 订阅收到 progress 事件', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 5 })
    q.setHandler(async (_job, ctx) => {
      ctx.onProgress(30, 'loading')
      await new Promise((r) => setTimeout(r, 10))
      ctx.onProgress(80, 'sampling')
      return { b64: 'img' }
    })
    const progresses: number[] = []
    q.subscribe((ev) => { if (ev.type === 'progress') progresses.push(ev.progress) })
    const id = q.enqueue({ prompt: 'a cat' })
    await q.waitFor(id)
    expect(progresses).toEqual(expect.arrayContaining([1, 30, 80]))
    expect(q.getJob(id)!.progress).toBe(100)
  })

  it('VRAM 分级入队时自动降级', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 5 })
    q.setHandler(async (job) => ({ model: job.effectiveModel }))
    const id = q.enqueue({ prompt: 'hi', model: 'sdxl', vramMB: 3500 })
    await q.waitFor(id)
    const job = q.getJob(id)!
    expect(job.downgraded).toBe(true)
    expect(job.effectiveModel).toBe('sd1.5-q4')
    expect(job.warning).toMatch(/降级/)
    expect(job.result).toEqual(expect.objectContaining({ model: 'sd1.5-q4' }))
  })

  it('取消排队任务', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 5 })
    q.setHandler(async (_job, ctx) => {
      await new Promise((r) => setTimeout(r, 50))
      ctx.onProgress(100)
      return { ok: true }
    })
    // 占住队列
    const first = q.enqueue({ prompt: 'first' })
    const second = q.enqueue({ prompt: 'second' })
    // second 仍在 queued，可取消
    const ok = q.cancel(second)
    expect(ok).toBe(true)
    expect(q.getJob(second)!.status).toBe('cancelled')
    await q.waitFor(first)
    expect(q.getJob(first)!.status).toBe('done')
    // cancelled job 不会变为 done
    expect(q.getJob(second)!.status).toBe('cancelled')
  })

  it('waitFor 超时抛错', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 5 })
    q.setHandler(async () => { await new Promise(() => {}) ; return {} })
    const id = q.enqueue({ prompt: 'hang' })
    await expect(q.waitFor(id, 40)).rejects.toThrow(/timeout/)
    q.cancel(id)
  })

  it('defaultImageQueue 单例可用', () => {
    expect(defaultImageQueue).toBeInstanceOf(ImageQueue)
    expect(defaultImageQueue.pending).toBeGreaterThanOrEqual(0)
  })

  it('prune 清理已完成', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 5 })
    q.setHandler(async () => ({ ok: true }))
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(q.enqueue({ prompt: `p${i}` }))
    await q.drain()
    expect(q.listJobs().length).toBe(5)
    const removed = q.prune(2)
    expect(removed).toBe(3)
    expect(q.listJobs().length).toBe(2)
  })
})

describe('createImageQueueHandler — fetch-style', () => {
  it('POST /api/image/generate 入队 202 返回 jobId 与 grade', async () => {
    const q = new ImageQueue({ concurrency: 1, defaultBackoffMs: 5 })
    q.setHandler(async () => ({ b64: 'x' }))
    const h = createImageQueueHandler(q)
    const req = new Request('http://127.0.0.1/api/image/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', model: 'sdxl', vramMB: 3500 }),
    })
    const res = await h(req)
    expect(res.status).toBe(202)
    const j = await res.json() as { jobId: string; warning: string; effectiveModel: string }
    expect(j.jobId).toBeTruthy()
    expect(j.effectiveModel).toBe('sd1.5-q4')
    expect(j.warning).toMatch(/降级/)
    await q.drain()
  })

  it('POST 无 prompt 返回 400', async () => {
    const h = createImageQueueHandler(new ImageQueue({ defaultBackoffMs: 5 }))
    const req = new Request('http://127.0.0.1/api/image/generate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await h(req)
    expect(res.status).toBe(400)
  })

  it('GET /api/image/queue 返回列表', async () => {
    const q = new ImageQueue({ defaultBackoffMs: 5 })
    q.setHandler(async () => ({ b64: 'x' }))
    q.enqueue({ prompt: 'hi' })
    const h = createImageQueueHandler(q)
    const res = await h(new Request('http://127.0.0.1/api/image/queue'))
    expect(res.status).toBe(200)
    const j = await res.json() as { jobs: unknown[]; pending: number }
    expect(j.jobs.length).toBe(1)
    await q.drain()
  })

  it('GET /api/image/queue/:id/stream 返回 SSE', async () => {
    const q = new ImageQueue({ defaultBackoffMs: 5 })
    q.setHandler(async () => ({ b64: 'x' }))
    const id = q.enqueue({ prompt: 'hi' })
    const h = createImageQueueHandler(q)
    const res = await h(new Request(`http://127.0.0.1/api/image/queue/${id}/stream`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    await q.drain()
  })
})
