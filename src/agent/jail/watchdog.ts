/**
 * Tree-kill watchdog jail (todo26, plan R3b fallback tier 2).
 *
 * Used when the native Job Object tier is unavailable (non-win32, koffi
 * missing/blocked). WEAKER GUARANTEE by design: nothing is enforced by the OS
 * between our calls - we only remember enrolled pids and on kill() run
 * `taskkill /T /F /PID <pid>` per tree. If this process dies before kill(),
 * children keep running (no KILL_ON_JOB_CLOSE backstop), and orphans that
 * already reparented away from an enrolled pid escape the /T walk. The caller
 * keeps the shutdown-hook registration to shrink that window.
 */
import { spawnSync } from 'node:child_process'
import { type JailHandle, type JailOptions, type ManagedChild } from './types'

const TASKKILL = 'taskkill.exe'

let watchdogSeq = 0

export function createWatchdogJail(name: string, opts: JailOptions = {}): JailHandle {
  const trackerName = `${name}-watchdog-${process.pid}-${watchdogSeq++}`
  const pids = new Set<number>()
  let closed = false
  let killAttempted = false

  const taskkill = (pid: number): boolean => {
    if (process.platform !== 'win32') {
      opts.onWarning?.({ area: 'watchdog', message: `taskkill unavailable on ${process.platform}; pid ${pid} left running` })
      return false
    }
    // spawnSync (no shell): /T walks the child tree, /F forces termination.
    const res = spawnSync(TASKKILL, ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
    if (res.error !== undefined || (res.status !== 0 && res.status !== 128)) {
      // status 128 = "no such process" - already gone, counts as success
      opts.onWarning?.({ area: 'watchdog', message: `taskkill /T /F /PID ${pid} failed (status=${String(res.status)}, error=${String(res.error?.message)})` })
      return false
    }
    return true
  }

  const handle: JailHandle = {
    kind: 'watchdog',
    name: trackerName,
    get closed(): boolean {
      return closed
    },
    // The watchdog tier never has OS-enforced kill-on-close.
    limitsApplied: false,
    assign(pid: number): boolean {
      if (closed) return false
      pids.add(pid)
      return true
    },
    kill(): boolean {
      if (closed) return false
      killAttempted = true
      let allOk = true
      for (const pid of pids) {
        if (!taskkill(pid)) allOk = false
      }
      return allOk
    },
    close(): void {
      if (closed) return
      if (!killAttempted) handle.kill()
      closed = true
      pids.clear()
    },
    setLowIntegrity(): boolean {
      opts.onWarning?.({ area: 'integrity', message: 'integrity control requires the native job tier; watchdog cannot lower integrity' })
      return false
    },
    spawnOptions(): { readonly detached: false } {
      return { detached: false }
    },
    managedSpawn<T extends ManagedChild>(spawnFn: () => T): T {
      const child = spawnFn()
      if (typeof child.pid === 'number') handle.assign(child.pid)
      return child
    },
    toShutdownHook(): () => void {
      return () => {
        handle.close()
      }
    },
  }
  return handle
}
