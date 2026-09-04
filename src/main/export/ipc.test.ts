/**
 * ipc.test.ts — todo42 chat:exportHtml 主进程侧单测（faked dialog/fs —
 * vitest 永不弹真对话框；speech pickModel 同型注入约定）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createExportHandlers, type SaveDialogLike } from './ipc'

const CTX = { send: vi.fn() }

function harness(save: { canceled: boolean; filePath?: string }) {
  const dialog: SaveDialogLike = { showSaveDialog: vi.fn(async () => save) }
  const writeFile = vi.fn()
  const handlers = createExportHandlers({
    dialog,
    getDownloadsDir: () => 'C:\\Users\\me\\Downloads',
    writeFile,
  })
  return { handlers, dialog, writeFile }
}

describe('chat:exportHtml (todo42)', () => {
  it('happy: 净化文件名进 defaultPath，确认后按所选路径写 UTF-8', async () => {
    const { handlers, dialog, writeFile } = harness({ canceled: false, filePath: 'C:\\out\\报告.html' })
    const res = await handlers['chat:exportHtml']([{ html: '<html>ok</html>', filename: '报告:<>|bad' }], CTX)
    expect(res).toEqual({ ok: true, path: 'C:\\out\\报告.html' })
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'C:\\Users\\me\\Downloads\\报告 bad.html',
      }),
    )
    expect(writeFile).toHaveBeenCalledWith('C:\\out\\报告.html', '<html>ok</html>')
  })

  it('cancel = 良性 cancelled，零写盘', async () => {
    const { handlers, writeFile } = harness({ canceled: true })
    const res = await handlers['chat:exportHtml']([{ html: '<html></html>', filename: 'x' }], CTX)
    expect(res).toEqual({ ok: false, error: 'cancelled' })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('写盘抛错 → write-failed + detail（错误文本不上当内容渲染）', async () => {
    const dialog: SaveDialogLike = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: 'C:\\x.html' })) }
    const handlers = createExportHandlers({
      dialog,
      getDownloadsDir: () => 'D',
      writeFile: () => {
        throw new Error('EPERM')
      },
    })
    const res = await handlers['chat:exportHtml']([{ html: 'h', filename: 'x' }], CTX)
    expect(res).toMatchObject({ ok: false, error: 'write-failed', detail: 'EPERM' })
  })

  it('zod 门：未知键/空 html/超长 filename → 400-shape，对话框不弹', async () => {
    const { handlers, dialog } = harness({ canceled: false, filePath: 'C:\\x.html' })
    const bad = (await handlers['chat:exportHtml']([{ html: '', filename: 'x' }], CTX)) as { error: string }
    expect(bad.error).toBe('invalid-payload')
    const extra = (await handlers['chat:exportHtml']([{ html: 'h', filename: 'x', evil: 1 }], CTX)) as { error: string }
    expect(extra.error).toBe('invalid-payload')
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })
})
