import { describe, it, expect, vi } from 'vitest'

// Renderer frontends
import { deleteWorkspace } from './renderer/src/features/workspace/deleteWorkspace'
import { overwriteCoverage } from './renderer/src/features/coverage/overwriteCoverage'
import { publishRelease } from './renderer/src/features/release/publishRelease'
import { clearCache } from './renderer/src/features/cache/clearCache'

// Main backends
import { handleDeleteWorkspace } from './main/handlers/deleteWorkspace'
import { handleOverwriteCoverage } from './main/handlers/overwriteCoverage'
import { handlePublishRelease } from './main/handlers/publishRelease'
import { handleClearCache } from './main/handlers/clearCache'

function apiMock(result: boolean) {
  return { invoke: vi.fn().mockResolvedValue(result) }
}

function mockDialog(response: number) {
  return { showMessageBox: vi.fn().mockResolvedValue({ response, checkboxChecked: false }) }
}

describe('destructive-guards — 4前端+4后端 双重校验, Cancel无副作用', () => {
  // Frontend 4
  it('前端 Delete Workspace — Cancel 无副作用, Confirm 执行', async () => {
    const performDelete = vi.fn().mockResolvedValue(undefined)
    const apiCancel = apiMock(false)
    const cancelled = await deleteWorkspace({ workspaceId: 'ws-1', workspaceName: 'Test' }, { api: apiCancel, performDelete })
    expect(cancelled).toBe(false)
    expect(performDelete).not.toHaveBeenCalled()
    expect(apiCancel.invoke).toHaveBeenCalledWith('dialog:confirmDestructive', expect.objectContaining({ message: expect.stringContaining('Test') }))

    const apiOk = apiMock(true)
    performDelete.mockClear()
    const ok = await deleteWorkspace({ workspaceId: 'ws-1' }, { api: apiOk, performDelete })
    expect(ok).toBe(true)
    expect(performDelete).toHaveBeenCalledWith('ws-1')
  })

  it('前端 Overwrite Coverage — Cancel 无副作用, Confirm 执行', async () => {
    const performOverwrite = vi.fn().mockResolvedValue(undefined)
    const apiCancel = apiMock(false)
    const cancelled = await overwriteCoverage({ filePath: 'coverage/lcov.info' }, { api: apiCancel, performOverwrite })
    expect(cancelled).toBe(false)
    expect(performOverwrite).not.toHaveBeenCalled()

    const apiOk = apiMock(true)
    performOverwrite.mockClear()
    const ok = await overwriteCoverage({ reportId: 'r-1' }, { api: apiOk, performOverwrite })
    expect(ok).toBe(true)
    expect(performOverwrite).toHaveBeenCalled()
  })

  it('前端 Publish Release — Cancel 无副作用, Confirm 执行', async () => {
    const performPublish = vi.fn().mockResolvedValue(undefined)
    const apiCancel = apiMock(false)
    const cancelled = await publishRelease({ version: '1.0.0', tag: 'v1.0.0' }, { api: apiCancel, performPublish })
    expect(cancelled).toBe(false)
    expect(performPublish).not.toHaveBeenCalled()

    const apiOk = apiMock(true)
    performPublish.mockClear()
    const ok = await publishRelease({ version: '1.0.0' }, { api: apiOk, performPublish })
    expect(ok).toBe(true)
    expect(performPublish).toHaveBeenCalledWith(expect.objectContaining({ version: '1.0.0' }))
  })

  it('前端 Clear Cache — Cancel 无副作用, Confirm 执行', async () => {
    const performClear = vi.fn().mockResolvedValue(undefined)
    const apiCancel = apiMock(false)
    const cancelled = await clearCache({ scope: 'gallery' }, { api: apiCancel, performClear })
    expect(cancelled).toBe(false)
    expect(performClear).not.toHaveBeenCalled()

    const apiOk = apiMock(true)
    performClear.mockClear()
    const ok = await clearCache({}, { api: apiOk, performClear })
    expect(ok).toBe(true)
    expect(performClear).toHaveBeenCalled()
  })

  // Backend 4
  it('后端 Delete Workspace — Cancel 无副作用, Confirm 执行 (dialogConfirm二次校验)', async () => {
    const performDelete = vi.fn().mockResolvedValue(undefined)
    const dialogCancel = mockDialog(0)
    const r1 = await handleDeleteWorkspace(dialogCancel as never, { workspaceId: 'ws-1' }, performDelete)
    expect(r1.cancelled).toBe(true)
    expect(performDelete).not.toHaveBeenCalled()
    expect(dialogCancel.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))

    performDelete.mockClear()
    const dialogOk = mockDialog(1)
    const r2 = await handleDeleteWorkspace(dialogOk as never, { workspaceId: 'ws-1' }, performDelete)
    expect(r2.cancelled).toBe(false)
    expect(performDelete).toHaveBeenCalledWith('ws-1')
  })

  it('后端 Overwrite Coverage — Cancel 无副作用, Confirm 执行', async () => {
    const performOverwrite = vi.fn().mockResolvedValue(undefined)
    const dialogCancel = mockDialog(0)
    const r1 = await handleOverwriteCoverage(dialogCancel as never, { filePath: 'a' }, performOverwrite)
    expect(r1.cancelled).toBe(true)
    expect(performOverwrite).not.toHaveBeenCalled()

    performOverwrite.mockClear()
    const dialogOk = mockDialog(1)
    const r2 = await handleOverwriteCoverage(dialogOk as never, { filePath: 'a' }, performOverwrite)
    expect(r2.cancelled).toBe(false)
    expect(performOverwrite).toHaveBeenCalled()
  })

  it('后端 Publish Release — Cancel 无副作用, Confirm 执行', async () => {
    const performPublish = vi.fn().mockResolvedValue(undefined)
    const dialogCancel = mockDialog(0)
    const r1 = await handlePublishRelease(dialogCancel as never, { version: '2.0.0' }, performPublish)
    expect(r1.cancelled).toBe(true)
    expect(performPublish).not.toHaveBeenCalled()

    performPublish.mockClear()
    const dialogOk = mockDialog(1)
    const r2 = await handlePublishRelease(dialogOk as never, { version: '2.0.0', tag: 'v2.0.0' }, performPublish)
    expect(r2.cancelled).toBe(false)
    expect(performPublish).toHaveBeenCalled()
  })

  it('后端 Clear Cache — Cancel 无副作用, Confirm 执行', async () => {
    const performClear = vi.fn().mockResolvedValue(undefined)
    const dialogCancel = mockDialog(0)
    const r1 = await handleClearCache(dialogCancel as never, { scope: 'all' }, performClear)
    expect(r1.cancelled).toBe(true)
    expect(performClear).not.toHaveBeenCalled()

    performClear.mockClear()
    const dialogOk = mockDialog(1)
    const r2 = await handleClearCache(dialogOk as never, {}, performClear)
    expect(r2.cancelled).toBe(false)
    expect(performClear).toHaveBeenCalled()
  })
})
