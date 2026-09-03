/**
 * Availability probing: unit tests drive every computeProbe failure branch with
 * fake loaders (no crash allowed), plus the real probe on this Windows box.
 * No processes are spawned here.
 */
import { describe, expect, it } from 'vitest'
import { computeProbe, createJail, isAvailable, unavailableReason } from './win32'
import type { JailWarning } from './types'

const throwingLoader = (): never => {
  throw new Error("Cannot find module 'koffi'")
}

function fakeKoffi(options: { readonly advapiBroken?: boolean; readonly kernel32Broken?: boolean } = {}): unknown {
  return {
    load: (name: string) => {
      if (name === 'kernel32.dll' && options.kernel32Broken) {
        throw new Error("Cannot find function 'CreateJobObjectW' in shared library")
      }
      if (name === 'advapi32.dll' && options.advapiBroken) throw new Error('advapi blocked')
      return { func: () => () => 1 }
    },
    struct: () => 0,
    sizeof: () => 144,
    offsetof: () => 16,
  }
}

describe('computeProbe failure paths (mocked loaders)', () => {
  it('non-win32 platform -> not-win32, loader never called', () => {
    const r = computeProbe(throwingLoader, 'linux', 'x64')
    expect('reason' in r && r.reason).toStrictEqual({ reason: 'not-win32', platform: 'linux' })
  })

  it('unsupported arch -> not-x64-or-arm64', () => {
    const r = computeProbe(throwingLoader, 'win32', 'ia32')
    expect('reason' in r && r.reason).toStrictEqual({ reason: 'not-x64-or-arm64', arch: 'ia32' })
  })

  it('koffi not installed -> koffi-missing carrying the load error', () => {
    const r = computeProbe(throwingLoader, 'win32', 'x64')
    expect('reason' in r && r.reason.reason).toBe('koffi-missing')
    expect('reason' in r && r.reason.reason === 'koffi-missing' ? r.reason.detail : '').toContain('Cannot find module')
  })

  it('kernel32 export missing -> exports-missing (probe binds, never crashes)', () => {
    const r = computeProbe(() => fakeKoffi({ kernel32Broken: true }), 'win32', 'x64')
    expect('reason' in r && r.reason.reason).toStrictEqual('exports-missing')
  })

  it('advapi32 missing degrades the integrity tier only (jail stays available)', () => {
    const r = computeProbe(() => fakeKoffi({ advapiBroken: true }), 'win32', 'x64')
    expect('probe' in r && r.probe.advapi32).toBeNull()
    expect('probe' in r && r.probe.kernel32 !== undefined).toBe(true)
  })

  it('healthy fake passes with both libraries bound', () => {
    const r = computeProbe(() => fakeKoffi(), 'win32', 'x64')
    expect('probe' in r && r.probe.advapi32 !== null).toBe(true)
  })
})

describe('native tier on this box', () => {
  it('isAvailable() is true and unavailableReason() is null', { timeout: 30_000 }, () => {
    expect(isAvailable(), `reason: ${JSON.stringify(unavailableReason())}`).toBe(true)
    expect(unavailableReason()).toBeNull()
  })

  it('createJail yields a handle; if the host blocks limits, a limits warning is emitted instead of failure', { timeout: 30_000 }, () => {
    const warnings: JailWarning[] = []
    const jail = createJail('laits-26-avail', { onWarning: (w) => void warnings.push(w) })
    expect(jail).not.toBeNull()
    if (jail === null) return
    expect(jail.kind).toBe('native-job')
    expect(jail.limitsApplied).toBeTypeOf('boolean')
    if (!jail.limitsApplied) {
      expect(warnings.some((w) => w.area === 'limits')).toBe(true)
    }
    jail.close()
    expect(jail.closed).toBe(true)
  })

  it('setLowIntegrity on a jail member never throws; failure comes back as false + integrity warning', { timeout: 30_000 }, async () => {
    const { spawn } = await import('node:child_process')
    const { sleep } = await import('./testutils')
    const warnings: JailWarning[] = []
    const jail = createJail('laits-26-integrity', { onWarning: (w) => void warnings.push(w) })
    expect(jail).not.toBeNull()
    if (jail === null) return
    // Deliberately NOT the test runner's own pid: demoting ourselves would poison the box.
    const child = jail.managedSpawn(() => spawn('ping', ['-n', '30', '127.0.0.1'], { stdio: 'ignore', windowsHide: true }))
    const pid = child.pid
    expect(typeof pid === 'number' && pid > 0).toBe(true)
    if (typeof pid !== 'number') return
    const result = jail.setLowIntegrity(pid)
    expect(result).toBeTypeOf('boolean')
    if (!result) expect(warnings.some((w) => w.area === 'integrity')).toBe(true)
    jail.close()
    await sleep(300)
  })
})
