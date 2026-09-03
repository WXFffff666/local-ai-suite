/**
 * REAL-PROCESS integration: the native jail must reap a live parent+grandchild
 * ping tree via TerminateJobObject, verified through tasklist (OS truth), not
 * our bookkeeping. Sequential; each test budgets 30s.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createJail, isAvailable, unavailableReason } from './win32'
import type { JailHandle } from './types'
import { childPidsOf, isAlive, sleep, tasklistLine, TREE_ARGV } from './testutils'

describe('native job-object jail (real processes, sequential)', { sequential: true, timeout: 120_000 }, () => {
  let jail: JailHandle | null = null

  afterAll(() => {
    jail?.close()
  })

  it('terminate reaps parent cmd AND its ping children (inheritance), tasklist-asserted', { timeout: 30_000 }, async () => {
    expect(isAvailable(), `native tier missing: ${JSON.stringify(unavailableReason())}`).toBe(true)
    jail = createJail('laits-26-killtree')
    expect(jail).not.toBeNull()
    if (jail === null) return

    const parent = jail.managedSpawn(() => spawn('cmd.exe', [...TREE_ARGV], { stdio: 'ignore', windowsHide: true }))
    const parentPid = parent.pid
    expect(typeof parentPid === 'number' && parentPid > 0).toBe(true)
    if (typeof parentPid !== 'number') return

    await sleep(3000) // cmd's delay-ping done, long pings up; enrollment long settled
    expect(isAlive(parentPid), 'parent cmd should still be running pre-kill').toBe(true)
    const kids = childPidsOf(parentPid)
    expect(kids.length, 'cmd should have live ping children').toBeGreaterThanOrEqual(1)

    const before = [tasklistLine(parentPid), ...kids.map((k) => tasklistLine(k))].filter((l): l is string => l !== null)
    console.log(`[jail-evidence] BEFORE kill (${jail.name}):\n${before.join('\n')}`)
    for (const k of kids) expect(isAlive(k)).toBe(true)

    expect(jail.kill()).toBe(true)
    await sleep(2000)
    const after = [tasklistLine(parentPid), ...kids.map((k) => tasklistLine(k))]
    console.log(`[jail-evidence] AFTER kill: ${JSON.stringify(after)}`)
    expect(isAlive(parentPid), 'parent cmd survived TerminateJobObject').toBe(false)
    for (const k of kids) expect(isAlive(k), `grandchild ${k} survived the job kill`).toBe(false)
  })

  it('double kill is idempotent and safe after the tree is gone', { timeout: 30_000 }, async () => {
    if (jail === null) return
    expect(jail.kill()).toBe(true) // second kill on an already-empty job
    expect(jail.kill()).toBe(true)
    jail.close()
    jail.close() // idempotent
    expect(jail.closed).toBe(true)
    expect(jail.kill()).toBe(false) // closed jail: no-op, honest false
    expect(jail.assign(4)).toBe(false) // no enrollment after close
  })

  it('a process spawned after enrollment inherits the job and dies with it', { timeout: 30_000 }, async () => {
    const second = createJail('laits-26-inherit')
    expect(second).not.toBeNull()
    if (second === null) return
    // cmd sleeps ~1s, then execs a 600s ping strictly AFTER assignment: inheritance path.
    const parent = second.managedSpawn(() => spawn('cmd.exe', [...TREE_ARGV], { stdio: 'ignore', windowsHide: true }))
    const parentPid = parent.pid
    expect(typeof parentPid === 'number' && parentPid > 0).toBe(true)
    if (typeof parentPid !== 'number') return
    await sleep(3000)
    const kids = childPidsOf(parentPid)
    expect(kids.length).toBeGreaterThanOrEqual(1)
    second.close() // close == deterministic kill + handle release
    await sleep(2000)
    expect(isAlive(parentPid)).toBe(false)
    for (const k of kids) expect(isAlive(k), `inherited child ${k} escaped the jail`).toBe(false)
  })
})
