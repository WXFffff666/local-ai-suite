/**
 * testutils.ts — todo28 shell-test helpers. Not imported by production code.
 * `pidAlive` answers "is this OS process still running?" per platform:
 * win32 through `tasklist /FI` (the plan's tasklist assertion), POSIX
 * through `kill -0`. The timeout/orphan tests use it to prove the jail /
 * tree-kill chain actually reaped the grandchild.
 */
import { spawnSync } from 'node:child_process'

export function pidAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    const res = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' })
    return res.stdout.includes(String(pid))
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, not ours
  }
}
