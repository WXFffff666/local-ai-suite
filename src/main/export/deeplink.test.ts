/**
 * deeplink.test.ts — todo42 las:// 解析矩阵（happy / unknown / garbage / encoded）。
 */
import { describe, expect, it } from 'vitest'
import { DEEP_LINK_SCHEME, extractDeepLinkFromArgv, parseDeepLink } from './deeplink'

describe('parseDeepLink (todo42)', () => {
  it('happy: las://new-chat 与 las://models 解析为封闭 action', () => {
    expect(parseDeepLink('las://new-chat')).toBe('new-chat')
    expect(parseDeepLink('las://models')).toBe('models')
    expect(DEEP_LINK_SCHEME).toBe('las')
  })

  it('path/query/大小写被容忍（action 是唯一载荷）', () => {
    expect(parseDeepLink('las://new-chat/extra?text=hi')).toBe('new-chat')
    expect(parseDeepLink('LAS://Models')).toBe('models')
  })

  it('unknown action → null（绝不发明新路由）', () => {
    expect(parseDeepLink('las://settings')).toBe(null)
    expect(parseDeepLink('las://delete-everything')).toBe(null)
  })

  it('垃圾输入一律 null：非 las scheme / 非 URL / 空 / 坏编码', () => {
    expect(parseDeepLink('http://new-chat')).toBe(null)
    expect(parseDeepLink('las:/new-chat')).toBe(null)
    expect(parseDeepLink('not a url')).toBe(null)
    expect(parseDeepLink('')).toBe(null)
    expect(parseDeepLink('las://%zz%zz')).toBe(null)
  })

  it('percent-encoded action 解码后比对（编码的 new-chat 合法）', () => {
    expect(parseDeepLink('las://%6e%65%77-%63%68%61%74')).toBe('new-chat')
  })
})

describe('extractDeepLinkFromArgv (todo42)', () => {
  it('从 electron argv 噪声中提取深链参数', () => {
    const argv = ['C:\\app.exe', '--flag', 'C:\\cwd', 'las://models']
    expect(extractDeepLinkFromArgv(argv)).toBe('models')
  })

  it('无深链 / 仅未知深链 → null', () => {
    expect(extractDeepLinkFromArgv(['C:\\app.exe', '--hidden'])).toBe(null)
    expect(extractDeepLinkFromArgv(['C:\\app.exe', 'las://bogus'])).toBe(null)
  })

  it('首个合法深链生效（多参数取先到者）', () => {
    expect(extractDeepLinkFromArgv(['las://bogus', 'las://new-chat', 'las://models'])).toBe('new-chat')
  })
})
