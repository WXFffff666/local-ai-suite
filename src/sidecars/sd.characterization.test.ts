/**
 * Baseline characterization (plan todo18/20/22 lane, BASELINE FIRST rule):
 * pins buildSdArgs argv output and /generate body shape on the pre-change code
 * so the LoRA / img2img extensions provably stay additive.
 * These tests MUST keep passing after the feature work.
 */
import { describe, expect, it, vi } from 'vitest'

import { buildSdArgs, buildSdCpuFallbackArgs, generateImage } from './sd'

describe('characterization: buildSdArgs argv baseline (pre-LoRA)', () => {
  it('empty options -> exactly host+port argv', () => {
    expect(buildSdArgs()).toEqual(['--listen-ip', '127.0.0.1', '--listen-port', '11436'])
  })

  it('full legacy option set -> exact ordered argv (host,port,model,vae,weight-type,device,threads,extra)', () => {
    const argv = buildSdArgs({
      modelPath: 'D:\\models\\diffusion\\sd.gguf',
      vaePath: 'D:\\models\\vae.safetensors',
      quantization: 'q4_0',
      device: 'cuda',
      threads: 8,
      extraArgs: ['--verbose'],
    })
    expect(argv).toEqual([
      '--listen-ip', '127.0.0.1',
      '--listen-port', '11436',
      '--model', 'D:\\models\\diffusion\\sd.gguf',
      '--vae', 'D:\\models\\vae.safetensors',
      '--weight-type', 'q4_0',
      '--device', 'cuda',
      '--threads', '8',
      '--verbose',
    ])
  })

  it('cpu fallback args pin --cpu and keep model/weight-type', () => {
    expect(buildSdCpuFallbackArgs({ modelPath: 'm.gguf', quantization: 'f16' })).toEqual([
      '--listen-ip', '127.0.0.1',
      '--listen-port', '11436',
      '--model', 'm.gguf',
      '--weight-type', 'f16',
      '--cpu',
    ])
  })

  it('validation errors are stable strings (host/port/quantization/device/threads)', () => {
    expect(() => buildSdArgs({ host: '0.0.0.0' })).toThrow('sd sidecar host must be 127.0.0.1, got 0.0.0.0')
    expect(() => buildSdArgs({ port: 99 })).toThrow('port out of range: 99')
    expect(() => buildSdArgs({ quantization: 'q2_k' as never })).toThrow(/invalid sd quantization/)
    expect(() => buildSdArgs({ device: 'metal' as never })).toThrow('invalid sd device: metal')
    expect(() => buildSdArgs({ threads: 0 })).toThrow('threads must be >=1, got 0')
  })
})

function bodyOfCall(call: unknown): Record<string, unknown> {
  const init = (call as [{ body?: string }, { body?: string }])[1]
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

/** 原生异步任务流 mock：POST img_gen → 202 job；GET job → done + images */
function jobFlowFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/sdcpp/v1/img_gen')) {
      return new Response(JSON.stringify({ id: 'job_1', poll_url: '/sdcpp/v1/jobs/job_1', status: 'queued' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.includes('/sdcpp/v1/jobs/job_1')) {
      return new Response(
        JSON.stringify({ id: 'job_1', status: 'done', result: { images: [{ b64_json: 'b64' }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('not found', { status: 404 })
  })
}

describe('characterization: generateImage native job flow (阶段0 升级 sd-server)', () => {
  it('prompt-only 请求提交 img_gen：steps 折叠进 sample_params.sample_steps，其余字段直传', async () => {
    const fetchImpl = jobFlowFetch()
    await generateImage({ prompt: 'a cat', steps: 20, seed: 42 }, { fetchImpl: fetchImpl as never, pollMs: 1 })
    const submit = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/img_gen'))
    const body = bodyOfCall(submit)
    expect(body['prompt']).toBe('a cat')
    expect(body['seed']).toBe(42)
    expect(body['sample_params']).toEqual({ sample_steps: 20 })
    expect(body['init_image']).toBeUndefined()
    expect(body['mask_image']).toBeUndefined()
  })

  it('unknown extra request fields pass through into the JSON body untouched', async () => {
    const fetchImpl = jobFlowFetch()
    await generateImage({ prompt: 'a cat', clip_skip: 2 } as never, { fetchImpl: fetchImpl as never, pollMs: 1 })
    const submit = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/img_gen'))
    const body = bodyOfCall(submit)
    expect(body['clip_skip']).toBe(2)
    expect(body['prompt']).toBe('a cat')
  })

  it('img2img：initImagePath/maskPath 读盘转 base64 进 init_image/mask_image', async () => {
    const fetchImpl = jobFlowFetch()
    await generateImage(
      { prompt: 'p', initImagePath: 'C:\\tmp\\init.png', maskPath: 'C:\\tmp\\mask.png', strength: 0.6 },
      { fetchImpl: fetchImpl as never, pollMs: 1, fsRead: (p) => Buffer.from(`bytes:${p}`) },
    )
    const submit = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/img_gen'))
    const body = bodyOfCall(submit)
    expect(body['init_image']).toBe(Buffer.from('bytes:C:\\tmp\\init.png').toString('base64'))
    expect(body['mask_image']).toBe(Buffer.from('bytes:C:\\tmp\\mask.png').toString('base64'))
    expect(body['strength']).toBe(0.6)
  })

  it('完整任务流：提交 → 轮询 → done 提取 b64_json', async () => {
    const fetchImpl = jobFlowFetch()
    const res = await generateImage({ prompt: 'p' }, { fetchImpl: fetchImpl as never, pollMs: 1 })
    expect(res.image).toBe('b64')
    expect(res.images).toEqual(['b64'])
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/sdcpp/v1/jobs/job_1'))).toBe(true)
  })

  it('任务失败抛 sd job failed', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/img_gen')) {
        return new Response(JSON.stringify({ id: 'job_e', poll_url: '/sdcpp/v1/jobs/job_e' }), { status: 202 })
      }
      return new Response(JSON.stringify({ status: 'failed', error: 'vae decode failed' }), { status: 200 })
    })
    await expect(
      generateImage({ prompt: 'p' }, { fetchImpl: fetchImpl as never, pollMs: 1 }),
    ).rejects.toThrow('vae decode failed')
  })
})