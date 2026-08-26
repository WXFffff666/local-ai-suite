import { describe, it, expect, vi } from 'vitest'
import { confirmDestructive, isConfirmOptionsValid, showDestructiveConfirm } from './confirm'

function apiMock(result: unknown) {
  return { invoke: vi.fn().mockResolvedValue(result) }
}

describe('confirmDestructive — renderer/utils/confirm (前端双重校验第一重)', () => {
  it('前端校验+IPC 调用 — 成功时返回 true', async () => {
    const api = apiMock(true)
    const ok = await confirmDestructive({ message: '确认删除？' }, api)
    expect(ok).toBe(true)
    expect(api.invoke).toHaveBeenCalledWith('dialog:confirmDestructive', { message: '确认删除？' })
  })

  it('后端返回 false 时前端返回 false（用户取消）', async () => {
    const api = apiMock(false)
    const ok = await confirmDestructive({ message: '删除模型？' }, api)
    expect(ok).toBe(false)
  })

  it('非 true 返回值视为 false — 防御性', async () => {
    const api = apiMock('true' as unknown as boolean)
    const ok = await confirmDestructive({ message: 'x' }, api)
    expect(ok).toBe(false)
  })

  it('前端第一重校验 — 空 message 直接抛错且不触发 IPC', async () => {
    const api = apiMock(true)
    await expect(confirmDestructive({ message: '' } as never, api)).rejects.toThrow(/message/)
    await expect(confirmDestructive({ message: '   ' } as never, api)).rejects.toThrow(/message/)
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('前端校验非法类型抛错', async () => {
    const api = apiMock(true)
    await expect(confirmDestructive({ message: 'x', detail: 123 as never } as never, api)).rejects.toThrow()
    expect(api.invoke).not.toHaveBeenCalled()
  })

  it('window.api 不可用时抛错', async () => {
    // 不传 api 且 window 上无 api
    const orig = (globalThis as unknown as { window?: unknown }).window
    ;(globalThis as unknown as Record<string, unknown>).window = {}
    await expect(confirmDestructive({ message: 'x' })).rejects.toThrow(/window\.api/)
    ;(globalThis as unknown as Record<string, unknown>).window = orig
  })

  it('showDestructiveConfirm 为 alias', async () => {
    expect(showDestructiveConfirm).toBe(confirmDestructive)
  })

  it('isConfirmOptionsValid 工具正确', () => {
    expect(isConfirmOptionsValid({ message: 'ok' })).toBe(true)
    expect(isConfirmOptionsValid({ message: '' })).toBe(false)
    expect(isConfirmOptionsValid(null)).toBe(false)
    expect(isConfirmOptionsValid({ message: 'x', title: 1 as never })).toBe(false)
  })

  it('双重校验 — 前端与后端均对非法输入抛错 (TDD)', async () => {
    // 前端已抛，后端同样会抛 — 后端校验逻辑与前端一致，此处仅验证前端侧已独立拦截
    const api = apiMock(true)
    await expect(confirmDestructive({ message: '' } as never, api)).rejects.toThrow()
    // 模拟绕过前端直接发非法 IPC 被后端拦截的场景：构造一个会抛错的 api
    const badApi = { invoke: vi.fn().mockRejectedValue(new Error('message must be a non-empty string')) }
    await expect(confirmDestructive({ message: 'valid' } as never, badApi as never)).rejects.toThrow()
  })

  it('传递 title/detail/confirmText/cancelText 到 IPC', async () => {
    const api = apiMock(true)
    await confirmDestructive(
      { title: '危险', message: '清空？', detail: '不可恢复', confirmText: '清空', cancelText: '保留' },
      api
    )
    expect(api.invoke).toHaveBeenCalledWith('dialog:confirmDestructive', {
      title: '危险',
      message: '清空？',
      detail: '不可恢复',
      confirmText: '清空',
      cancelText: '保留'
    })
  })
})
