/**
 * Watchdog fallback tier: REAL-PIDS proof that tree-kill produces the same
 * observable outcome as the native jail (parent + children gone), plus the
 * documented weaker-guarantee note lives in watchdog.ts. Sequential.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createJailWithFallback, isAvailable } from './index'
import { createWatchdogJail } from './watchdog'
import type { JailHandle, JailWarning } from './types'
import { childPidsOf, isAlive, sleep, TREE_ARGV } from './testutils'

describe('watchdog jail fallback (real pids, sequential)', { sequential: true, timeout: 120_000 }, () => {
  let jail: JailHandle | null = null

  afterAll(() => {
    jail?.close()
  })

  it('createJailWithFallback returns native on a healthy box; forced watchdog path is explicit', { timeout: 30_000 }, () => {
    const viaFallback = createJailWithFallback('laits-26-fallback')
    expect(viaFallback.kind).toBe(isAvailable() ? 'native-job' : 'watchdog')
    expect(viaFallback.spawnOptions()).toStrictEqual({ detached: false })
    viaFallback.close()
  })

  it('kill() reaps the enrolled tree via taskkill /T /F (same observable outcome as native)', { timeout: 30_000 }, async () => {
    const warnings: JailWarning[] = []
    jail = createWatchdogJail('laits-26-wd', { onWarning: (w) => void warnings.push(w) })
    const parent = jail.managedSpawn(() => spawn('cmd.exe', [...TREE_ARGV], { stdio: 'ignore', windowsHide: true }))
    const parentPid = parent.pid
    expect(typeof parentPid === 'number' && parentPid > 0).toBe(true)
    if (typeof parentPid !== 'number') return

    await sleep(3000)
    expect(isAlive(parentPid)).toBe(true)
    const kids = childPidsOf(parentPid)
    expect(kids.length, 'cmd should have live ping children').toBeGreaterThanOrEqual(1)
    console.log(`[watchdog-evidence] BEFORE kill: parent=${parentPid} kids=${kids.join(',')}`)

    expect(jail.kill()).toBe(true)
    await sleep(2000)
    console.log(`[watchdog-evidence] AFTER kill: parent alive=${isAlive(parentPid)} kids alive=${kids.filter((k) => isAlive(k)).join(',') || 'none'}`)
    expect(isAlive(parentPid), 'watchdog left the parent cmd running').toBe(false)
    for (const k of kids) expect(isAlive(k), `watchdog left child ${k} running`).toBe(false)
    expect(warnings.filter((w) => w.area === 'watchdog')).toHaveLength(0)
  })

  it('double kill + double close are idempotent; closed jail stops enrolling', { timeout: 30_000 }, () => {
    if (jail === null) return
    expect(jail.kill()).toBe(true) // pids already dead: taskkill 128 counts as success
    jail.close()
    jail.close()
    expect(jail.closed).toBe(true)
    expect(jail.assign(12345)).toBe(false)
    expect(jail.kill()).toBe(false)
  })

  it('setLowIntegrity on the watchdog tier warns and returns false (never throws)', { timeout: 30_000 }, () => {
    const warnings: JailWarning[] = []
    const wd = createWatchdogJail('laits-26-wd-int', { onWarning: (w) => void warnings.push(w) })
    expect(wd.setLowIntegrity(process.pid)).toBe(false)
    expect(warnings.some((w) => w.area === 'integrity')).toBe(true)
    wd.close()
  })
})
