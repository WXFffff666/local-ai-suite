/**
 * W1-8 download session tests — the 'download:progress' event sequence
 * downloading → (polls) → done / error, driven entirely through injected
 * runDownload/measureBytes (never spawns hf-cli/aria2 for real).
 *
 * todo14b adds: cancel(id) terminal 'cancelled' event + hf.killDownloadChild
 * tree-kill, and the fs.statfs ×1.1 disk pre-flight (insufficient-disk ack,
 * no session, no child).
 */
import { describe, expect, it, vi } from 'vitest'

// hf.ts is mocked wholesale: DownloadManager only needs downloadWithResume
// (replaced by the runDownload seam) and killDownloadChild (cancel proof).
const killDownloadChild = vi.fn(() => ({ killed: true, pid: 4242 }))
vi.mock('../../market/hf', () => ({
  downloadWithResume: vi.fn(),
  killDownloadChild: (id: string) => killDownloadChild(id)
}))

import { DISK_HEADROOM, DownloadManager, resolveLocalDir } from './downloadManager'
import type { DownloadProgressEvent } from './whitelist'

function harness(
  opts: {
    measure?: number[]
    runDownload?: (repoId: string) => Promise<unknown>
    statfs?: (dir: string) => Promise<{ bsize: number; bavail: number }>
  } = {}
) {
  const events: DownloadProgressEvent[] = []
  const sizes = opts.measure ?? [0]
  let idx = 0
  const runDownload = vi.fn(async (repoId: string) => opts.runDownload?.(repoId) ?? { ok: true })
  const dm = new DownloadManager({
    emit: (ev) => events.push(ev),
    measureBytes: () => sizes[Math.min(idx++, sizes.length - 1)] ?? 0,
    pollIntervalMs: 1_000_000, // interval never fires; terminal samples are deterministic
    nextId: () => 'dl-fixed',
    runDownload,
    ...(opts.statfs === undefined ? {} : { statfs: opts.statfs })
  })
  return { dm, events, runDownload }
}

const input = { id: 'dl-fixed', repoId: 'QQQQ/Qwen3-4B', localDir: 'D:/tmp/models/qwen' } as const

describe('DownloadManager', () => {
  it('emits downloading immediately, then done with total===received', async () => {
    const { dm, events } = harness({ measure: [1024] })
    const ack = await dm.start({ ...input })
    expect(ack).toEqual({ ok: true, id: 'dl-fixed', repoId: 'QQQQ/Qwen3-4B', state: 'downloading' })
    expect(events[0]).toEqual({ id: 'dl-fixed', repoId: 'QQQQ/Qwen3-4B', received: 0, total: 0, state: 'downloading' })

    await vi.waitFor(() => expect(events.some((e) => e.state === 'done')).toBe(true))
    const last = events[events.length - 1]
    expect(last).toEqual({ id: 'dl-fixed', repoId: 'QQQQ/Qwen3-4B', received: 1024, total: 1024, state: 'done' })
    expect(dm.active()).toBe(0)
  })

  it('failure emits error state with the message and clears the session', async () => {
    const { dm, events } = harness({
      measure: [512, 512],
      runDownload: async () => {
        throw new Error('hf-cli exited 1')
      }
    })
    await dm.start({ ...input })
    await vi.waitFor(() => expect(events.some((e) => e.state === 'error')).toBe(true))
    const err = events.find((e) => e.state === 'error')
    expect(err?.error).toBe('hf-cli exited 1')
    expect(err?.received).toBe(512)
    expect(dm.active()).toBe(0)
  })

  it('generated id when the caller omits one', async () => {
    const { dm, events } = harness({})
    const ack = await dm.start({ repoId: 'o/r' })
    if (!ack.ok) throw new Error('start should succeed without expectedBytes')
    expect(ack.id).toMatch(/^dl-/)
    expect(events[0]?.id).toBe(ack.id)
  })

  it('forwards filename/quant + sessionId and defaults localDir to models/<repoId flattened>', async () => {
    const runDownload = vi.fn(async () => ({ ok: true }))
    const dm = new DownloadManager({
      emit: () => undefined,
      pollIntervalMs: 1_000_000,
      nextId: () => 'dl-fixed',
      runDownload
    })
    await dm.start({ repoId: 'owner/name', filename: 'x.gguf', quant: 'Q4_K_M' })
    await vi.waitFor(() => expect(runDownload).toHaveBeenCalledTimes(1))
    // sessionId (14b): the hf.ts handle-map key cancel() tree-kills
    expect(runDownload).toHaveBeenCalledWith('owner/name', {
      localDir: 'models/owner__name',
      filename: 'x.gguf',
      quant: 'Q4_K_M',
      sessionId: 'dl-fixed'
    })
  })
})

