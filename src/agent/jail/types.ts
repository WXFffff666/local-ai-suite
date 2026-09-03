/**
 * Native Windows Job Object jail domain types (todo26). Pure module: no Electron,
 * no IPC, no imports from main/. The koffi FFI layer (win32.ts) and the tree-kill
 * watchdog fallback (watchdog.ts) both produce the SAME {@link JailHandle} so
 * todo28 codes against one jail API regardless of which tier is active.
 *
 * Threat-model honesty (plan R3b / todo35): a Job Object is a CONTAINMENT device
 * (kill-on-close backstop + whole-tree TerminateJobObject), NOT a container-grade
 * security boundary. It adds no filesystem/network restrictions.
 */

export const JAIL_KINDS = ['native-job', 'watchdog'] as const
export type JailKind = (typeof JAIL_KINDS)[number]

/** Structured reason why the native tier is unavailable (never a bare string). */
export type JailUnavailable =
  | { readonly reason: 'not-win32'; readonly platform: string }
  | { readonly reason: 'not-x64-or-arm64'; readonly arch: string }
  | { readonly reason: 'koffi-missing'; readonly detail: string }
  | { readonly reason: 'exports-missing'; readonly detail: string }
  | { readonly reason: 'create-failed'; readonly detail: string }

export const JAIL_WARNING_AREAS = ['limits', 'integrity', 'watchdog'] as const
export type JailWarningArea = (typeof JAIL_WARNING_AREAS)[number]

export type JailWarning = {
  readonly area: JailWarningArea
  readonly message: string
}

export type JailOptions = {
  /** Best-effort degradations (limits rejected by the OS, integrity unavailable) surface here, never as throws. */
  readonly onWarning?: (warning: JailWarning) => void
}

/** Anything spawn()-like: we only need the OS pid to enroll it in the jail. */
export type ManagedChild = {
  readonly pid?: number
}

/**
 * One jail instance. Lifecycle: createJail -> assign(pid) per spawned child
 * (descendants inherit the job automatically) -> kill() any number of times
 * (idempotent) -> close() releases the OS handle (idempotent). After close(),
 * assign() returns false and kill() is a no-op.
 */
export interface JailHandle {
  readonly kind: JailKind
  /** Unique job/tracker name (already includes pid+seq for native jobs). */
  readonly name: string
  readonly closed: boolean
  /** True once the OS enforces kill-on-last-handle-close (native: SetInformationJobObject accepted). */
  readonly limitsApplied: boolean
  /** Enroll a live process by OS pid. True on success. */
  assign(pid: number): boolean
  /** Terminate every process inside the jail. Idempotent; safe after kill. */
  kill(): boolean
  /** kill() + release OS resources. Idempotent; never throws. */
  close(): void
  /**
   * Best-effort lower a jail member to Low integrity (S-1-16-4096).
   * Returns false + warning when the platform/policy refuses - never throws,
   * never compromises the rest of the jail.
   */
  setLowIntegrity(pid: number): boolean
  /** Options to spread into child_process.spawn/execa: keeps children in our tree (no detached groups). */
  spawnOptions(): { readonly detached: false }
  /**
   * Spawn-then-assign higher-order wrapper. Windows cannot assign before the
   * process exists, so there is a documented microsecond window between
   * CreateProcess and AssignProcessToJobObject; assigning immediately is
   * race-safe enough for our threat model (the child does real work only
   * after our IPC-gated permission decision).
   */
  managedSpawn<T extends ManagedChild>(spawnFn: () => T): T
  /** ShutdownHook-compatible fn (() => void | Promise<void>) for src/main/shutdown.ts registries - no import here. */
  toShutdownHook(): () => void
}

/** x64 byte layout of the Win32 job structs, measured from the live koffi types. */
export type JailLayout = {
  readonly sizeofIoCounters: number
  readonly sizeofBasicLimit: number
  readonly sizeofExtendedLimit: number
  readonly offsetLimitFlags: number
  readonly offsetIoInfo: number
  readonly offsetProcessMemoryLimit: number
  readonly offsetJobMemoryLimit: number
}

/** Minimal structural view of the koffi module surface we touch (validated at the boundary). */
export type KoffiLibraryLike = {
  func(definition: string): (...args: unknown[]) => unknown
}

export type KoffiLike = {
  load(path: string): KoffiLibraryLike
  struct(name: string | null, def: Record<string, unknown>): unknown
  sizeof(type: unknown): number
  offsetof(type: unknown, member: string): number
}

export type KoffiLoader = () => unknown
