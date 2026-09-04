/**
 * integration.test.ts + jumplist.test.ts 合并关注点：自启/协议 mock 门 + JumpList 构建。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AUTOSTART_HIDDEN_FLAG,
  applyAutostart,
  applyProtocolRegistration,
  buildLoginItemSettings,
  type LoginItemAppLike,
  type ProtocolAppLike,
} from './integration'
import { APP_USER_MODEL_ID, buildJumpListEntries } from './jumplist'

describe('buildLoginItemSettings / applyAutostart (todo42)', () => {
  it('开：openAtLogin + --hidden 静默参数；关：清空', () => {
    expect(buildLoginItemSettings(true)).toEqual({ openAtLogin: true, args: [AUTOSTART_HIDDEN_FLAG] })
    expect(buildLoginItemSettings(false)).toEqual({ openAtLogin: false, args: [] })
  })

  it('applyAutostart 把构建结果原样交给 app mock', () => {
    const app: LoginItemAppLike = { setLoginItemSettings: vi.fn() }
    applyAutostart(app, true)
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] })
  })
})

describe('applyProtocolRegistration (todo42)', () => {
  function fakeProtocolApp(state: { registered: boolean }): ProtocolAppLike {
    return {
      setAsDefaultProtocolClient: vi.fn(() => {
        state.registered = true
        return true
      }),
      removeAsDefaultProtocolClient: vi.fn(() => {
        state.registered = false
        return true
      }),
      isDefaultProtocolClient: vi.fn(() => state.registered),
    }
  }

  it('开 → set 被调、返回 OS 诚实状态 true', () => {
    const state = { registered: false }
    const app = fakeProtocolApp(state)
    expect(applyProtocolRegistration(app, true)).toBe(true)
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('las')
    expect(app.removeAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  it('关 → remove 被调、返回 false；set 不被调', () => {
    const state = { registered: true }
    const app = fakeProtocolApp(state)
    expect(applyProtocolRegistration(app, false)).toBe(false)
    expect(app.removeAsDefaultProtocolClient).toHaveBeenCalledWith('las')
    expect(app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })
})

describe('buildJumpListEntries (todo42)', () => {
  it('两条 custom link 条目：新建会话→las://new-chat，模型页→las://models', () => {
    const entries = buildJumpListEntries('C:\\Apps\\Local AI Suite.exe')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      title: '新建会话',
      description: '打开 Local AI Suite 并新建一个会话',
      exePath: 'C:\\Apps\\Local AI Suite.exe',
      arguments: 'las://new-chat',
    })
    expect(entries[1]).toMatchObject({ title: '模型页', arguments: 'las://models' })
  })

  it('AUMID 与 electron-builder appId 一致', () => {
    expect(APP_USER_MODEL_ID).toBe('com.localaisuite.app')
  })
})
