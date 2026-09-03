/**
 * Native Windows Job Object jail lifecycle (todo26).
 *
 * What this is: every agent-spawned child is assigned to one Job Object;
 * descendants inherit the job, so TerminateJobObject reaps the WHOLE tree even
 * if our process loses track. With JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE applied
 * (best-effort; see native.ts header for the Kaspersky caveat), the OS itself
 * reaps the tree if we crash (last handle closes).
 *
 * What this is NOT: a container-grade security boundary. No fs/net restrictions.
 * (todo35 mirrors this in SECURITY.md.)
 */
import {
  type JailHandle,
  type JailOptions,
  type JailWarning,
  type ManagedChild,
} from './types'
import { type NativeProbe, cachedProbe } from './native'

export { computeProbe, getLayout, isAvailable, resetProbeCache, unavailableReason } from './native'

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
// Breakaway stays FORBIDDEN: neither JOB_OBJECT_LIMIT_BREAKAWAY_OK(0x800) nor
// JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK(0x1000) is ever set, so children cannot
// escape the job.
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 3
const PROCESS_TERMINATE = 0x00000001
const PROCESS_SET_QUOTA = 0x00000100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000
const TOKEN_QUERY = 0x00000008
const TOKEN_ADJUST_DEFAULT = 0x00000080
const TOKEN_INTEGRITY_LEVEL_CLASS = 25
const LOW_INTEGRITY_SID = 'S-1-16-4096'

function zeroedExtendedLimits(): object {
  return {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  }
}

function warn(opts: JailOptions, warning: JailWarning): void {
  opts.onWarning?.(warning)
}

function setLowIntegrity(probe: NativeProbe, pid: number, opts: JailOptions): boolean {
  const { koffi: k, kernel32: ker, advapi32: adv } = probe
  if (adv === null) {
    warn(opts, { area: 'integrity', message: 'advapi32 token APIs unavailable' })
    return false
  }
  const proc = ker.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (proc === null || proc === 0n) {
    warn(opts, { area: 'integrity', message: `OpenProcess(${pid}) failed (gle=${ker.GetLastError()}); cannot adjust integrity` })
    return false
  }
  try {
    const tokenBuf = Buffer.alloc(8)
    if (adv.OpenProcessToken(proc, TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, tokenBuf) !== 1) {
      warn(opts, { area: 'integrity', message: `OpenProcessToken failed (gle=${ker.GetLastError()})` })
      return false
    }
    const token = tokenBuf.readBigUInt64LE(0)
    const sidBuf = Buffer.alloc(8)
    if (adv.ConvertStringSidToSidW(LOW_INTEGRITY_SID, sidBuf) !== 1) {
      warn(opts, { area: 'integrity', message: `ConvertStringSidToSidW failed (gle=${ker.GetLastError()})` })
      return false
    }
    const sid = sidBuf.readBigUInt64LE(0)
    try {
      const label = { Label: { Sid: sid, Attributes: 0 } }
      if (adv.SetTokenInformation(token, TOKEN_INTEGRITY_LEVEL_CLASS, label, k.sizeof('TOKEN_MANDATORY_LABEL')) !== 1) {
        warn(opts, { area: 'integrity', message: `SetTokenInformation(TokenIntegrityLevel->Low) failed (gle=${ker.GetLastError()}); child keeps its default integrity` })
        return false
      }
      return true
    } finally {
      ker.LocalFree(sid)
      ker.CloseHandle(token)
    }
  } finally {
    ker.CloseHandle(proc)
  }
}

let jailSeq = 0

/**
 * Create a native jail. Returns null when the native tier is unavailable
 * (reason via unavailableReason()). Never throws.
 */
export function createJail(name: string, opts: JailOptions = {}): JailHandle | null {
  const result = cachedProbe()
  if ('reason' in result) return null
  const probe = result.probe
  const { koffi: k, kernel32: ker } = probe
  const uniqueName = `${name}-${process.pid}-${jailSeq++}`
  const job = ker.CreateJobObjectW(null, uniqueName)
  if (job === null || job === 0n) {
    warn(opts, { area: 'limits', message: `CreateJobObjectW('${uniqueName}') failed (gle=${ker.GetLastError()})` })
    return null
  }
  let limitsApplied = false
  if (ker.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, zeroedExtendedLimits(), k.sizeof('JOBOBJECT_EXTENDED_LIMIT_INFORMATION')) === 1) {
    limitsApplied = true
  } else {
    warn(opts, {
      area: 'limits',
      message: `SetInformationJobObject failed (gle=${ker.GetLastError()}); KILL_ON_JOB_CLOSE not enforced on this host - tree reaping relies on kill()/shutdown hooks only`,
    })
  }

  let closed = false

  const handle: JailHandle = {
    kind: 'native-job',
    name: uniqueName,
    get closed(): boolean {
      return closed
    },
    get limitsApplied(): boolean {
      return limitsApplied
    },
    assign(pid: number): boolean {
      if (closed) return false
      const proc = ker.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
      if (proc === null || proc === 0n) return false
      try {
        return ker.AssignProcessToJobObject(job, proc) === 1
      } finally {
        ker.CloseHandle(proc)
      }
    },
    kill(): boolean {
      if (closed) return false
      return ker.TerminateJobObject(job, 1) === 1
    },
    close(): void {
      if (closed) return
      closed = true
      ker.TerminateJobObject(job, 1)
      ker.CloseHandle(job)
    },
    setLowIntegrity(pid: number): boolean {
      if (closed) {
        warn(opts, { area: 'integrity', message: 'jail closed' })
        return false
      }
      return setLowIntegrity(probe, pid, opts)
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

