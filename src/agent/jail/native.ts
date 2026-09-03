/**
 * koffi FFI plumbing for the native Windows Job Object jail (todo26).
 * Owns: struct definitions, the kernel32/advapi32 binding table, the cached
 * availability probe, and the live koffi-measured struct layout. The jail
 * lifecycle itself lives in win32.ts.
 *
 * Environment caveat observed on the dev box: Kaspersky's injected hook layer
 * rejects SetInformationJobObject with ERROR_BAD_LENGTH(24) for EVERY class
 * (verified independently via .NET P/Invoke with known-good 144-byte layouts),
 * while Create/Assign/Terminate/Close all work. Therefore limit application is
 * BEST-EFFORT: win32.ts demotes a SetInformation failure to a 'limits' warning
 * + limitsApplied=false. On a clean box the limits apply and parent-crash
 * reaping is OS-enforced.
 */
import type * as Koffi from 'koffi'
import { type JailLayout, type JailUnavailable, type KoffiLoader } from './types'

export type Kernel32 = {
  CreateJobObjectW(attributes: null, name: string): bigint | null
  SetInformationJobObject(job: bigint, infoClass: number, info: object, length: number): number
  AssignProcessToJobObject(job: bigint, process: bigint): number
  TerminateJobObject(job: bigint, exitCode: number): number
  OpenProcess(access: number, inherit: number, pid: number): bigint | null
  CloseHandle(handle: bigint): number
  LocalFree(mem: bigint): bigint | null
  GetLastError(): number
}

export type Advapi32 = {
  OpenProcessToken(process: bigint, access: number, tokenOut: Buffer): number
  ConvertStringSidToSidW(sid: string, sidOut: Buffer): number
  SetTokenInformation(token: bigint, cls: number, value: object, length: number): number
}

export type NativeProbe = {
  readonly koffi: typeof Koffi
  readonly kernel32: Kernel32
  readonly advapi32: Advapi32 | null
}

export type ProbeResult = { readonly probe: NativeProbe } | { readonly reason: JailUnavailable }

const KERNEL32_SIGNATURES: Readonly<Record<keyof Kernel32, string>> = {
  CreateJobObjectW: 'void* CreateJobObjectW(void*, str16)',
  SetInformationJobObject: 'int32 SetInformationJobObject(void*, int32, JOBOBJECT_EXTENDED_LIMIT_INFORMATION*, uint32)',
  AssignProcessToJobObject: 'int32 AssignProcessToJobObject(void*, void*)',
  TerminateJobObject: 'int32 TerminateJobObject(void*, uint32)',
  OpenProcess: 'void* OpenProcess(uint32, int32, uint32)',
  CloseHandle: 'int32 CloseHandle(void*)',
  LocalFree: 'void* LocalFree(void*)',
  GetLastError: 'uint32 GetLastError()',
}

const ADVAPI32_SIGNATURES: Readonly<Record<keyof Advapi32, string>> = {
  OpenProcessToken: 'int32 OpenProcessToken(void*, uint32, void**)',
  ConvertStringSidToSidW: 'int32 ConvertStringSidToSidW(str16, void**)',
  SetTokenInformation: 'int32 SetTokenInformation(void*, int32, TOKEN_MANDATORY_LABEL*, uint32)',
}

/** Win32 struct layouts, koffi-defined by name. Layout offsets are asserted in layout.test.ts. */
function defineJobStructs(k: typeof Koffi): void {
  k.struct('IO_COUNTERS', {
    ReadOperationCount: 'uint64',
    WriteOperationCount: 'uint64',
    OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64',
    WriteTransferCount: 'uint64',
    OtherTransferCount: 'uint64',
  })
  k.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'size_t',
    MaximumWorkingSetSize: 'size_t',
    ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
  })
  k.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: 'JOBOBJECT_BASIC_LIMIT_INFORMATION',
    IoInfo: 'IO_COUNTERS',
    ProcessMemoryLimit: 'size_t',
    JobMemoryLimit: 'size_t',
    PeakProcessMemoryUsed: 'size_t',
    PeakJobMemoryUsed: 'size_t',
  })
  k.struct('SID_AND_ATTRIBUTES', { Sid: 'void*', Attributes: 'uint32' })
  k.struct('TOKEN_MANDATORY_LABEL', { Label: 'SID_AND_ATTRIBUTES' })
}

function defaultLoader(): unknown {
  return require('koffi')
}

function bindAll<T>(lib: { func(definition: string): unknown }, signatures: Readonly<Record<keyof T, string>>): T {
  const bound = {} as Record<keyof T, unknown>
  for (const key of Object.keys(signatures) as Array<keyof T>) {
    bound[key] = lib.func(signatures[key])
  }
  return bound as T
}

/**
 * Pure probe: loads koffi, defines the struct table, binds every export.
 * Exported so availability tests can drive every failure path with fakes.
 */
export function computeProbe(loader: KoffiLoader = defaultLoader, platform: string = process.platform, arch: string = process.arch): ProbeResult {
  if (platform !== 'win32') return { reason: { reason: 'not-win32', platform } }
  if (arch !== 'x64' && arch !== 'arm64') return { reason: { reason: 'not-x64-or-arm64', arch } }
  let koffi: typeof Koffi
  try {
    koffi = loader() as typeof Koffi
  } catch (error) {
    return { reason: { reason: 'koffi-missing', detail: String(error) } }
  }
  try {
    defineJobStructs(koffi)
    const kernel32 = bindAll<Kernel32>(koffi.load('kernel32.dll'), KERNEL32_SIGNATURES)
    let advapi32: Advapi32 | null = null
    try {
      advapi32 = bindAll<Advapi32>(koffi.load('advapi32.dll'), ADVAPI32_SIGNATURES)
    } catch {
      advapi32 = null // integrity tier is optional; the jail itself still works
    }
    return { probe: { koffi, kernel32, advapi32 } }
  } catch (error) {
    return { reason: { reason: 'exports-missing', detail: String(error) } }
  }
}

let cachedProbeResult: ProbeResult | null = null

export function cachedProbe(): ProbeResult {
  if (cachedProbeResult === null) cachedProbeResult = computeProbe()
  return cachedProbeResult
}

/** Test seam: drop the memoized probe so the next call re-probes. */
export function resetProbeCache(): void {
  cachedProbeResult = null
}

export function isAvailable(): boolean {
  return 'probe' in cachedProbe()
}

export function unavailableReason(): JailUnavailable | null {
  const result = cachedProbe()
  return 'reason' in result ? result.reason : null
}

/** Live koffi-measured struct geometry; null when the native tier is unavailable. */
export function getLayout(): JailLayout | null {
  const result = cachedProbe()
  if ('reason' in result) return null
  const k = result.probe.koffi
  return {
    sizeofIoCounters: k.sizeof('IO_COUNTERS'),
    sizeofBasicLimit: k.sizeof('JOBOBJECT_BASIC_LIMIT_INFORMATION'),
    sizeofExtendedLimit: k.sizeof('JOBOBJECT_EXTENDED_LIMIT_INFORMATION'),
    offsetLimitFlags: k.offsetof('JOBOBJECT_BASIC_LIMIT_INFORMATION', 'LimitFlags'),
    offsetIoInfo: k.offsetof('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', 'IoInfo'),
    offsetProcessMemoryLimit: k.offsetof('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', 'ProcessMemoryLimit'),
    offsetJobMemoryLimit: k.offsetof('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', 'JobMemoryLimit'),
  }
}
