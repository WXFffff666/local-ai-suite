/**
 * shiki-highlighter.test.ts — 纯函数层（node 环境）
 * resolveLanguageId：别名归一 / 大小写 / 空白 / 未知语言 → null（触发纯文本降级）。
 * 引擎与语法加载在 CodeBlock.test.tsx（jsdom）做真实集成验证。
 */
import { describe, expect, it } from 'vitest'
import { LANGUAGE_LOADERS, resolveLanguageId } from './shiki-highlighter'

describe('resolveLanguageId', () => {
  it('别名与大小写归一', () => {
    expect(resolveLanguageId('TS')).toBe('typescript')
    expect(resolveLanguageId(' py ')).toBe('python')
    expect(resolveLanguageId('golang')).toBe('go')
    expect(resolveLanguageId('zsh')).toBe('shell')
    expect(resolveLanguageId('YML')).toBe('yaml')
  })

  it('规范 id 直取；text 特例透传', () => {
    expect(resolveLanguageId('rust')).toBe('rust')
    expect(resolveLanguageId('plaintext')).toBe('text')
    expect(resolveLanguageId('text')).toBe('text')
  })

  it('空/未知 → null（降级信号）', () => {
    expect(resolveLanguageId(undefined)).toBeNull()
    expect(resolveLanguageId('')).toBeNull()
    expect(resolveLanguageId('   ')).toBeNull()
    expect(resolveLanguageId('madeup-lang')).toBeNull()
  })

  it('loader 表自洽：每个 id 都能被 resolve', () => {
    for (const id of Object.keys(LANGUAGE_LOADERS)) {
      expect(resolveLanguageId(id)).toBe(id)
    }
  })
})
