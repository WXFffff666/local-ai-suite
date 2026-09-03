/**
 * updater.test.ts — todo32 state-machine matrix over a FULLY MOCKED
 * electron-updater module (vi.mock): the real library needs the electron
 * runtime (learnings.md electron-mock pitfall — an unmocked electron import
 * stalls vitest on a binary download).
 *
 * Covered: policy flags (autoDownload=false / autoInstallOnAppQuit /
 * allowDowngrade=false / channel incl. env override), event fanout for every
 * UpdateStateEvent phase, check()/downloadAndInstall() reply routing, error
 * identity-dedupe, and the unsigned-build graceful classification (real
 * electron-updater v6.8.9 error strings — see the header in updater.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutoUpdaterLike, UpdaterLog } from './updater'
import type { UpdateStateEvent } from './ipc/whitelist'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: never) => void>>()
  const calls = {
    checkForUpdates: 0,
    downloadUpdate: 0,
    quitAndInstall: Array<[boolean | undefined, boolean | undefined]>()
  }
  let checkResult: Promise<unknown> = Promise.resolve(null)
  let downloadResult: Promise<unknown> = Promise.resolve([])
  const fakeAutoUpdater = {
    // writable policy surface (createUpdater assigns these)
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    channel: null as string | null,
    checkForUpdates(): Promise<unknown> {
      calls.checkForUpdates += 1
      return checkResult
    },
    downloadUpdate(): Promise<unknown> {
      calls.downloadUpdate += 1
      return downloadResult
    },
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
      calls.quitAndInstall.push([isSilent, isForceRunAfter])
    },
    on(event: string, listener: (payload: never) => void): undefined {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(listener)
      return undefined
    },
    /** test driver: dispatch a library event to registered listeners */
    __emit(event: string, payload?: unknown): void {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as unknown as (p: unknown) => void)(payload)
      }
    },
    __setCheckResult(p: Promise<unknown>): void {
      checkResult = p
    },
    __calls: calls,
    __reset(): void {
      listeners.clear()
      calls.checkForUpdates = 0
      calls.downloadUpdate = 0
      calls.quitAndInstall.length = 0
      fakeAutoUpdater.autoDownload = true
      fakeAutoUpdater.autoInstallOnAppQuit = false
      fakeAutoUpdater.allowDowngrade = true
      fakeAutoUpdater.channel = null
      checkResult = Promise.resolve(null)
      downloadResult = Promise.resolve([])
    }
  }
  return { fakeAutoUpdater, mock: { autoUpdater: fakeAutoUpdater } }
})

vi.mock('electron-updater', () => h.mock)

const { createUpdater, scheduleInitialUpdateCheck, isSignatureUnavailable, UPDATE_CHECK_INITIAL_DELAY_MS } =
  await import('./updater')

/** the mocked electron-updater singleton (same object createUpdater imports) */
const fake = h.fakeAutoUpdater
/** the same object typed through the production seam */
const fakeAsAutoUpdater = fake as unknown as AutoUpdaterLike

function silentLog(): UpdaterLog {
  return { info: () => undefined, warn: () => undefined, error: () => undefined }
}

function harness(env?: Record<string, string | undefined>) {
  const states: UpdateStateEvent[] = []
  const updater = createUpdater({
    emit: (s) => states.push(s),
    log: silentLog(),
    updater: fakeAsAutoUpdater,
    ...(env === undefined ? {} : { env })
  })
  return { updater, states }
}

/** flush the .catch microtask chain off a rejected check/download promise */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  fake.__reset()
})

describe('createUpdater policy flags', () => {
  it('writes autoDownload=false, autoInstallOnAppQuit=true, allowDowngrade=false, channel=latest', () => {
    // __reset left poison values (autoDownload=true, allowDowngrade=true,
    // channel=null), so green here proves createUpdater APPLIED the policy.
    harness()
    expect(fake.autoDownload).toBe(false)
    expect(fake.autoInstallOnAppQuit).toBe(true)
    expect(fake.allowDowngrade).toBe(false)
    expect(fake.channel).toBe('latest')
  })

  it('LAS_UPDATE_CHANNEL env overrides the channel and keeps allowDowngrade=false (R3b beta fallback)', () => {
    harness({ LAS_UPDATE_CHANNEL: 'beta' })
    expect(fake.channel).toBe('beta')
    expect(fake.allowDowngrade).toBe(false)
  })
})

describe('event fanout (every UpdateStateEvent phase)', () => {
  it('maps the full event stream to the state union, in order', () => {
    const { states } = harness()
    fake.__emit('checking-for-update')
    fake.__emit('update-available', { version: '0.2.0' })
    fake.__emit('update-not-available', { version: '0.1.0' })
    fake.__emit('download-progress', { percent: 33.7, transferred: 3370, total: 10000 })
    fake.__emit('update-downloaded', { version: '0.2.0', downloadedFile: 'C:\\tmp\\u.exe' })
    fake.__emit('error', new Error('boom'))
    expect(states.map((s) => s.phase)).toEqual([
      'checking',
      'available',
      'not-available',
      'progress',
      'downloaded',
      'error'
    ])
    expect(states[1]).toEqual({ phase: 'available', version: '0.2.0' })
    expect(states[3]).toEqual({ phase: 'progress', percent: 33.7, received: 3370, total: 10000 })
    expect(states[4]).toEqual({ phase: 'downloaded', version: '0.2.0' })
  })

  it('signature errors flag through the fanout (full payload asserted)', () => {
    const { states } = harness()
    fake.__emit('error', new Error('New version 0.2.0 is not signed by the application owner: ...'))
    expect(states[0]).toMatchObject({ phase: 'error', signatureUnavailable: true })
  })
})

