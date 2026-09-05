/**
 * promptLibrary.test.ts — 织词提示词库加载层：zh2en 查表、标签检索、预设/角色。
 */

import { describe, expect, it } from 'vitest'

import {
  characterToPrompt,
  loadCharacters,
  loadPresets,
  loadTagCategory,
  lookupZh,
  searchTags,
  TAG_CATEGORIES,
} from './promptLibrary'

describe('lookupZh（zh2en 查表）', () => {
  it('中文短语 → 英文 tag 串', async () => {
    const out = await lookupZh('3D写实')
    expect(out).toBe('3d_realistic_style')
  })
  it('未命中返回 undefined', async () => {
    await expect(lookupZh('绝对不存在的词组xyzq')).resolves.toBeUndefined()
  })
})

describe('loadTagCategory / searchTags', () => {
  it('画质维度有数据且含中英文', async () => {
    const items = await loadTagCategory('quality')
    expect(items.length).toBeGreaterThan(10)
    for (const t of items.slice(0, 5)) {
      expect(typeof t.zh).toBe('string')
      expect(typeof t.en).toBe('string')
    }
  })
  it('中文子串检索命中并返回 TagItem', async () => {
    const items = await loadTagCategory('quality')
    const hits = searchTags(items, '质量')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.en).toBeTruthy()
  })
  it('分类清单含限制级（由开关控制显示）', () => {
    expect(TAG_CATEGORIES.some((c) => c.id === 'nsfw')).toBe(true)
  })
})

describe('loadPresets / loadCharacters', () => {
  it('SFW 预设加载（>1000 条）且 H 册默认不包含', async () => {
    const sfw = await loadPresets(false)
    expect(sfw.length).toBeGreaterThan(1000)
    const withH = await loadPresets(true)
    expect(withH.length).toBeGreaterThan(sfw.length)
  })
  it('角色库加载与特征串', async () => {
    const chars = await loadCharacters()
    expect(chars.length).toBeGreaterThan(1000)
    const miku = chars.find((c) => c.enName.toLowerCase().includes('miku'))
    expect(miku).toBeDefined()
    const prompt = characterToPrompt(miku!)
    expect(prompt.toLowerCase()).toContain('miku')
  })
})
