/**
 * Shared real-process helpers for the jail integration tests (todo26).
 * All checks go through tasklist/CIM so they assert OS truth, not our bookkeeping.
 */
import { execFileSync, execSync } from 'node:child_process'

/** One tasklist CSV row for the pid, or null when the pid is not running. */
export function tasklistLine(pid: number): string | null {
  const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' })
  const row = out.split(/\r?\n/).find((line) => line.startsWith('"') && new RegExp(`^"[^"]*","${pid}",`).test(line))
  return row ?? null
}

export function isAlive(pid: number): boolean {
  return tasklistLine(pid) !== null
}

/** Direct child pids via WMI (wmic.exe is gone on 24H2; CIM through powershell is the supported path). */
export function childPidsOf(pid: number): number[] {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId`],
    { encoding: 'utf8' },
  )
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A cmd that (1) buys ~1s with a ping delay so the caller can enroll it in the
 * jail, then (2) runs one 600s ping in the foreground and one via `start /b`
 * (grandchild path). Returns nothing; pass the pid around yourself.
 */
export const TREE_ARGV: readonly string[] = ['/d', '/s', '/c', 'ping -n 2 127.0.0.1 >nul & start /b ping -n 600 127.0.0.1 & ping -n 600 127.0.0.1']
