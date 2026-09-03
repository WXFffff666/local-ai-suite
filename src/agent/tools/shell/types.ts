/**
 * types.ts — todo28 shell-tool contracts. The single surface todo29 wires:
 * the chunk sink is bridged to the whitelisted 'agent:term' EVENT (payload
 * `{ id, chunk }`, src/main/ipc/whitelist.ts AgentTermEvent) via
 * `webContents.send('agent:term', { id: callId, chunk: data })` — the event
 * carries no stream tag, so the bridge forwards stdout/stderr in emission
 * order (chronology is preserved; the panel shows one merged scrollback per
 * callId).
 */
import type { PermissionPort } from '../fs/gating'
import type { JailWarning } from '../../jail/types'

export type ShellStream = 'stdout' | 'stderr'

/** One streamed piece of output; `data` is already decoded to a string. */
export type ShellChunk = { readonly stream: ShellStream; readonly data: string }

/**
 * Per-run chunk fan-out. Called synchronously from stream 'data' events with
 * monotonically increasing (stream, data) pairs; emission stops once the run
 * crosses maxOutputBytes (truncated=true). todo29 owns the transport.
 */
export type ShellChunkSink = (callId: string, chunk: ShellChunk) => void

/** What run_shell returns to the LLM: tails only — the panel owns the scrollback. */
export type ShellResult = {
  /** process exit code; null when killed/timed out/spawn-failed */
  readonly code: number | null
  /** last <=16 KB of decoded stdout */
  readonly stdoutTail: string
  /** last <=16 KB of decoded stderr */
  readonly stderrTail: string
  readonly timedOut: boolean
  /** true when raw output crossed maxOutputBytes */
  readonly truncated: boolean
  /** true when WE ended the process (session abort or timeout kill) */
  readonly killed: boolean
}

export type ShellToolLogger = {
  warn(msg: string, meta?: Readonly<Record<string, unknown>>): void
}

export type ShellToolDeps = {
  readonly workspaceRoot: string
  readonly permission: PermissionPort
  /**
   * 'native' = enroll every child in the todo26 jail (Job Object tier with
   * watchdog/tree-kill degradation). 'off' = bare run: only the direct child
   * is guaranteed killed on abort/timeout (tree-kill best effort) — honest
   * per Appendix C: jail is containment, not a container; the PERMISSION
   * ENGINE is the security boundary.
   */
  readonly jailMode: 'native' | 'off'
  readonly log?: ShellToolLogger
  /** default 120 s; ALSO the ceiling — a model-requested timeout is clamped down (LLM10). */
  readonly defaultTimeoutMs?: number
  /** default 1 MiB per stream */
  readonly maxOutputBytes?: number
  /**
   * Optional config-level program filter (first-token match, case-insensitive).
   * Default null = NO list: the plan's "白名单 shell" is realized through
   * policy rules (`Bash(npm:*)` etc.) evaluated by the permission engine,
   * not a hard-coded program array. This seam exists for locked-down kiosk
   * setups only.
   */
  readonly allowedPrograms?: readonly string[] | null
  /** streamed output sink (todo29 -> 'agent:term') */
  readonly onChunk?: ShellChunkSink
  /** jail degradations (watchdog fallback etc.) surface here, never thrown */
  readonly onJailWarning?: (warning: JailWarning) => void
}
