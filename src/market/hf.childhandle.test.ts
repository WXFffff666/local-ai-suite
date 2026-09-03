/**
 * hf.childhandle.test.ts — todo14b 下载子进程句柄表单测
 * download:cancel 的机制底座：killDownloadChild 按会话 id 树杀（Windows
 * taskkill /T /F，注入 spawnLike 验 argv；POSIX 直接 child.kill）、
 * 未知 id {killed:false} 不误伤。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  activeDownloadIds,
  killDownloadChild,
  registerDownloadChild,
  unregisterDownloadChild,
  type HfChildHandle
} from './hf'

function fakeChild(pid?: number): HfChildHandle & { kill: ReturnType<typeof vi.fn> } {
  return { ...(pid === undefined ? {} : { pid }), kill: vi.fn(() => true) }
}

afterEach(() => {
  for (const id of activeDownloadIds()) unregisterDownloadChild(id)
})

describe('download child handle map (14b)', () => {
  it('register → active ids list → kill returns {killed:true,pid} and child dies', () => {
    const child = fakeChild(4321)
    registerDownloadChild('dl-a', child)
    expect(activeDownloadIds()).toContain('dl-a')

    const spawnLike = vi.fn(() => ({ on: vi.fn() }))
    const res = killDownloadChild('dl-a', spawnLike as unknown as typeof import('child_process').spawn)
    expect(res).toEqual({ killed: true, pid: 4321 })
    if (process.platform === 'win32') {
      // Windows: tree-kill via taskkill so grandchild hf-cli dies too
      expect(spawnLike).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', '4321', '/T', '/F'],
        { stdio: 'ignore' }
      )
    } else {
      expect(child.kill).toHaveBeenCalled()
    }
  })

  it('unknown session id → {killed:false}, nothing spawned', () => {
    const spawnLike = vi.fn(() => ({ on: vi.fn() }))
    expect(killDownloadChild('ghost', spawnLike as unknown as typeof import('child_process').spawn)).toEqual({
      killed: false
    })
    expect(spawnLike).not.toHaveBeenCalled()
  })

  it('unregister removes the handle; a finished session can no longer be killed', () => {
    const child = fakeChild(1)
    registerDownloadChild('dl-b', child)
    unregisterDownloadChild('dl-b')
    expect(activeDownloadIds()).not.toContain('dl-b')
    expect(killDownloadChild('dl-b').killed).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('child without pid falls back to direct kill (no taskkill possible)', () => {
    const child = fakeChild()
    registerDownloadChild('dl-c', child)
    const spawnLike = vi.fn(() => ({ on: vi.fn() }))
    const res = killDownloadChild('dl-c', spawnLike as unknown as typeof import('child_process').spawn)
    expect(res).toEqual({ killed: true })
    expect(spawnLike).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalled()
  })
})
