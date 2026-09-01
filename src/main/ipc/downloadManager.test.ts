/**
 * W1-8 download session tests — the 'download:progress' event sequence
 * downloading → (polls) → done / error, driven entirely through injected
 * runDownload/measureBytes (never spawns hf-cli/aria2 for real).
 */
import { describe, expect, it, vi } from 'vitest'

import { DownloadManager } from './downloadManager'
import type { DownloadProgressEvent } from './whitelist'

function harness(opts: { measure?: number[]; runDownload?: (repoId: string) => Promise<unknown> }) {
  const events: DownloadProgressEvent[] = []
  const sizes = opts.measure ?? [0]
  let idx = 0
  const dm = new DownloadManager({
    emit: (ev) => events.push(ev),
    measureBytes: () => sizes[Math.min(idx++, sizes.length - 1)] ?? 0,
    pollIntervalMs: 1_000_000, // interval never fires; terminal samples are deterministic
    nextId: () => 'dl-fixed',
    runDownload: vi.fn(async (repoId: string) => opts.runDownload?.(repoId) ?? { ok: true })
  })
  return { dm, events }
}

const input = { id: 'dl-fixed', repoId: 'QQQQ/Qwen3-4B', localDir: 'D:/tmp/models/qwen' } as const

describe('DownloadManager', () => {
  it('emits downloading immediately, then done with total===received', async () => {
    const { dm, events } = harness({ measure: [1024] })
    const ack = dm.start({ ...input })
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
    dm.start({ ...input })
    await vi.waitFor(() => expect(events.some((e) => e.state === 'error')).toBe(true))
    const err = events.find((e) => e.state === 'error')
    expect(err?.error).toBe('hf-cli exited 1')
    expect(err?.received).toBe(512)
    expect(dm.active()).toBe(0)
  })

  it('generated id when the caller omits one', () => {
    const { dm, events } = harness({})
    const ack = dm.start({ repoId: 'o/r' })
    expect(ack.id).toMatch(/^dl-/)
    expect(events[0]?.id).toBe(ack.id)
  })

  it('forwards filename/quant and defaults localDir to models/<repoId flattened>', async () => {
    const runDownload = vi.fn(async () => ({ ok: true }))
    const dm = new DownloadManager({ emit: () => undefined, pollIntervalMs: 1_000_000, runDownload })
    dm.start({ repoId: 'owner/name', filename: 'x.gguf', quant: 'Q4_K_M' })
    await vi.waitFor(() => expect(runDownload).toHaveBeenCalledTimes(1))
    expect(runDownload).toHaveBeenCalledWith('owner/name', {
      localDir: 'models/owner__name',
      filename: 'x.gguf',
      quant: 'Q4_K_M'
    })
  })
})
