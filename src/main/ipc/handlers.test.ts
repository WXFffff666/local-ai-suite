/**
 * W1-8 handler unit tests — every channel against stub services (injection
 * convention per learnings.md: no electron import needed; handlers receive
 * dialog/safeStorage as plain deps). Includes the zod 400-shape contract and
 * the honest conversations:not-ready posture until todo17.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { buildIpcHandlers, toImageQueueStatusEvent, type HandlerContext, type ServicesSurface } from './handlers'
import type { ChatRelay } from './chatRelay'
import type { DownloadManager } from './downloadManager'
import type { QueueEvent } from '../../image/queue'

function makeHarness() {
  const services = {
    registry: {
      getModels: vi.fn(() => [{ id: 'm1', name: 'Qwen3' }]),
      reloadModels: vi.fn(() => [{ id: 'm1', name: 'Qwen3' }])
    },
    imageQueue: {
      enqueue: vi.fn(() => 'job-1'),
      getJob: vi.fn((id: string) => ({ id, status: 'queued', warning: 'w', effectiveModel: 'sd1.5-q4' })),
      listJobs: vi.fn(() => [{ id: 'job-9', status: 'done' }]),
      subscribe: vi.fn(() => () => undefined),
      pending: 3
    },
    gallery: {
      list: vi.fn(() => [{ id: 'g1' }]),
      save: vi.fn(() => ({ id: 'saved' })),
      copy: vi.fn(() => ({ path: 'p', b64: 'YQ==', mime: 'image/png' })),
      insert: vi.fn(() => ({ text: 't', imagePath: 'p', b64: 'YQ==', prompt: 'p' })),
      reuse: vi.fn(() => ({ prompt: 'p' }))
    },
    search: { search: vi.fn(async () => ({ raw: [], deduped: [], ranked: [], cards: [], markdown: '' })) },
    ensureSidecar: vi.fn()
  }
  const relay = {
    start: vi.fn(() => ({ ok: true, id: 'c1', streaming: true })),
    abort: vi.fn(() => ({ ok: true, id: 'c1', aborted: true }))
  }
  const downloads = {
    start: vi.fn(() => ({ ok: true, id: 'd1', repoId: 'o/r', state: 'downloading' })),
    cancel: vi.fn((id: string) => (id === 'd1' ? { ok: true, id, cancelled: true } : { ok: false, error: 'not-found' }))
  }
  const hfSearch = vi.fn(async () => [{ id: 'hf1' }])
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
  const conversations = {
    list: vi.fn(async () => []),
    create: vi.fn(async (title?: string) => ({ id: 'chat-1', title: title ?? 'new' })),
    rename: vi.fn(async (id: string, title: string) => ({ id, title })),
    delete: vi.fn(async () => true),
    appendMessage: vi.fn(async (chatId: string, role: string, content: string) => ({ chatId, role, content })),
    listMessages: vi.fn(async () => [])
  }

  const deps = {
    services: services as unknown as ServicesSurface,
    relay: relay as unknown as Pick<ChatRelay, 'start' | 'abort'>,
    downloads: downloads as unknown as Pick<DownloadManager, 'start' | 'cancel'>,
    hfSearch,
    dialog,
    safeStorage
  }
  const handlers = buildIpcHandlers(deps)
  const withHandlers = (extra: { conversations?: () => typeof conversations }) =>
    buildIpcHandlers({ ...deps, ...extra })
  const ctx: HandlerContext = { send: vi.fn() }
  return { handlers, ctx, services, relay, downloads, hfSearch, dialog, safeStorage, conversations, deps, withHandlers }
}

const invalidShape = { ok: false, error: 'invalid-payload', issues: expect.any(Array) }

describe('models channels', () => {
  it('models:list returns registry data (replaces stub)', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['models:list']([], { send: vi.fn() })).resolves.toEqual({
      models: [{ id: 'm1', name: 'Qwen3' }]
    })
  })

  it('models:download forwards validated payload to DownloadManager', async () => {
    const { handlers, downloads } = makeHarness()
    const res = await handlers['models:download']([{ repoId: 'QQQQ/Qwen3-4B', quant: 'Q4_K_M' }], { send: vi.fn() })
    expect(res).toEqual({ ok: true, id: 'd1', repoId: 'o/r', state: 'downloading' })
    expect(downloads.start).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'QQQQ/Qwen3-4B' }))
  })

  it('models:download rejects non owner/name repoId with 400-shape', async () => {
    const { handlers, downloads } = makeHarness()
    const res = await handlers['models:download']([{ repoId: 'no-slash' }], { send: vi.fn() })
    expect(res).toMatchObject(invalidShape)
    expect(downloads.start).not.toHaveBeenCalled()
  })
})

describe('chat channels', () => {
  const validSend = { id: 'c1', model: 'qwen3', messages: [{ role: 'user', content: 'hi' }] }

  it('chat:send starts the relay bound to the sending frame (ctx.send)', async () => {
    const { handlers, relay, ctx } = makeHarness()
    const res = await handlers['chat:send']([validSend], ctx)
    expect(res).toEqual({ ok: true, id: 'c1', streaming: true })
    expect(relay.start).toHaveBeenCalledWith(expect.objectContaining(validSend), ctx.send)
  })

  it('chat:send rejects empty messages with 400-shape', async () => {
    const { handlers, relay } = makeHarness()
    const res = await handlers['chat:send']([{ ...validSend, messages: [] }], { send: vi.fn() })
    expect(res).toMatchObject(invalidShape)
    expect(relay.start).not.toHaveBeenCalled()
  })

  it('chat:send rejects unknown message role with 400-shape', async () => {
    const { handlers } = makeHarness()
    const res = await handlers['chat:send']([{ ...validSend, messages: [{ role: 'wizard', content: 'x' }] }], { send: vi.fn() })
    expect(res).toMatchObject(invalidShape)
  })

  // --- todo21: multimodal content matrix -------------------------------------

  const pngUri = (payloadChars = 64) =>
    `data:image/png;base64,${'A'.repeat(payloadChars - 2)}==`

  it('todo21 accepts legacy plain-string content (baseline pin)', async () => {
    const { handlers, relay } = makeHarness()
    const res = await handlers['chat:send']([validSend], { send: vi.fn() })
    expect(res).toEqual({ ok: true, id: 'c1', streaming: true })
    expect(relay.start).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: 'hi' }] }),
      expect.any(Function)
    )
  })

  it('todo21 accepts text + image_url dataURI parts verbatim', async () => {
    const { handlers, relay } = makeHarness()
    const parts = [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: pngUri() } },
    ]
    const res = await handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content: parts }] }], { send: vi.fn() })
    expect(res).toEqual({ ok: true, id: 'c1', streaming: true })
    expect(relay.start).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ role: 'user', content: parts }] }),
      expect.any(Function)
    )
  })

  it('todo21 accepts ≤2 images per message, rejects a third', async () => {
    const { handlers } = makeHarness()
    const two = [
      { type: 'image_url', image_url: { url: pngUri() } },
      { type: 'image_url', image_url: { url: pngUri() } },
    ]
    await expect(handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content: two }] }], { send: vi.fn() })).resolves.toEqual({ ok: true, id: 'c1', streaming: true })
    const three = [...two, { type: 'image_url', image_url: { url: pngUri() } }]
    const res = await handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content: three }] }], { send: vi.fn() })
    expect(res).toMatchObject({ ok: false, error: 'invalid-payload' })
    expect(JSON.stringify(res)).toContain('too-many-images')
  })

  it('todo21 rejects svg data-URI, remote URLs and raw base64', async () => {
    const { handlers } = makeHarness()
    const bad = [
      'data:image/svg+xml;base64,AAAA',
      'https://evil.example/x.png',
      'http://127.0.0.1:1/x.png',
      'AAAA',
      'data:image/png;base64,!!!not-base64!!!',
    ]
    for (const url of bad) {
      const res = await handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] }], { send: vi.fn() })
      expect(res, url).toMatchObject({ ok: false, error: 'invalid-payload' })
    }
  })

  it('todo21 rejects images whose decoded payload exceeds the 4MiB cap', async () => {
    const { handlers } = makeHarness()
    // 4 MiB decoded = 4,194,304 bytes ⇔ 5,592,456 base64 chars; a block over the cap.
    const huge = `data:image/png;base64,${'A'.repeat(5_592_408)}`
    const res = await handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: huge } }] }] }], { send: vi.fn() })
    expect(res).toMatchObject({ ok: false, error: 'invalid-payload' })
    // just below the cap parses (char-guard headroom kept honest):
    const ok = `data:image/png;base64,${'A'.repeat(4_000_000 - 4)}`
    await expect(handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: ok } }] }] }], { send: vi.fn() })).resolves.toEqual({ ok: true, id: 'c1', streaming: true })
  })

  it('todo21 rejects malformed parts (unknown type / missing fields / extra keys)', async () => {
    const { handlers } = makeHarness()
    const malformed: unknown[] = [
      [{ type: 'audio', data: 'x' }],
      [{ type: 'text' }],
      [{ type: 'image_url' }],
      [{ type: 'text', text: 'ok', sneaky: 1 }],
      [],
    ]
    for (const content of malformed) {
      const res = await handlers['chat:send']([{ ...validSend, messages: [{ role: 'user', content }] }], { send: vi.fn() })
      expect(res, JSON.stringify(content)).toMatchObject({ ok: false, error: 'invalid-payload' })
    }
  })

  it('chat:abort cancels the session', async () => {
    const { handlers, relay } = makeHarness()
    await expect(handlers['chat:abort']([{ id: 'c1' }], { send: vi.fn() })).resolves.toEqual({
      ok: true,
      id: 'c1',
      aborted: true
    })
    expect(relay.abort).toHaveBeenCalledWith({ id: 'c1' })
  })

  it('chat:abort rejects missing id', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['chat:abort']([{}], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
  })
})

describe('image channels', () => {
  it('image:generate enqueues and returns 202 + jobId (replaces stub)', async () => {
    const { handlers, services } = makeHarness()
    const res = (await handlers['image:generate']([{ prompt: 'a cat', steps: 20 }], { send: vi.fn() })) as {
      ok: boolean
      statusCode: number
      jobId: string
      warning?: string
      effectiveModel?: string
    }
    expect(res).toMatchObject({ ok: true, statusCode: 202, jobId: 'job-1', warning: 'w', effectiveModel: 'sd1.5-q4' })
    expect(services.imageQueue.enqueue).toHaveBeenCalledWith({ prompt: 'a cat', steps: 20 })
  })

  it('image:generate rejects empty prompt with 400-shape', async () => {
    const { handlers, services } = makeHarness()
    const res = await handlers['image:generate']([{ prompt: '' }], { send: vi.fn() })
    expect(res).toMatchObject(invalidShape)
    expect(services.imageQueue.enqueue).not.toHaveBeenCalled()
  })

  it('image:queue:status branches single job vs roster', async () => {
    const { handlers, services } = makeHarness()
    await expect(handlers['image:queue:status']([{ jobId: 'job-1' }], { send: vi.fn() })).resolves.toMatchObject({
      ok: true,
      job: { id: 'job-1' }
    })
    expect(services.imageQueue.getJob).toHaveBeenCalledWith('job-1')
    const all = (await handlers['image:queue:status']([{}], { send: vi.fn() })) as { jobs: unknown[]; pending: number }
    expect(all.jobs).toHaveLength(1)
    expect(all.pending).toBe(3)
  })

  // --- todo20 img2img/inpaint passthrough ------------------------------------

  it('image:generate img2img mode carries initImagePath + default strength 0.75', async () => {
    const { handlers, services } = makeHarness()
    await handlers['image:generate']([{ prompt: 'cat', mode: 'img2img', initImagePath: 'C:\\t\\a.png' }], { send: vi.fn() })
    expect(services.imageQueue.enqueue).toHaveBeenCalledWith({
      prompt: 'cat',
      mode: 'img2img',
      initImagePath: 'C:\\t\\a.png',
      strength: 0.75
    })
  })

  it('image:generate img2img without initImagePath → 400-shape, no enqueue', async () => {
    const { handlers, services } = makeHarness()
    const res = await handlers['image:generate']([{ prompt: 'cat', mode: 'img2img' }], { send: vi.fn() })
    expect(res).toMatchObject(invalidShape)
    expect(services.imageQueue.enqueue).not.toHaveBeenCalled()
  })

  it('image:generate inpaint without maskPath → 400-shape (rejected msg for UI)', async () => {
    const { handlers, services } = makeHarness()
    const res = (await handlers['image:generate']([{ prompt: 'cat', mode: 'inpaint', initImagePath: 'C:\\t\\a.png' }], { send: vi.fn() })) as {
      issues: Array<{ path: string; message: string }>
    }
    expect(res.issues.some((i) => i.path === 'maskPath')).toBe(true)
    expect(services.imageQueue.enqueue).not.toHaveBeenCalled()
  })

  it('image:generate strength >1 → 400-shape', async () => {
    const { handlers } = makeHarness()
    const res = await handlers['image:generate']([{ prompt: 'cat', mode: 'img2img', initImagePath: 'C:\\a.png', strength: 1.5 }], { send: vi.fn() })
    expect(res).toMatchObject(invalidShape)
  })

  it('image:generate loras pass through; illegal scale rejected', async () => {
    const { handlers, services } = makeHarness()
    await handlers['image:generate']([{ prompt: 'cat', loras: [{ name: 'm', scale: 0.7 }] }], { send: vi.fn() })
    expect(services.imageQueue.enqueue).toHaveBeenCalledWith({ prompt: 'cat', loras: [{ name: 'm', scale: 0.7 }] })
    const bad = await handlers['image:generate']([{ prompt: 'cat', loras: [{ name: 'm', scale: 9 }] }], { send: vi.fn() })
    expect(bad).toMatchObject(invalidShape)
  })
})

describe('image:saveTempImage channel (todo20 drop/mask import)', () => {
  let tmpRoot: string
  let userDataDir: string
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'las-savetemp-'))
    userDataDir = join(tmpRoot, 'userData')
    mkdirSync(userDataDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function harnessWithUserData() {
    const { services, relay, downloads, hfSearch, dialog, safeStorage } = makeHarness()
    const withUd = { ...services, userDataDir } as unknown as ServicesSurface
    const handlers = buildIpcHandlers({ services: withUd, relay, downloads, hfSearch, dialog, safeStorage })
    return { handlers, userDataDir }
  }

  it('合法 PNG dataURL → 落盘 userData/tmp/img-<ts>.png 并返回绝对路径', async () => {
    const { handlers, userDataDir } = harnessWithUserData()
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'
    const res = (await handlers['image:saveTempImage']([{ dataURL: png }], { send: vi.fn() })) as {
      ok: boolean
      path: string
    }
    expect(res.ok).toBe(true)
    expect(res.path.startsWith(join(userDataDir, 'tmp'))).toBe(true)
    expect(res.path).toMatch(/img-\d+.*\.png$/)
    const written = readFileSync(res.path)
    expect(written.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('非 PNG dataURL / 非 dataURL → 400-shape', async () => {
    const { handlers } = harnessWithUserData()
    await expect(handlers['image:saveTempImage']([{ dataURL: 'http://evil/x.png' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
    await expect(handlers['image:saveTempImage']([{ dataURL: 'data:image/jpeg;base64,QQ==' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
  })

  it('解码后 >8MB → dataurl-too-large', async () => {
    const { handlers } = harnessWithUserData()
    const big = 'A'.repeat(9 * 1024 * 1024) // 9MB > 8MB cap
    const b64 = Buffer.from(big, 'latin1').toString('base64')
    const res = (await handlers['image:saveTempImage']([{ dataURL: `data:image/png;base64,${b64}` }], { send: vi.fn() })) as {
      ok?: boolean
      error?: string
    }
    expect(res).toEqual({ ok: false, error: 'dataurl-too-large' })
  })
})

describe('gallery channels', () => {
  it('gallery:list/save/copy/insert/reuse proxy the five verbs', async () => {
    const { handlers, services } = makeHarness()
    const send = { send: vi.fn() }
    await expect(handlers['gallery:list']([], send)).resolves.toEqual({ items: [{ id: 'g1' }] })
    await expect(
      handlers['gallery:save']([{ b64: 'YQ==', prompt: 'cat' }], send)
    ).resolves.toMatchObject({ ok: true, item: { id: 'saved' } })
    await expect(handlers['gallery:copy']([{ id: 'g1' }], send)).resolves.toMatchObject({ ok: true })
    await expect(handlers['gallery:insert']([{ id: 'g1' }], send)).resolves.toMatchObject({ ok: true })
    await expect(handlers['gallery:reuse']([{ id: 'g1' }], send)).resolves.toMatchObject({ ok: true })
    expect(services.gallery.save).toHaveBeenCalledWith({ b64: 'YQ==', prompt: 'cat' })
  })

  it('gallery:save rejects missing b64', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['gallery:save']([{ prompt: 'cat' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
  })
})

describe('search / hf channels', () => {
  it('search:run forwards query with optional count', async () => {
    const { handlers, services } = makeHarness()
    const res = await handlers['search:run']([{ query: 'qwen', count: 5 }], { send: vi.fn() })
    expect(res).toMatchObject({ ok: true })
    expect(services.search.search).toHaveBeenCalledWith('qwen', { count: 5 })
  })

  it('search:run rejects empty query', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['search:run']([{ query: '' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
  })

  it('hf:search injects the market search fn', async () => {
    const { handlers, hfSearch } = makeHarness()
    const res = (await handlers['hf:search']([{ query: 'qwen3', ggufOnly: true }], { send: vi.fn() })) as {
      cards: unknown[]
    }
    expect(res.cards).toHaveLength(1)
    expect(hfSearch).toHaveBeenCalledWith({ query: 'qwen3', ggufOnly: true })
  })
})

describe('conversations channels (todo17 pre-list)', () => {
  it('without provider every verb answers the honest not-ready shape', async () => {
    const { handlers } = makeHarness()
    const send = { send: vi.fn() }
    await expect(handlers['conversations:list']([], send)).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(handlers['conversations:create']([{}], send)).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(
      handlers['conversations:rename']([{ id: 'c', title: 't' }], send)
    ).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(handlers['conversations:delete']([{ id: 'c' }], send)).resolves.toEqual({
      ok: false,
      error: 'not-ready'
    })
    await expect(
      handlers['conversations:appendMessage']([{ chatId: 'c', role: 'user', content: 'hi' }], send)
    ).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(handlers['conversations:listMessages']([{ chatId: 'c' }], send)).resolves.toEqual({
      ok: false,
      error: 'not-ready'
    })
  })

  it('with a provider (todo17 wiring seam) payloads flow through', async () => {
    const { withHandlers, conversations } = makeHarness()
    const handlers = withHandlers({ conversations: () => conversations })
    const send = { send: vi.fn() }
    await expect(handlers['conversations:create']([{ title: 'demo' }], send)).resolves.toEqual({
      ok: true,
      conversation: { id: 'chat-1', title: 'demo' }
    })
    await expect(handlers['conversations:appendMessage']([{ chatId: 'c1', role: 'user', content: 'hi' }], send)).resolves.toMatchObject({
      ok: true
    })
  })

  it('provider-less create still validates its payload first', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['conversations:create']([{ title: '' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
  })
})

describe('pre-W1 channels keep their contract', () => {
  it('health:pulse unchanged', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['health:pulse']([], { send: vi.fn() })).resolves.toEqual({ ok: true, host: '127.0.0.1' })
  })

  it('dialog:confirmDestructive funnels through the single dialog entry', async () => {
    const { handlers, dialog } = makeHarness()
    const res = await handlers['dialog:confirmDestructive']([{ message: 'sure?' }], { send: vi.fn() })
    expect(res).toBe(true)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('secrets:encrypt falls back when OS storage unavailable (advisory A3 single source)', async () => {
    const { handlers } = makeHarness()
    const res = (await handlers['secrets:encrypt'](['hunter2'], { send: vi.fn() })) as { value: string; warning?: string }
    expect(res.value).toMatch(/^enc:fallback:v1:/)
    expect(res.warning).toBe('os-storage-unavailable')
  })

  it('secrets:decrypt passes legacy plaintext through unchanged', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['secrets:decrypt'](['plain-old'], { send: vi.fn() })).resolves.toEqual({
      ok: true,
      value: 'plain-old'
    })
  })

  it('workspace:delete honours dialog cancel with no side effect', async () => {
    const { handlers, dialog } = makeHarness()
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    const res = await handlers['workspace:delete']([{ workspaceId: 'w1' }], { send: vi.fn() })
    expect(res).toMatchObject({ cancelled: true })
  })
})

describe('toImageQueueStatusEvent', () => {
  it('maps QueueEvent and drops the internal data field', () => {
    const ev: QueueEvent = { type: 'progress', jobId: 'j1', progress: 42, status: 'running', message: 'm', attempt: 1, data: { secret: true } }
    expect(toImageQueueStatusEvent(ev)).toEqual({ type: 'progress', jobId: 'j1', progress: 42, status: 'running', message: 'm', attempt: 1 })
  })

  it('omits absent optional fields entirely (stable shape)', () => {
    const ev: QueueEvent = { type: 'queued', jobId: 'j1', progress: 0, status: 'queued' }
    expect(toImageQueueStatusEvent(ev)).not.toHaveProperty('message')
  })
})

// ---------------------------------------------------------------------------
// todo13 / todo14b / todo16 — models:setDir, download:cancel, config:*
// ---------------------------------------------------------------------------

describe('models:setDir (todo13)', () => {
  let tmp = ''
  let origCwd = ''

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'las-setdir-'))
    origCwd = process.cwd()
    process.chdir(tmp)
  })
  afterEach(() => {
    try {
      process.chdir(origCwd)
    } catch {}
    rmSync(tmp, { recursive: true, force: true })
  })

  it('absolute existing dir → persists config.modelsDir + triggers reloadModels spy', async () => {
    const { handlers, services } = makeHarness()
    const dir = mkdtempSync(join(tmp, 'models-'))
    const res = (await handlers['models:setDir']([{ path: dir }], { send: vi.fn() })) as {
      ok: boolean
      modelsDir: string
      restartRequired: boolean
    }
    expect(res.ok).toBe(true)
    expect(res.restartRequired).toBe(true)
    expect(services.registry.reloadModels).toHaveBeenCalledTimes(1)
    // config.json persisted under the tmp cwd (userData fallback)
    const raw = JSON.parse(readFileSync(join(tmp, 'userData', 'config.json'), 'utf-8')) as { modelsDir: string }
    expect(raw.modelsDir).toBe(dir)
  })

  it('relative path rejected with path-not-absolute (no reloadModels)', async () => {
    const { handlers, services } = makeHarness()
    const res = await handlers['models:setDir']([{ path: 'models/relative' }], { send: vi.fn() })
    expect(res).toEqual({ ok: false, error: 'path-not-absolute' })
    expect(services.registry.reloadModels).not.toHaveBeenCalled()
  })

  it('missing dir rejected with dir-not-found', async () => {
    const { handlers } = makeHarness()
    const ghost = join(tmp, 'nope-does-not-exist')
    const res = await handlers['models:setDir']([{ path: ghost }], { send: vi.fn() })
    expect(res).toEqual({ ok: false, error: 'dir-not-found' })
  })

  it('rejects non-string path with 400-shape', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['models:setDir']([{ path: 42 }], { send: vi.fn() })).resolves.toMatchObject({
      ok: false,
      error: 'invalid-payload',
    })
  })
})

describe('download:cancel (todo14b)', () => {
  it('forwards validated id to DownloadManager.cancel', async () => {
    const { handlers, downloads } = makeHarness()
    const res = await handlers['download:cancel']([{ id: 'd1' }], { send: vi.fn() })
    expect(res).toEqual({ ok: true, id: 'd1', cancelled: true })
    expect(downloads.cancel).toHaveBeenCalledWith('d1')
  })

  it('unknown id passes through not-found', async () => {
    const { handlers, downloads } = makeHarness()
    const res = await handlers['download:cancel']([{ id: 'ghost' }], { send: vi.fn() })
    expect(res).toEqual({ ok: false, error: 'not-found' })
    expect(downloads.cancel).toHaveBeenCalledWith('ghost')
  })

  it('missing id rejected with 400-shape', async () => {
    const { handlers, downloads } = makeHarness()
    await expect(handlers['download:cancel']([{}], { send: vi.fn() })).resolves.toMatchObject({
      ok: false,
      error: 'invalid-payload',
    })
    expect(downloads.cancel).not.toHaveBeenCalled()
  })
})

describe('config:get / config:set (todo16)', () => {
  let tmp = ''
  let origCwd = ''

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'las-config-'))
    origCwd = process.cwd()
    process.chdir(tmp)
  })
  afterEach(() => {
    try {
      process.chdir(origCwd)
    } catch {}
    rmSync(tmp, { recursive: true, force: true })
  })

  it('config:get returns defaults before any write', async () => {
    const { handlers } = makeHarness()
    const res = (await handlers['config:get']([{}], { send: vi.fn() })) as { ok: boolean; config: { theme: string } }
    expect(res.ok).toBe(true)
    expect(res.config.theme).toBe('system')
  })

  it('config:set persists theme + locale to disk', async () => {
    const { handlers } = makeHarness()
    const res = (await handlers['config:set']([{ theme: 'dark', locale: 'en' }], { send: vi.fn() })) as {
      ok: boolean
      config: { theme: string; locale: string }
    }
    expect(res.ok).toBe(true)
    expect(res.config.theme).toBe('dark')
    expect(res.config.locale).toBe('en')
    mkdirSync(join(tmp, 'userData'), { recursive: true })
    const raw = JSON.parse(readFileSync(join(tmp, 'userData', 'config.json'), 'utf-8')) as Record<string, unknown>
    expect(raw.theme).toBe('dark')
  })

  it('secret payloads must be enc:v1:/enc:fallback:v1: — plaintext rejected, payload accepted and merged', async () => {
    const { handlers } = makeHarness()
    const bad = await handlers['config:set']([{ secrets: { hfToken: 'hf_plain_secret' } }], { send: vi.fn() })
    expect(bad).toMatchObject({ ok: false, error: 'invalid-payload' })

    const good = (await handlers['config:set'](
      [{ secrets: { hfToken: 'enc:v1:AAA=' } }],
      { send: vi.fn() },
    )) as { ok: boolean; config: { secrets?: Record<string, string> } }
    expect(good.ok).toBe(true)
    expect(good.config.secrets?.hfToken).toBe('enc:v1:AAA=')

    // field-wise merge: second write must not drop the first field
    const second = (await handlers['config:set'](
      [{ secrets: { tavilyApiKey: 'enc:fallback:v1:Qg==' } }],
      { send: vi.fn() },
    )) as { ok: boolean; config: { secrets?: Record<string, string> } }
    expect(second.config.secrets?.hfToken).toBe('enc:v1:AAA=')
    expect(second.config.secrets?.tavilyApiKey).toBe('enc:fallback:v1:Qg==')
  })

  it('unknown key rejected (strict schema)', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['config:set']([{ evil: true }], { send: vi.fn() })).resolves.toMatchObject({
      ok: false,
      error: 'invalid-payload',
    })
  })
})

// ---------------------------------------------------------------------------
// todo23 — agent:start / agent:status / agent:cancel (sessions seam)
// ---------------------------------------------------------------------------

describe('agent channels (todo23)', () => {
  const validStart = { sessionId: 'a1', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3', goal: 'fix the bug' }

  function makeAgentHarness() {
    const harness = makeHarness()
    const agent = {
      start: vi.fn(() => ({ ok: true, sessionId: 'a1', started: true })),
      cancel: vi.fn(() => ({ ok: true, sessionId: 'a1', cancelled: true })),
      status: vi.fn(() => ({ ok: true, status: null }))
    }
    const handlers = buildIpcHandlers({ ...harness.deps, agent: () => agent })
    return { ...harness, agent, handlers }
  }

  it('without the container every channel answers the honest not-ready shape', async () => {
    const { handlers } = makeHarness()
    const send = { send: vi.fn() }
    await expect(handlers['agent:start']([validStart], send)).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(handlers['agent:status']([{ sessionId: 'a1' }], send)).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(handlers['agent:cancel']([{ sessionId: 'a1' }], send)).resolves.toEqual({ ok: false, error: 'not-ready' })
  })

  it('agent:start still validates before the container check', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['agent:start']([{ sessionId: 'a1' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
  })

  it('agent:start rejects remote/https baseUrls, empty goals, oversized caps and extra keys (400-shape)', async () => {
    const { handlers, agent } = makeAgentHarness()
    const send = { send: vi.fn() }
    const bad = [
      { ...validStart, baseUrl: 'https://127.0.0.1:11434' },
      { ...validStart, baseUrl: 'http://evil.example' },
      { ...validStart, goal: '' },
      { ...validStart, maxIterations: 999 },
      { ...validStart, sneaky: 1 },
      {},
    ]
    for (const payload of bad) {
      const res = await handlers['agent:start']([payload], send)
      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false, error: 'invalid-payload' })
    }
    expect(agent.start).not.toHaveBeenCalled()
  })

  it('agent:start forwards the validated request and binds agent:event to the STARTING frame', async () => {
    const { handlers, agent } = makeAgentHarness()
    const ctx = { send: vi.fn() }
    const res = await handlers['agent:start']([validStart], ctx)
    expect(res).toEqual({ ok: true, sessionId: 'a1', started: true })
    expect(agent.start).toHaveBeenCalledTimes(1)
    expect(agent.start.mock.calls[0]?.[0]).toMatchObject(validStart)
    const emit = agent.start.mock.calls[0]?.[1] as (e: unknown) => void
    emit({ type: 'finished', sessionId: 'a1', status: 'completed', iterations: 1, text: 'ok' })
    expect(ctx.send).toHaveBeenCalledWith('agent:event', { type: 'finished', sessionId: 'a1', status: 'completed', iterations: 1, text: 'ok' })
  })

  it('agent:status / agent:cancel pass the sessionId through', async () => {
    const { handlers, agent } = makeAgentHarness()
    const send = { send: vi.fn() }
    await expect(handlers['agent:status']([{ sessionId: 'a1' }], send)).resolves.toEqual({ ok: true, status: null })
    expect(agent.status).toHaveBeenCalledWith('a1')
    await expect(handlers['agent:cancel']([{ sessionId: 'a1' }], send)).resolves.toEqual({ ok: true, sessionId: 'a1', cancelled: true })
    expect(agent.cancel).toHaveBeenCalledWith('a1')
    await expect(handlers['agent:status']([{}], send)).resolves.toMatchObject(invalidShape)
  })
})


// ---------------------------------------------------------------------------
// todo25 - permission:respond (approval bridge seam)
// ---------------------------------------------------------------------------

describe('permission channels (todo25)', () => {
  function makePermissionHarness() {
    const harness = makeHarness()
    const permission = { respond: vi.fn(() => true) }
    const handlers = buildIpcHandlers({ ...harness.deps, permission: () => permission })
    return { ...harness, permission, handlers }
  }

  it('without the bridge the channel answers the honest not-ready shape', async () => {
    const { handlers } = makeHarness()
    await expect(
      handlers['permission:respond']([{ requestId: 'r1', choice: 'once' }], { send: vi.fn() })
    ).resolves.toEqual({ ok: false, error: 'not-ready' })
  })

  it('validation runs before the container check (400 without bridge)', async () => {
    const { handlers } = makeHarness()
    await expect(handlers['permission:respond']([{ requestId: 'r1' }], { send: vi.fn() })).resolves.toMatchObject(
      invalidShape,
    )
  })

  it('off-enum choices and extra keys are rejected (400-shape)', async () => {
    const { handlers, permission } = makePermissionHarness()
    const send = { send: vi.fn() }
    for (const payload of [
      { requestId: 'r1', choice: 'yolo' },
      { requestId: '', choice: 'once' },
      { requestId: 'r1', choice: 'once', extra: 1 },
      {},
    ]) {
      const res = await handlers['permission:respond']([payload], send)
      expect(res, JSON.stringify(payload)).toMatchObject({ ok: false, error: 'invalid-payload' })
    }
    expect(permission.respond).not.toHaveBeenCalled()
  })

  it('routes the validated decision to the bridge; settled -> {ok:true}, stale -> unknown-request', async () => {
    const { handlers, permission } = makePermissionHarness()
    const send = { send: vi.fn() }
    await expect(
      handlers['permission:respond']([{ requestId: 'r1', choice: 'always' }], send)
    ).resolves.toEqual({ ok: true })
    expect(permission.respond).toHaveBeenCalledWith('r1', 'always')
    permission.respond.mockReturnValueOnce(false)
    await expect(
      handlers['permission:respond']([{ requestId: 'gone', choice: 'deny' }], send)
    ).resolves.toEqual({ ok: false, error: 'unknown-request' })
  })
})

// ---------------------------------------------------------------------------
// todo30b — engines:status / engines:gpuDownload / models:launch
// Engines module functions arrive through the deps.engines seam (same
// injection convention as hfSearch/dialog/safeStorage); availability and the
// 21→30 launch hop ride the extended ServicesSurface (real Services already
// exposes engineResolver/getEngineResolutions/launchModel — no index.ts edit).
// ---------------------------------------------------------------------------

import type { ManifestLoad } from '../../engines/manifest'
import type { DownloadPackOptions, DownloadPackResult, NvidiaInfo } from '../../engines/gpuPack'
import type { EngineResolver, ResolvedEngine } from '../../engines/resolver'

const MANIFEST_OK: ManifestLoad = {
  status: 'ok',
  path: 'X:/manifest.json',
  manifest: {
    version: 1,
    generated_at: '2026-09-01T00:00:00Z',
    baseUrlTemplate: 'https://example/{engine}/{variant}/{file}',
    engines: {
      llama: {
        cpu: { file: 'llama-server.exe', sha256: 'a'.repeat(64), minVersion: 'b1', platform: 'win32' },
        gpu: {
          cuda: { file: 'llama-server-cuda.exe', sha256: 'b'.repeat(64) },
          vulkan: { file: 'llama-server-vulkan.exe', sha256: 'c'.repeat(64) },
        },
      },
      sd: {
        cpu: { file: 'sd-cli.exe', sha256: 'd'.repeat(64), minVersion: '0.1', platform: 'win32' },
        gpu: { cuda: { file: 'sd-cli-cuda.exe', sha256: 'e'.repeat(64) } },
      },
    },
  },
}

const RESOLUTIONS: ResolvedEngine[] = [
  { name: 'llama', source: 'bundled-cpu', bin: 'X:/engines/llama-server.exe', version: 'b4000', skipped: [] },
  { name: 'ollama', source: 'none', bin: null, skipped: [{ source: 'system', reason: 'not on PATH' }] },
]

const NVIDIA_OK: NvidiaInfo = { available: true, name: 'RTX 4060', driverVersion: '552.22', memoryMB: 8188 }

function makeEnginesHarness(overrides: {
  manifestLoad?: ManifestLoad
  nvidia?: NvidiaInfo
  downloadPack?: (opts: DownloadPackOptions) => Promise<DownloadPackResult>
  resolver?: EngineResolver | null
} = {}) {
  const harness = makeHarness()
  const invalidated = vi.fn()
  const resolver: EngineResolver | null =
    overrides.resolver === undefined
      ? { resolve: vi.fn(), availability: vi.fn(async () => RESOLUTIONS), invalidate: invalidated }
      : overrides.resolver
  const services = Object.assign(harness.services, {
    engineResolver: resolver,
    getEngineResolutions: vi.fn(() => RESOLUTIONS),
    launchModel: vi.fn(async (id: string) => {
      if (id === 'missing') throw new Error(`model not found: ${id}`)
      return { name: 'llama', running: true, port: 11435, healthUrl: 'http://127.0.0.1:11435/health', failures: 0, restarts: 0, state: 'running' as const }
    }),
  })
  const downloadPack = overrides.downloadPack ?? (async (opts: DownloadPackOptions): Promise<DownloadPackResult> => {
    opts.onProgress?.({ percent: 42, downloaded: 420, total: 1000, stage: 'downloading' })
    opts.onProgress?.({ percent: 100, downloaded: 1000, total: 1000, stage: 'verifying' })
    opts.onProgress?.({ percent: 100, downloaded: 0, total: null, stage: 'activating' })
    return { ok: true, dir: 'X:/engines/llama-cuda', file: 'X:/engines/llama-cuda/s.exe', shaVerified: true }
  })
  const engines = {
    detectNvidia: vi.fn(async (): Promise<NvidiaInfo> => overrides.nvidia ?? NVIDIA_OK),
    loadEngineManifest: vi.fn((): ManifestLoad => overrides.manifestLoad ?? MANIFEST_OK),
    downloadPack: vi.fn(downloadPack),
  }
  const handlers = buildIpcHandlers({ ...harness.deps, services: services as unknown as ServicesSurface, engines })
  const drain = () => new Promise((r) => setImmediate(r))
  return { ...harness, services, resolver, engines, handlers, invalidated, downloadPack: engines.downloadPack, drain }
}

describe('engines:status (todo30b)', () => {
  it('returns availability matrix + nvidia summary + manifest summary', async () => {
    const { handlers, ctx } = makeEnginesHarness()
    const res = (await handlers['engines:status']([{}], ctx)) as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(res.resolutions).toEqual(RESOLUTIONS)
    expect(res.nvidia).toEqual(NVIDIA_OK)
    expect(res.manifest).toEqual({ present: true, generatedAt: '2026-09-01T00:00:00Z', variants: { llama: ['cuda', 'vulkan'], sd: ['cuda'] } })
  })

  it('dev-absent manifest → present:false + empty variants; detect failure → nvidia:null', async () => {
    const { handlers, ctx } = makeEnginesHarness({
      manifestLoad: { status: 'absent', path: 'X:/none.json', warnings: ['w'] },
      nvidia: { available: false, reason: 'no-nvidia-smi' },
    })
    const res = (await handlers['engines:status']([{}], ctx)) as Record<string, unknown>
    expect(res.manifest).toEqual({ present: false, generatedAt: null, variants: {} })
    expect(res.nvidia).toEqual({ available: false, reason: 'no-nvidia-smi' })
  })

  it('resolver disabled (null) → falls back to services.getEngineResolutions cache', async () => {
    const { handlers, ctx, services } = makeEnginesHarness({ resolver: null })
    const res = (await handlers['engines:status']([{}], ctx)) as Record<string, unknown>
    expect(res.resolutions).toEqual(RESOLUTIONS)
    expect(services.getEngineResolutions).toHaveBeenCalled()
  })

  it('rejects unknown payload keys with the 400-shape', async () => {
    const { handlers, ctx } = makeEnginesHarness()
    await expect(handlers['engines:status']([{ evil: 1 }], ctx)).resolves.toMatchObject(invalidShape)
  })
})

describe('engines:gpuDownload (todo30b)', () => {
  const req = { engine: 'llama', variant: 'cuda' }

  it('ack {ok:true}; progress stages stream as engines:progress and end in done; resolver invalidated', async () => {
    const { handlers, ctx, downloadPack, invalidated, drain } = makeEnginesHarness()
    await expect(handlers['engines:gpuDownload']([req], ctx)).resolves.toEqual({ ok: true })
    await drain()
    expect(downloadPack).toHaveBeenCalledWith(
      expect.objectContaining({ engine: 'llama', variant: 'cuda', userDataDir: undefined, manifest: MANIFEST_OK.manifest }),
    )
    const events = (ctx.send as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'engines:progress')
      .map((c) => c[1] as Record<string, unknown>)
    expect(events.map((e) => e.state)).toEqual(['downloading', 'verifying', 'activating', 'done'])
    expect(events[0]).toMatchObject({ engine: 'llama', variant: 'cuda', received: 420, total: 1000 })
    expect(invalidated).toHaveBeenCalledTimes(1)
  })

  it('sha256-mismatch → terminal quarantined state with CPU-fallback note; no invalidation', async () => {
    const { handlers, ctx, invalidated, drain } = makeEnginesHarness({
      downloadPack: async (opts) => {
        opts.onProgress?.({ percent: 100, downloaded: 1000, total: 1000, stage: 'verifying' })
        return { ok: false, reason: 'sha256-mismatch', quarantine: 'X:/engines/.quarantine' }
      },
    })
    await expect(handlers['engines:gpuDownload']([req], ctx)).resolves.toEqual({ ok: true })
    await drain()
    const events = (ctx.send as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => c[0] === 'engines:progress')
      .map((c) => c[1] as Record<string, unknown>)
    expect(events[events.length - 1]).toMatchObject({ state: 'quarantined', note: expect.stringContaining('回退') })
    expect(invalidated).not.toHaveBeenCalled()
  })

  it('download-error → terminal error state carrying the reason', async () => {
    const { handlers, ctx, drain } = makeEnginesHarness({
      downloadPack: async () => ({ ok: false, reason: 'download-error:timeout' }),
    })
    await handlers['engines:gpuDownload']([req], ctx)
    await drain()
    const events = (ctx.send as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'engines:progress')
    expect(events[events.length - 1]?.[1]).toMatchObject({ state: 'error', note: 'download-error:timeout' })
  })

  it('manifest missing/invalid → {ok:false,error:"manifest-missing"}, download never starts', async () => {
    for (const load of [
      { status: 'absent', path: 'p', warnings: [] } as ManifestLoad,
      { status: 'invalid', path: 'p', errors: ['x'] } as ManifestLoad,
    ]) {
      const { handlers, ctx, downloadPack } = makeEnginesHarness({ manifestLoad: load })
      await expect(handlers['engines:gpuDownload']([req], ctx)).resolves.toEqual({ ok: false, error: 'manifest-missing' })
      expect(downloadPack).not.toHaveBeenCalled()
    }
  })

  it('variant not in the manifest → {ok:false,error:"unknown-variant"}', async () => {
    const { handlers, ctx, downloadPack } = makeEnginesHarness()
    await expect(handlers['engines:gpuDownload']([{ engine: 'llama', variant: 'rocm' }], ctx)).resolves.toEqual({
      ok: false,
      error: 'unknown-variant',
    })
    expect(downloadPack).not.toHaveBeenCalled()
  })

  it('second request while one is in flight → {ok:false,error:"already-downloading"}', async () => {
    let release: (r: DownloadPackResult) => void = () => undefined
    const { handlers, ctx } = makeEnginesHarness({
      downloadPack: () => new Promise<DownloadPackResult>((resolve) => (release = resolve)),
    })
    await expect(handlers['engines:gpuDownload']([req], ctx)).resolves.toEqual({ ok: true })
    await expect(handlers['engines:gpuDownload']([req], ctx)).resolves.toEqual({ ok: false, error: 'already-downloading' })
    release({ ok: true, dir: 'd', file: 'f', shaVerified: true })
    await new Promise((r) => setImmediate(r))
    // lane free again after completion
    await expect(handlers['engines:gpuDownload']([req], ctx)).resolves.toEqual({ ok: true })
  })

  it('engine off the manifest enum + variant over 64 chars → 400-shape', async () => {
    const { handlers, ctx, downloadPack } = makeEnginesHarness()
    await expect(handlers['engines:gpuDownload']([{ engine: 'ollama', variant: 'cuda' }], ctx)).resolves.toMatchObject(invalidShape)
    await expect(handlers['engines:gpuDownload']([{ engine: 'llama', variant: 'x'.repeat(65) }], ctx)).resolves.toMatchObject(invalidShape)
    await expect(handlers['engines:gpuDownload']([{}], ctx)).resolves.toMatchObject(invalidShape)
    expect(downloadPack).not.toHaveBeenCalled()
  })
})

describe('models:launch (todo30b)', () => {
  it('delegates to services.launchModel and reports the sidecar status', async () => {
    const { handlers, services } = makeEnginesHarness()
    const res = (await handlers['models:launch']([{ modelId: 'qwen3-4b' }], { send: vi.fn() })) as Record<string, unknown>
    expect(services.launchModel).toHaveBeenCalledWith('qwen3-4b')
    expect(res).toEqual({
      ok: true,
      status: { name: 'llama', running: true, port: 11435, healthUrl: 'http://127.0.0.1:11435/health', failures: 0, restarts: 0, state: 'running' },
    })
  })

  it('service failures surface as {ok:false,error} — never throw across the wire', async () => {
    const { handlers } = makeEnginesHarness()
    await expect(handlers['models:launch']([{ modelId: 'missing' }], { send: vi.fn() })).resolves.toEqual({
      ok: false,
      error: 'model not found: missing',
    })
  })

  it('empty modelId → 400-shape, launchModel untouched', async () => {
    const { handlers, services } = makeEnginesHarness()
    await expect(handlers['models:launch']([{ modelId: '' }], { send: vi.fn() })).resolves.toMatchObject(invalidShape)
    expect(services.launchModel).not.toHaveBeenCalled()
  })
})

// --- update channels (todo32) -------------------------------------------------

describe('update:check / update:downloadAndInstall (todo32)', () => {
  function makeUpdaterHarness() {
    const base = makeHarness()
    const check = vi.fn(() => ({ ok: true as const }))
    const downloadAndInstall = vi.fn(() => ({ ok: true as const, action: 'downloading' as const }))
    const handlers = buildIpcHandlers({
      ...base.deps,
      updater: () => ({ check, downloadAndInstall })
    })
    return { ...base, handlers, check, downloadAndInstall }
  }

  it('without the updater seam both channels answer the honest not-ready shape', async () => {
    const { handlers, ctx } = makeHarness()
    await expect(handlers['update:check']([], ctx)).resolves.toEqual({ ok: false, error: 'not-ready' })
    await expect(handlers['update:downloadAndInstall']([], ctx)).resolves.toEqual({
      ok: false,
      error: 'not-ready'
    })
  })

  it('thin delegation: empty args ack through to the updater surface', async () => {
    const { handlers, ctx, check, downloadAndInstall } = makeUpdaterHarness()
    await expect(handlers['update:check']([], ctx)).resolves.toEqual({ ok: true })
    expect(check).toHaveBeenCalledTimes(1)
    await expect(handlers['update:downloadAndInstall']([{}], ctx)).resolves.toEqual({
      ok: true,
      action: 'downloading'
    })
    expect(downloadAndInstall).toHaveBeenCalledTimes(1)
  })

  it('strict-empty zod: any stray payload is the 400-shape, updater untouched', async () => {
    const { handlers, ctx, check, downloadAndInstall } = makeUpdaterHarness()
    await expect(handlers['update:check']([{ force: true }], ctx)).resolves.toMatchObject(invalidShape)
    await expect(handlers['update:downloadAndInstall']([{ path: 'C:\\evil.exe' }], ctx)).resolves.toMatchObject(
      invalidShape
    )
    expect(check).not.toHaveBeenCalled()
    expect(downloadAndInstall).not.toHaveBeenCalled()
  })

  it('updater invalid-state replies cross the wire unchanged', async () => {
    const base = makeHarness()
    const handlers = buildIpcHandlers({
      ...base.deps,
      updater: () => ({
        check: () => ({ ok: true }),
        downloadAndInstall: () => ({ ok: false, error: 'invalid-state' })
      })
    })
    await expect(handlers['update:downloadAndInstall']([], base.ctx)).resolves.toEqual({
      ok: false,
      error: 'invalid-state'
    })
  })
})
