import { describe, it, expect } from 'vitest'
import { ALLOWED_CHANNELS, assertAllowedChannel, isAllowedChannel } from './whitelist'

describe('ipc whitelist', () => {
  it('合法 channel 通过 — ALLOWED 中所有通道均被 isAllowedChannel 接受', () => {
    for (const ch of ALLOWED_CHANNELS) {
      expect(isAllowedChannel(ch)).toBe(true)
    }
    // 逐项断言，确保 10 项齐全（含 dialog:confirmDestructive + 4 destructive guards）
    expect(ALLOWED_CHANNELS).toEqual([
      'health:pulse',
      'models:list',
      'models:download',
      'chat:send',
      'image:generate',
      'dialog:confirmDestructive',
      'workspace:delete',
      'coverage:overwrite',
      'release:publish',
      'cache:clear',
      'secrets:encrypt',
      'secrets:decrypt'
    ])
  })

  it('非法 channel 被拒 — 未知通道返回 false 且 assert 抛错', () => {
    const illegal = ['evil:channel', 'health:pulse ', 'chat:send:extra', '', 'ipcRenderer', 'models:Delete']
    for (const ch of illegal) {
      expect(isAllowedChannel(ch)).toBe(false)
      expect(() => assertAllowedChannel(ch)).toThrow(/not allowed/)
    }
  })

  it('preload 仅暴露白名单 — ALLOWED 为只读 12 项且无通配/全量暴露', () => {
    expect(ALLOWED_CHANNELS).toHaveLength(12)
    // 确保无通配符或空字符串混入
    for (const ch of ALLOWED_CHANNELS) {
      expect(ch).toMatch(/^[a-z]+:[a-zA-Z-]+$/)
    }
    // assert 在白名单通道上不抛错
    for (const ch of ALLOWED_CHANNELS) {
      expect(() => assertAllowedChannel(ch)).not.toThrow()
    }
  })
})
