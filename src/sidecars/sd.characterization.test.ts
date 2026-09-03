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
    expect(buildSdArgs()).toEqual(['--host', '127.0.0.1', '--port', '11436'])
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
      '--host', '127.0.0.1',
      '--port', '11436',
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
      '--host', '127.0.0.1',
      '--port', '11436',
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
describe('characterization: generateImage body baseline (pre-lora/img2img)', () => {
  it('prompt-only request posts JSON body with exactly the request fields', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ image: 'b64' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await generateImage({ prompt: 'a cat', steps: 20, seed: 42 }, { fetchImpl: fetchImpl as never })
    const body = bodyOfCall(fetchImpl.mock.calls[0])
    expect(body).toEqual({ prompt: 'a cat', steps: 20, seed: 42 })
  })

  it('unknown extra request fields pass through into the JSON body untouched', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ image: 'b64' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await generateImage({ prompt: 'a cat', clip_skip: 2 } as never, { fetchImpl: fetchImpl as never })
    const body = bodyOfCall(fetchImpl.mock.calls[0])
    expect(body['clip_skip']).toBe(2)
    expect(body['prompt']).toBe('a cat')
  })
})