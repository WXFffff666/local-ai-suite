/**
 * Baseline characterization (gallery lane): pins save() persistence + reuse()
 * round-trip on the pre-parameters-tEXt code. The todo22 work must keep these
 * green (embedding is additive; reuse keeps returning the same fields).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { GALLERY_DIR_NAME, getItem, list, reuse, save } from './gallery'

// 1x1 PNG b64 (minimal valid PNG)
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC'

describe('characterization: gallery save/reuse round-trip baseline', () => {
  let galleryDir: string
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'las-gallery-char-'))
    galleryDir = join(tmpRoot, GALLERY_DIR_NAME)
  })

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('save persists meta.json with every provided generation field', () => {
    const item = save({
      b64: TINY_PNG_B64,
      prompt: 'reuse prompt',
      negative_prompt: 'bad',
      width: 768,
      height: 512,
      steps: 25,
      cfg_scale: 7.5,
      seed: 123,
      model: 'flux',
      sampler: 'euler',
      baseDir: galleryDir,
    })
    expect(existsSync(item.originalPath)).toBe(true)
    expect(existsSync(item.thumbPath)).toBe(true)
    expect(existsSync(item.metaPath)).toBe(true)
    const meta = JSON.parse(readFileSync(item.metaPath, 'utf-8')) as Record<string, unknown>
    expect(meta['prompt']).toBe('reuse prompt')
    expect(meta['negative_prompt']).toBe('bad')
    expect(meta['width']).toBe(768)
    expect(meta['height']).toBe(512)
    expect(meta['steps']).toBe(25)
    expect(meta['cfg_scale']).toBe(7.5)
    expect(meta['seed']).toBe(123)
    expect(meta['model']).toBe('flux')
    expect(meta['sampler']).toBe('euler')
  })

  it('reuse round-trips every meta field back to /generate-shaped params', () => {
    const item = save({
      b64: TINY_PNG_B64,
      prompt: 'round trip',
      negative_prompt: 'ugly',
      width: 512,
      height: 768,
      steps: 20,
      cfg_scale: 7,
      seed: 42,
      model: 'sdxl',
      sampler: 'euler_a',
      extra: { clip_skip: 2 },
      baseDir: galleryDir,
    })
    const params = reuse(item.id, galleryDir)
    expect(params).toEqual({
      prompt: 'round trip',
      negative_prompt: 'ugly',
      width: 512,
      height: 768,
      steps: 20,
      cfg_scale: 7,
      seed: 42,
      model: 'sdxl',
      sampler: 'euler_a',
      extra: { clip_skip: 2 },
    })
  })

  it('list/getItem agree with save output; thumb keeps unprefixed bytes semantics', () => {
    const item = save({ b64: TINY_PNG_B64, prompt: 'x', baseDir: galleryDir })
    const items = list({ baseDir: galleryDir })
    expect(items.map((i) => i.id)).toEqual([item.id])
    expect(getItem(item.id, galleryDir).prompt).toBe('x')
    // thumb is an unmodified copy of the input bytes (todo22 must NOT touch thumb)
    expect(readFileSync(item.thumbPath).toString('base64')).toBe(TINY_PNG_B64)
  })

  it('legacy item without any png chunk reads back through meta.json alone', () => {
    // hand-built legacy directory: meta.json + non-PNG original bytes
    const legacyDir = join(galleryDir, 'legacy-1')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'original.png'), 'not-a-real-png', 'utf-8')
    writeFileSync(
      join(legacyDir, 'meta.json'),
      JSON.stringify({ id: 'legacy-1', prompt: 'old school', steps: 12, createdAt: 1 }),
      'utf-8',
    )
    const params = reuse('legacy-1', galleryDir)
    expect(params.prompt).toBe('old school')
    expect(params.steps).toBe(12)
  })
})