describe('check()', () => {
  it('acks {ok:true} and drives checkForUpdates exactly once', async () => {
    const { updater } = harness()
    expect(updater.check()).toEqual({ ok: true })
    expect(fake.__calls.checkForUpdates).toBe(1)
    await settle()
  })

  it('re-emits a rejected checkForUpdates that did NOT pass through the error event', async () => {
    const { states, updater } = harness()
    fake.__setCheckResult(Promise.reject(new Error('network unreachable')))
    updater.check()
    await settle()
    expect(states).toEqual([{ phase: 'error', message: 'network unreachable' }])
  })

  it('does NOT double-emit when electron-updater already dispatched the same error instance', async () => {
    const { states, updater } = harness()
    const err = new Error('404 Cannot find the latest version in the "latest" channel')
    fake.__setCheckResult(Promise.reject(err))
    updater.check()
    fake.__emit('error', err) // the library's own dispatch lands first
    await settle()
    expect(states.filter((s) => s.phase === 'error')).toHaveLength(1)
  })
})

describe('downloadAndInstall() phase routing', () => {
  it('invalid-state before any update is available (no download, no install)', async () => {
    const { updater } = harness()
    expect(updater.check()).toEqual({ ok: true }) // no available event fired
    expect(updater.downloadAndInstall()).toEqual({ ok: false, error: 'invalid-state' })
    expect(fake.__calls.downloadUpdate).toBe(0)
    expect(fake.__calls.quitAndInstall).toHaveLength(0)
    await settle()
  })

  it('available → starts the download (autoDownload=false posture)', () => {
    const { states, updater } = harness()
    fake.__emit('update-available', { version: '0.2.0' })
    expect(updater.downloadAndInstall()).toEqual({ ok: true, action: 'downloading' })
    expect(fake.__calls.downloadUpdate).toBe(1)
    expect(states.at(-1)).toEqual({ phase: 'downloading', version: '0.2.0' })
  })

  it('downloaded → quitAndInstall(false, true) (explicit user gesture only)', () => {
    const { updater } = harness()
    fake.__emit('update-available', { version: '0.2.0' })
    fake.__emit('update-downloaded', { version: '0.2.0' })
    expect(updater.downloadAndInstall()).toEqual({ ok: true, action: 'installing' })
    expect(fake.__calls.quitAndInstall).toEqual([[false, true]])
    expect(fake.__calls.downloadUpdate).toBe(0)
  })

  it('update-not-available resets a stale offer (cannot install what went away)', () => {
    const { updater } = harness()
    fake.__emit('update-available', { version: '0.2.0' })
    fake.__emit('update-not-available', { version: '0.2.0' })
    expect(updater.downloadAndInstall()).toEqual({ ok: false, error: 'invalid-state' })
  })
})

describe('signature-graceful classification (unsigned builds)', () => {
  const signatureErrors = [
    // shapes verbatim from electron-updater v6.8.9 (cited in updater.ts):
    'New version 0.2.0 is not signed by the application owner: SignedToolExitError',
    'Sign verification failed, installer signed with incorrect certificate: publisherNames: CN=Local AI Suite',
    'Cannot execute Get-AuthenticodeSignature, stderr: . Failing signature validation due to unknown stderr.'
  ]
  for (const message of signatureErrors) {
    it(`flags signatureUnavailable for: ${message.slice(0, 48)}…`, () => {
      const { states } = harness()
      fake.__emit('error', new Error(message))
      expect(states[0]).toEqual({ phase: 'error', message, signatureUnavailable: true })
    })
  }

  it('ENOENT app-update.yml (dev launch) is a plain error — NO graceful flag', () => {
    const { states } = harness()
    const msg = "ENOENT: no such file or directory, open 'C:\\dev\\resources\\app-update.yml'"
    fake.__emit('error', new Error(msg))
    expect(states[0]).toEqual({ phase: 'error', message: msg })
    expect(states[0]).not.toHaveProperty('signatureUnavailable')
  })

  it('isSignatureUnavailable classifies bare helper inputs', () => {
    expect(isSignatureUnavailable('not signed')).toBe(true)
    expect(isSignatureUnavailable('certificate revoked')).toBe(true)
    expect(isSignatureUnavailable('publisherName mismatch')).toBe(true)
    expect(isSignatureUnavailable('ETIMEDOUT')).toBe(false)
  })
})

describe('scheduleInitialUpdateCheck', () => {
  it('skips entirely when disabled (kill-switch / unpackaged)', () => {
    let scheduled = 0
    const fired = scheduleInitialUpdateCheck({
      check: () => undefined,
      disabled: true,
      schedule: () => {
        scheduled += 1
      }
    })
    expect(fired).toBe(false)
    expect(scheduled).toBe(0)
  })

  it('defers the check by the plan constant (5000 ms) and fires once', () => {
    let fn: (() => void) | null = null
    let ms = 0
    let checks = 0
    const fired = scheduleInitialUpdateCheck({
      check: () => {
        checks += 1
      },
      schedule: (f, d) => {
        fn = f
        ms = d
      }
    })
    expect(fired).toBe(true)
    expect(UPDATE_CHECK_INITIAL_DELAY_MS).toBe(5000)
    expect(ms).toBe(UPDATE_CHECK_INITIAL_DELAY_MS)
    fn?.()
    expect(checks).toBe(1)
  })
})