describe('DownloadManager cancel (todo14b)', () => {
  it('cancel emits terminal cancelled, tree-kills the child, and clears the session', async () => {
    // runDownload pends forever: 'done' cannot race the cancel sample
    const { dm, events } = harness({ measure: [1024], runDownload: () => new Promise(() => undefined) })
    await dm.start({ ...input })
    expect(dm.active()).toBe(1) // registration is synchronous inside start()

    const res = dm.cancel('dl-fixed')
    expect(res).toEqual({ ok: true, id: 'dl-fixed', cancelled: true })
    expect(events.at(-1)).toEqual({
      id: 'dl-fixed',
      repoId: 'QQQQ/Qwen3-4B',
      received: 1024,
      total: 0,
      state: 'cancelled'
    })
    expect(killDownloadChild).toHaveBeenCalledWith('dl-fixed')
    expect(dm.active()).toBe(0)
  })

  it('late child success after cancel emits NO done event (cancelled is terminal)', async () => {
    let resolveRun: () => void = () => undefined
    const { dm, events } = harness({
      measure: [7],
      runDownload: () => new Promise<void>((r) => (resolveRun = r))
    })
    await dm.start({ ...input })
    expect(dm.active()).toBe(1)
    dm.cancel('dl-fixed')
    resolveRun()
    await flushMicrotasks()
    expect(events.some((e) => e.state === 'done')).toBe(false)
    expect(events.some((e) => e.state === 'error')).toBe(false)
  })

  it('unknown or double cancel answers not-found and never kills', async () => {
    killDownloadChild.mockClear()
    const { dm } = harness({ runDownload: () => new Promise(() => undefined) })
    expect(dm.cancel('ghost')).toEqual({ ok: false, error: 'not-found' })
    await dm.start({ ...input })
    expect(dm.active()).toBe(1)
    expect(dm.cancel('dl-fixed')).toEqual({ ok: true, id: 'dl-fixed', cancelled: true })
    expect(dm.cancel('dl-fixed')).toEqual({ ok: false, error: 'not-found' })
    expect(killDownloadChild).toHaveBeenCalledTimes(1)
  })
})

describe('DownloadManager disk pre-flight (todo14b)', () => {
  const GB = 1024 ** 3

  it('free < expectedBytes×1.1 → insufficient-disk ack with {free,needed}, no session, no events, no child', async () => {
    const statfs = vi.fn(async () => ({ bsize: 4096, bavail: Math.floor((2 * GB) / 4096) }))
    const { dm, events, runDownload } = harness({ statfs })
    const res = await dm.start({ ...input, expectedBytes: 3 * GB })
    const needed = Math.ceil(3 * GB * DISK_HEADROOM)
    expect(res).toEqual({ ok: false, error: 'insufficient-disk', free: 2 * GB, needed })
    expect(events).toHaveLength(0)
    expect(runDownload).not.toHaveBeenCalled()
    expect(dm.active()).toBe(0)
    // statfs probes the configured localDir (nearest existing ancestor walk is internal)
    expect(statfs).toHaveBeenCalledTimes(1)
  })

  it('free >= expectedBytes×1.1 → download proceeds normally', async () => {
    const statfs = vi.fn(async () => ({ bsize: 4096, bavail: Math.floor((100 * GB) / 4096) }))
    const { dm, events } = harness({ statfs, measure: [123] })
    const res = await dm.start({ ...input, expectedBytes: 3 * GB })
    expect(res.ok).toBe(true)
    await vi.waitFor(() => expect(events.some((e) => e.state === 'done')).toBe(true))
  })

  it('expectedBytes absent → statfs never called (size unknown, check skipped honestly)', async () => {
    const statfs = vi.fn(async () => ({ bsize: 4096, bavail: 1 }))
    const { dm } = harness({ statfs })
    const res = await dm.start({ ...input })
    expect(res.ok).toBe(true)
    expect(statfs).not.toHaveBeenCalled()
  })

  it('statfs throw (unsupported platform) → check skipped, download proceeds', async () => {
    const statfs = vi.fn(async () => {
      throw new Error('ENOTSUP')
    })
    const { dm } = harness({ statfs })
    const res = await dm.start({ ...input, expectedBytes: GB })
    expect(res.ok).toBe(true)
  })
})

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('resolveLocalDir', () => {
  it('mirrors hf.ts flattening for repo ids with namespaces', () => {
    expect(resolveLocalDir('QQQQ/Qwen3-4B')).toBe('models/QQQQ__Qwen3-4B')
    expect(resolveLocalDir('o/r', 'custom/dir')).toBe('custom/dir')
  })
})
