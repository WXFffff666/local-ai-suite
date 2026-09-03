/**
 * process.test.ts — todo28 stream-collection units: chunk fan-out order,
 * byte accounting, the maxOutputBytes emission stop, the 16 KB tail slice,
 * the cp936 fallback decode, and the timeout clamp. No real spawns here —
 * the exec matrix (index.test.ts) owns those.
 */
import { describe, expect, it, vi } from 'vitest'

import { computeTimeoutMs, createStreamCollector, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_SHELL_TIMEOUT_MS, SHELL_TAIL_BYTES } from './process'
import type { ShellChunk } from './types'

function utf8(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

describe('createStreamCollector — emission', () => {
  it('emits chunks in push order with the stream tag', () => {
    const sink = vi.fn()
    const c = createStreamCollector({ stream: 'stderr', maxBytes: DEFAULT_MAX_OUTPUT_BYTES, onChunk: sink })
    c.push(utf8('one '))
    c.push(utf8('two'))
    const calls: ShellChunk[] = sink.mock.calls.map((a) => a[0] as ShellChunk)
    expect(calls).toEqual([
      { stream: 'stderr', data: 'one ' },
      { stream: 'stderr', data: 'two' },
    ])
    expect(c.finish().tail).toBe('one two')
  })

  it('reassembles multi-byte characters split across chunk boundaries', () => {
    const sink = vi.fn()
    const c = createStreamCollector({ stream: 'stdout', maxBytes: DEFAULT_MAX_OUTPUT_BYTES, onChunk: sink })
    const bytes = utf8('处理中文') // 12 bytes, 3 per char
    const half = 4 // deliberately splits the second character (3-byte seq)
    c.push(bytes.subarray(0, half))
    c.push(bytes.subarray(half))
    const text = sink.mock.calls.map((a) => (a[0] as ShellChunk).data).join('')
    expect(text).toBe('处理中文')
    c.finish()
  })

  it('stops emission exactly at maxBytes and flags truncated; drain keeps consuming', () => {
    const sink = vi.fn()
    const c = createStreamCollector({ stream: 'stdout', maxBytes: 10, onChunk: sink })
    c.push(utf8('12345'))
    c.push(utf8('67890'))
    c.push(utf8('overflow-more')) // must be consumed (no backpressure) but never emitted
    const emitted = sink.mock.calls.map((a) => (a[0] as ShellChunk).data).join('')
    expect(emitted).toBe('1234567890')
    const done = c.finish()
    expect(done.truncated).toBe(true)
    expect(done.bytesSeen).toBeGreaterThan(10)
  })
})

describe('createStreamCollector — tail + encodings', () => {
  it('tail is capped at SHELL_TAIL_BYTES (16 KB) and keeps the END of the stream', () => {
    const c = createStreamCollector({ stream: 'stdout', maxBytes: DEFAULT_MAX_OUTPUT_BYTES })
    c.push(utf8('HEAD-MARKER'))
    c.push(Buffer.alloc(SHELL_TAIL_BYTES * 2, 0x61)) // 'a' * 32KB
    const done = c.finish()
    expect(Buffer.byteLength(done.tail, 'utf8')).toBeLessThanOrEqual(SHELL_TAIL_BYTES)
    expect(done.tail.endsWith('a'.repeat(64))).toBe(true)
    expect(done.tail).not.toContain('HEAD-MARKER')
  })

  it('decodes valid UTF-8 losslessly (fatal probe wins first)', () => {
    const c = createStreamCollector({ stream: 'stdout', maxBytes: DEFAULT_MAX_OUTPUT_BYTES })
    c.push(utf8('clean 中文 output'))
    expect(c.finish().tail).toBe('clean 中文 output')
  })

  it('falls back to cp936 (gbk) when the bytes are not UTF-8 (chcp-less cmd output)', () => {
    // GBK encoding of "中文" = D6 D0 CE C4 — invalid UTF-8 on purpose.
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    const c = createStreamCollector({ stream: 'stdout', maxBytes: DEFAULT_MAX_OUTPUT_BYTES })
    c.push(gbk)
    const done = c.finish()
    expect(done.tail).toContain('中文')
  })
})

describe('computeTimeoutMs', () => {
  it('0 requested => default', () => {
    expect(computeTimeoutMs(0, DEFAULT_SHELL_TIMEOUT_MS)).toBe(DEFAULT_SHELL_TIMEOUT_MS)
  })

  it('requested within the default is honoured', () => {
    expect(computeTimeoutMs(5_000, DEFAULT_SHELL_TIMEOUT_MS)).toBe(5_000)
  })

  it('requested above the default is clamped DOWN (LLM10 无界消耗防线)', () => {
    expect(computeTimeoutMs(9_999_999, DEFAULT_SHELL_TIMEOUT_MS)).toBe(DEFAULT_SHELL_TIMEOUT_MS)
  })
})
