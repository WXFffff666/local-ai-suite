import { describe, it, expect, vi } from 'vitest'
import { createDestructiveConfirmHandler, showDestructiveConfirm } from './dialogConfirm'

function mockDialog(response: number) {
  const showMessageBox = vi.fn().mockResolvedValue({ response, checkboxChecked: false })
  return { showMessageBox }
}

describe('showDestructiveConfirm — main/utils/dialogConfirm', () => {
  it('调用 dialog.showMessageBox 使用 warning/defaultId0/cancelId0 且 response===1 时返回 true', async () => {
    const dialog = mockDialog(1)
    const ok = await showDestructiveConfirm(dialog as never, { message: '确认删除？' })
    expect(ok).toBe(true)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
    const opts = dialog.showMessageBox.mock.calls[0][0] as Electron.MessageBoxOptions
    expect(opts.type).toBe('warning')
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(0)
    expect(opts.buttons).toEqual(['取消', '确认删除'])
    expect(opts.message).toBe('确认删除？')
    expect(opts.title).toBe('确认操作')
    expect(opts.noLink).toBe(true)
  })

  it('response===0（取消）返回 false', async () => {
    const dialog = mockDialog(0)
    const ok = await showDestructiveConfirm(dialog as never, { message: '删除模型?' })
    expect(ok).toBe(false)
  })

  it('自定义 title/detail/buttons 生效', async () => {
    const dialog = mockDialog(1)
    await showDestructiveConfirm(dialog as never, {
      title: '危险操作',
      message: '清空画廊？',
      detail: '将删除全部图片，不可恢复',
      confirmText: '清空',
      cancelText: '保留'
    })
    const opts = dialog.showMessageBox.mock.calls[0][0] as Electron.MessageBoxOptions
    expect(opts.title).toBe('危险操作')
    expect(opts.detail).toBe('将删除全部图片，不可恢复')
    expect(opts.buttons).toEqual(['保留', '清空'])
  })

  it('空 message 抛错 — 后端二次校验', async () => {
    const dialog = mockDialog(1)
    await expect(showDestructiveConfirm(dialog as never, { message: '' } as never)).rejects.toThrow(/message/)
    await expect(showDestructiveConfirm(dialog as never, { message: '   ' } as never)).rejects.toThrow(/message/)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('非法类型抛错 — 后端校验 detail/title', async () => {
    const dialog = mockDialog(1)
    await expect(showDestructiveConfirm(dialog as never, { message: 'x', detail: 123 as never } as never)).rejects.toThrow()
    await expect(showDestructiveConfirm(dialog as never, { message: 'x', title: 123 as never } as never)).rejects.toThrow()
  })

  it('仅允许 response===1 为确认 — 2 以上亦为 false', async () => {
    const dialog = mockDialog(2)
    const ok = await showDestructiveConfirm(dialog as never, { message: 'test' })
    expect(ok).toBe(false)
  })

  it('createDestructiveConfirmHandler 为 IPC handler — 二次校验且委托 showDestructiveConfirm', async () => {
    const dialog = mockDialog(1)
    const handler = createDestructiveConfirmHandler(dialog as never) as unknown as (a: unknown, b: unknown) => Promise<boolean>
    const ok = await handler({}, { message: '删除?' })
    expect(ok).toBe(true)
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('handler 对非法参数抛错 — 不调用 dialog', async () => {
    const dialog = mockDialog(1)
    const handler = createDestructiveConfirmHandler(dialog as never) as unknown as (a: unknown, b: unknown) => Promise<boolean>
    await expect(handler({}, null as never)).rejects.toThrow()
    await expect(handler({}, { message: '' } as never)).rejects.toThrow()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('单点 showMessageBox — 源码中仅此处出现', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const root = path.resolve(__dirname, '../../..')
    // 递归收集 ts 文件
    function collect(dir: string, out: string[] = []): string[] {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'dist') continue
          collect(p, out)
        } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
          out.push(p)
        }
      }
      return out
    }
    const files = collect(path.join(root, 'src'))
    const hits: string[] = []
    for (const f of files) {
      if (f.endsWith('.test.ts') || f.endsWith('.spec.ts')) continue
      const content = fs.readFileSync(f, 'utf8')
      if (content.includes('showMessageBox')) hits.push(path.relative(root, f).replace(/\\/g, '/'))
    }
    // 仅允许在 dialogConfirm.ts 中出现（生产代码单点）
    expect(hits).toEqual(['src/main/utils/dialogConfirm.ts'])
  })
})
