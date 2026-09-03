/**
 * Byte-offset unit tests for the Win32 job-object struct layouts bound by
 * win32.ts. Known-good values derived from MS Learn (x64):
 *   IO_COUNTERS: 6 x ULONGLONG (u64)                                  = 48 B
 *   JOBOBJECT_BASIC_LIMIT_INFORMATION:
 *     0   PerProcessUserTimeLimit LARGE_INTEGER (i64)
 *     8   PerJobUserTimeLimit     LARGE_INTEGER
 *     16  LimitFlags              DWORD
 *     24  MinimumWorkingSetSize   SIZE_T   (pad 4 after LimitFlags)
 *     32  MaximumWorkingSetSize   SIZE_T
 *     40  ActiveProcessLimit      DWORD
 *     48  Affinity                ULONG_PTR (pad 4 after ActiveProcessLimit)
 *     56  PriorityClass           DWORD
 *     60  SchedulingClass         DWORD   total 64 B
 *   JOBOBJECT_EXTENDED_LIMIT_INFORMATION:
 *     0    BasicLimitInformation (64)
 *     64   IoInfo (48)
 *     112  ProcessMemoryLimit SIZE_T
 *     120  JobMemoryLimit     SIZE_T
 *     128  PeakProcessMemoryUsed (read-only)
 *     136  PeakJobMemoryUsed     (read-only)  total 144 B
 */
import { describe, expect, it } from 'vitest'
import { getLayout, isAvailable, unavailableReason } from './win32'

const EXPECTED_X64 = {
  sizeofIoCounters: 48,
  sizeofBasicLimit: 64,
  sizeofExtendedLimit: 144,
  offsetLimitFlags: 16,
  offsetIoInfo: 64,
  offsetProcessMemoryLimit: 112,
  offsetJobMemoryLimit: 120,
} as const

describe('job-object struct layout (MS Learn x64 reference)', () => {
  it('koffi-built types match the known-good x64 sizes and offsets', () => {
    // This gate only speaks for x64; other arches have different SIZE_T widths.
    if (process.arch !== 'x64') return
    expect(isAvailable(), `jail unavailable on this box: ${JSON.stringify(unavailableReason())}`).toBe(true)
    expect(getLayout()).toStrictEqual({ ...EXPECTED_X64 })
  })
})
