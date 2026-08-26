import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  IMAGES_GENERATIONS_PATH,
  API_GENERATE_IMAGE_PATH,
  DEFAULT_SIZE,
  parseSize,
  normalizeN,
  validatePrompt,
  generateB64List,
  handleImagesGenerations,
  handleGenerateImage,
  handleImagesRequest,
  createImagesHandler,
  getImagesGenerationsUrl,
  getApiGenerateImageUrl,
  HttpError,
} from './images'

const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

function mockGenerateImpl(map: Record<string, unknown> = {}) {
  return vi.fn(async (req: { prompt: string }) => {
    // echo back image
    if ((map as Record<string, unknown>)['__fail']) throw new Error(String((map as Record<string, unknown>)['__fail']))
    return { image: B64, ...map, seed: 1 }
  })
}

describe('images api constants', () => {
  it('routes are POST /v1/images/generations and POST /api/generate-image', () => {
    expect(IMAGES_GENERATIONS_PATH).toBe('/v1/images/generations')
    expect(API_GENERATE_IMAGE_PATH).toBe('/api/generate-image')
    expect(getImagesGenerationsUrl()).toBe('http://127.0.0.1:11436/v1/images/generations')
    expect(getApiGenerateImageUrl()).toBe('http://127.0.0.1:11436/api/generate-image')
  })
})

describe('parseSize / normalizeN / validatePrompt', () => {
  it('parseSize default 512x512 and valid sizes', () => {
    expect(parseSize()).toEqual({ width: 512, height: 512 })
    expect(parseSize('1024x1024')).toEqual({ width: 1024, height: 1024 })
    expect(parseSize('512x768')).toEqual({ width: 512, height: 768 })
  })
  it('parseSize throws on invalid', () => {
    expect(() => parseSize('bad')).toThrow(/invalid size/)
    expect(() => parseSize('10x10')).toThrow(/range/)
    expect(() => parseSize('5000x5000')).toThrow(/range/)
  })
  it('normalizeN defaults and validates 1..4', () => {
    expect(normalizeN(undefined)).toBe(1)
    expect(normalizeN(2)).toBe(2)
    expect(() => normalizeN(0)).toThrow(/invalid n/)
    expect(() => normalizeN(5)).toThrow(/invalid n/)
    expect(() => normalizeN('2')).toBeTruthy // string numeric allowed
    expect(normalizeN('2')).toBe(2)
  })
  it('validatePrompt requires non-empty string', () => {
    expect(validatePrompt(' a cat ')).toBe('a cat')
    expect(() => validatePrompt('')).toThrow(/prompt/)
    expect(() => validatePrompt('   ')).toThrow(/prompt/)
    expect(() => validatePrompt(null as never)).toThrow(/prompt/)
  })
})

describe('generateB64List — prompt直出，无工作流', () => {
  it('单图 prompt直出 b64_json', async () => {
    const gen = mockGenerateImpl()
    const out = await generateB64List({ prompt: 'a cat, 8k' } as never, { generateImpl: gen as never })
    expect(out).toEqual([B64])
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'a cat, 8k', width: 512, height: 512 }), expect.anything())
  })

  it('size 解析为 width/height', async () => {
    const gen = mockGenerateImpl()
    await generateB64List({ prompt: 'hi', size: '768x512' } as never, { generateImpl: gen as never })
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ width: 768, height: 512 }), expect.anything())
  })

  it('width/height 直传优先于 size (/api/generate-image)', async () => {
    const gen = mockGenerateImpl()
    await generateB64List({ prompt: 'hi', width: 256, height: 256 } as never, { generateImpl: gen as never })
    expect(gen).toHaveBeenCalledWith(expect.objectContaining({ width: 256, height: 256 }), expect.anything())
  })

  it('n>1 串行生成 N 张', async () => {
    const gen = mockGenerateImpl()
    const out = await generateB64List({ prompt: 'hi', n: 3 } as never, { generateImpl: gen as never })
    expect(out).toHaveLength(3)
    expect(gen).toHaveBeenCalledTimes(3)
  })

  it('拒绝 workflow JSON', async () => {
    const gen = mockGenerateImpl()
    await expect(generateB64List({ prompt: 'hi', workflow: { nodes: [] } } as never, { generateImpl: gen as never })).rejects.toThrow(/workflow/)
    await expect(generateB64List({ prompt: 'hi', workflow_json: '{}' } as never, { generateImpl: gen as never })).rejects.toThrow(/workflow/)
    expect(gen).not.toHaveBeenCalled()
  })

  it('prompt 为空 400', async () => {
    const gen = mockGenerateImpl()
    await expect(generateB64List({ prompt: '' } as never, { generateImpl: gen as never })).rejects.toThrow(/prompt/)
  })

  it('从 sd 的 images[] 抽取首张', async () => {
    const gen = vi.fn(async () => ({ images: [B64, B64] }))
    const out = await generateB64List({ prompt: 'hi' } as never, { generateImpl: gen as never })
    expect(out[0]).toBe(B64)
  })
})

