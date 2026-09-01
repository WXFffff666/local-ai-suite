/**
 * W1-8 handler unit tests — every channel against stub services (injection
 * convention per learnings.md: no electron import needed; handlers receive
 * dialog/safeStorage as plain deps). Includes the zod 400-shape contract and
 * the honest conversations:not-ready posture until todo17.
 */
import { describe, expect, it, vi } from 'vitest'

import { buildIpcHandlers, toImageQueueStatusEvent, type HandlerContext, type ServicesSurface } from './handlers'
import type { ChatRelay } from './chatRelay'
import type { DownloadManager } from './downloadManager'
import type { QueueEvent } from '../../image/queue'

function makeHarness() {
  const services = {
    registry: { getModels: vi.fn(() => [{ id: 'm1', name: 'Qwen3' }]) },
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
  const downloads = { start: vi.fn(() => ({ ok: true, id: 'd1', repoId: 'o/r', state: 'downloading' })) }
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
    downloads: downloads as unknown as Pick<DownloadManager, 'start'>,
    hfSearch,
    dialog,
    safeStorage
  }
  const handlers = buildIpcHandlers(deps)
  const withHandlers = (extra: { conversations?: () => typeof conversations }) =>
    buildIpcHandlers({ ...deps, ...extra })
  const ctx: HandlerContext = { send: vi.fn() }
  return { handlers, ctx, services, relay, downloads, hfSearch, dialog, safeStorage, conversations, withHandlers }
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