describe('handleImagesGenerations — OpenAI 兼容 shape', () => {
  it('返回 {created, data:[{b64_json}]}', async () => {
    const gen = mockGenerateImpl()
    const res = await handleImagesGenerations({ prompt: 'a dog' }, { generateImpl: gen as never })
    expect(res.created).toBeGreaterThan(0)
    expect(res.data).toHaveLength(1)
    expect(res.data[0]!.b64_json).toBe(B64)
  })

  it('n=2 返回 2 项', async () => {
    const gen = mockGenerateImpl()
    const res = await handleImagesGenerations({ prompt: 'hi', n: 2 }, { generateImpl: gen as never })
    expect(res.data).toHaveLength(2)
  })

  it('handleGenerateImage 为别名，行为一致', async () => {
    const gen = mockGenerateImpl()
    const a = await handleImagesGenerations({ prompt: 'hi' }, { generateImpl: gen as never })
    const b = await handleGenerateImage({ prompt: 'hi' }, { generateImpl: mockGenerateImpl() as never })
    expect(a.data[0]!.b64_json).toBe(b.data[0]!.b64_json)
  })
})

describe('handleImagesRequest — fetch-style router (POST two paths)', () => {
  it('POST /v1/images/generations 成功 200 OpenAI shape', async () => {
    const gen = mockGenerateImpl()
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    })
    const res = await handleImagesRequest(req, { generateImpl: gen as never })
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { created: number; data: { b64_json: string }[] }
    expect(json.data[0]!.b64_json).toBe(B64)
    expect(json.created).toBeGreaterThan(0)
  })

  it('POST /api/generate-image 别名同样 200', async () => {
    const gen = mockGenerateImpl()
    const req = new Request('http://127.0.0.1:11436/api/generate-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat', size: '256x256' }),
    })
    const res = await handleImagesRequest(req, { generateImpl: gen as never })
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { data: { b64_json: string }[] }
    expect(json.data[0]!.b64_json).toBe(B64)
  })

  it('非 POST 返回 405', async () => {
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', { method: 'GET' })
    const res = await handleImagesRequest(req, { generateImpl: mockGenerateImpl() as never })
    expect(res!.status).toBe(405)
  })

  it('prompt 缺失返回 400', async () => {
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const res = await handleImagesRequest(req, { generateImpl: mockGenerateImpl() as never })
    expect(res!.status).toBe(400)
    const j = (await res!.json()) as { error: string }
    expect(j.error).toMatch(/prompt/)
  })

  it('workflow JSON 返回 400', async () => {
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', workflow: { a: 1 } }),
    })
    const res = await handleImagesRequest(req, { generateImpl: mockGenerateImpl() as never })
    expect(res!.status).toBe(400)
    expect(((await res!.json()) as { error: string }).error).toMatch(/workflow/)
  })

  it('response_format 非 b64_json 返回 400', async () => {
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', response_format: 'url' }),
    })
    const res = await handleImagesRequest(req, { generateImpl: mockGenerateImpl() as never })
    expect(res!.status).toBe(400)
  })

  it('非法 size 返回 400', async () => {
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', size: 'bad' }),
    })
    const res = await handleImagesRequest(req, { generateImpl: mockGenerateImpl() as never })
    expect(res!.status).toBe(400)
  })

  it('非法路径返回 null (非本路由)', async () => {
    const req = new Request('http://127.0.0.1:11436/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    const res = await handleImagesRequest(req, { generateImpl: mockGenerateImpl() as never })
    expect(res).toBeNull()
  })

  it('createImagesHandler 可挂载', async () => {
    const handler = createImagesHandler({ generateImpl: mockGenerateImpl() as never })
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    })
    const res = await handler(req)
    expect(res!.status).toBe(200)
  })

  it('通过 fetchImpl 注入真实 sd 调用 (mock fetch) 直出 PNG b64', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ image: B64 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const req = new Request('http://127.0.0.1:11436/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    const res = await handleImagesRequest(req, { fetchImpl: fetchImpl as never })
    expect(res!.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/generate'), expect.objectContaining({ method: 'POST' }))
  })
})
