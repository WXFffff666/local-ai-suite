/**
 * process.ts — todo28 execution core: spawn a single command string through
 * the platform shell INSIDE the todo26 jail, stream decoded UTF-8 chunks,
 * and reap the whole process tree on timeout/abort.
 *
 * Shell choice & quoting (plan todo28: "cmd/powershell -Command 单条"):
 *   win32: powershell.exe -NoProfile -NonInteractive -EncodedCommand <b64>
 *   posix: $SHELL || /bin/sh -c <one string>
 * The command is passed as ONE value — on Windows via -EncodedCommand
 * (base64 UTF-16LE), the ONLY handoff that cannot be mangled by argv
 * quoting layers — so pipes/quotes/newlines survive to the PowerShell
 * parser byte-for-byte. Residual quoting risk stays INSIDE PowerShell's own
 * parser (by design the model's command string IS shell source); known
 * caveat: Windows PowerShell 5.1 strips embedded double quotes when it
 * forwards an argument to a native program (fixed only in pwsh 7.3+
 * PSNativeCommandArgumentPassing) — the tool description pins the shell so
 * the model can emit shell-correct quoting. We never route through cmd.exe,
 * whose `^`/`&` re-parse layer would be the other real hazard.
 *
 * UTF-8 (plan: chcp/OutputEncoding + cp936 fallback): the forced-codepage
 * prefix covers the common case; if the child still emits legacy-codepage
 * bytes, the collector's fatal-UTF-8 probe falls back to GBK (cp936)
 * decoding. Emission to the UI always uses streaming UTF-8 — a mis-decoded
 * live tail is cosmetic; the final tail is re-derived from the raw bytes.
 *
 * Kill chain (Appendix C honesty — containment, not container):
 *   jail mode 'native'  -> createJailWithFallback: OS Job Object (grandchild
 *                          inherit + KILL_ON_JOB_CLOSE backstop on close())
 *                          or the watchdog (taskkill /T /F) tier; jail.kill()
 *                          first, tree-kill only when the jail reports failure.
 *   jail mode 'off'     -> direct child killed by execa (timeout/signal),
 *                          tree-kill best-effort afterwards. Orphan escape is
 *                          possible by design; the permission engine remains
 *                          the security boundary.
 */
import { TextDecoder } from 'node:util'

import { execa, type ExecaChildProcess } from 'execa'
import treeKill from 'tree-kill'

import { createJailWithFallback } from '../../jail'
import type { JailHandle, JailWarning } from '../../jail/types'
import type { ShellChunk, ShellChunkSink, ShellResult, ShellStream } from './types'

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576
/** per-stream tail handed back to the LLM (plan: <=16 KB) */
export const SHELL_TAIL_BYTES = 16 * 1024

/** PowerShell 5.1 emits the OEM codepage on redirected pipes unless OutputEncoding is forced to UTF-8. */
const POWERSHELL_UTF8_PREFIX = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '

export type ShellInvocation = { readonly file: string; readonly args: readonly string[] }

export function resolveShellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  posixShell: string | undefined = process.env.SHELL,
): ShellInvocation {
  if (platform === 'win32') {
    const script = `${POWERSHELL_UTF8_PREFIX}${command}`
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    }
  }
  return { file: posixShell ?? '/bin/sh', args: ['-c', command] }
}

/** 0 = default; anything above the configured default clamps DOWN (LLM10 无界消耗). */
export function computeTimeoutMs(requested: number, defaultMs: number): number {
  if (requested <= 0) return defaultMs
  return Math.min(requested, defaultMs)
}

// --- stream collection -----------------------------------------------------------

export type StreamCollectorOptions = {
  readonly stream: ShellStream
  readonly maxBytes: number
  readonly onChunk?: (chunk: ShellChunk) => void
}

export type StreamFinish = { readonly tail: string; readonly truncated: boolean; readonly bytesSeen: number }

export type StreamCollector = {
  push(data: Uint8Array): void
  finish(): StreamFinish
}

/** Fatal-UTF-8 probe tolerant of one truncated multi-byte sequence at the cap seam; GBK then lossy-UTF-8 fallbacks. */
function decodeRaw(chunks: readonly Buffer[]): string {
  const flat = Buffer.concat(chunks)
  for (const trim of [0, 1, 2, 3] as const) {
    const probe = trim === 0 ? flat : flat.subarray(0, Math.max(0, flat.length - trim))
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(probe)
    } catch {
      // try the next seam trim
    }
  }
  try {
    return new TextDecoder('gbk').decode(flat) // cp936 fallback per plan
  } catch {
    return new TextDecoder('utf-8').decode(flat) // last resort: lossy UTF-8
  }
}

function tailWithin(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let cut = Math.max(0, text.length - maxBytes)
  while (cut < text.length && Buffer.byteLength(text.slice(cut), 'utf8') > maxBytes) cut += 64
  return text.slice(cut)
}

export function createStreamCollector(opts: StreamCollectorOptions): StreamCollector {
  const decoder = new TextDecoder('utf-8') // non-fatal, streaming: splits mid-character safely
  const retained: Buffer[] = []
  let retainedBytes = 0
  let bytesSeen = 0
  let truncated = false

  const emit = (bytes: Uint8Array): void => {
    retained.push(Buffer.from(bytes))
    retainedBytes += bytes.byteLength
    opts.onChunk?.({ stream: opts.stream, data: decoder.decode(bytes, { stream: true }) })
  }

  return {
    push(data: Uint8Array): void {
      bytesSeen += data.byteLength
      if (truncated) return // drain (keeps the pipe from blocking) but never re-emit
      if (retainedBytes + data.byteLength <= opts.maxBytes) {
        emit(data)
      } else {
        const budget = opts.maxBytes - retainedBytes
        if (budget > 0) emit(data.subarray(0, budget))
        truncated = true
      }
    },
    finish(): StreamFinish {
      const text = retained.length === 0 ? '' : decodeRaw(retained)
      return { tail: tailWithin(text, SHELL_TAIL_BYTES), truncated, bytesSeen }
    },
  }
}

// --- the runner ---------------------------------------------------------------------

export type ShellProcessSpec = {
  readonly callId: string
  readonly command: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly signal: AbortSignal
  readonly jailMode: 'native' | 'off'
  readonly jailName?: string
  readonly onChunk?: ShellChunkSink
  readonly onSpawn?: (pid: number) => void
  readonly onWarning?: (warning: JailWarning) => void
}

function treeKillAsync(pid: number): Promise<void> {
  return new Promise((resolve) => {
    treeKill(pid, 'SIGKILL', () => resolve())
  })
}

/**
 * jail-first, tree-kill fallback: TerminateJobObject / taskkill /T is the
 * authoritative kill when the jail tier succeeded; tree-kill only runs when
 * the jail declined (watchdog tier without taskkill, or jail mode 'off').
 */
async function terminateTree(jail: JailHandle | null, pid: number | undefined): Promise<void> {
  const jailOk = jail !== null && jail.kill()
  if (!jailOk && pid !== undefined) await treeKillAsync(pid)
}

type ExecaResult = Awaited<ExecaChildProcess<Buffer>>

export async function runShellProcess(spec: ShellProcessSpec): Promise<ShellResult> {
  const { file, args } = resolveShellInvocation(spec.command)
  const jail =
    spec.jailMode === 'native'
      ? createJailWithFallback(spec.jailName ?? 'local-ai-shell', {
          onWarning: spec.onWarning ?? (() => undefined),
        })
      : null

  const collector = (stream: ShellStream): StreamCollector =>
    createStreamCollector({
      stream,
      maxBytes: spec.maxOutputBytes,
      onChunk: spec.onChunk === undefined ? undefined : (chunk): void => spec.onChunk?.(spec.callId, chunk),
    })
  const stdout = collector('stdout')
  const stderr = collector('stderr')

  const options = {
    cwd: spec.cwd,
    timeout: spec.timeoutMs,
    killSignal: 'SIGKILL' as const,
    signal: spec.signal,
    reject: false,
    buffer: false,
    encoding: 'buffer' as const,
    windowsHide: true,
  }

  // jail.managedSpawn assigns the OS pid to the job SYNCHRONOUSLY after
  // spawn — the todo26 contract (Windows cannot assign before the process
  // exists; the jail documents the microsecond window + race-safety note).
  const sub: ExecaChildProcess<Buffer> =
    jail === null
      ? execa(file, [...args], options)
      : jail.managedSpawn(() => execa(file, [...args], { ...options, ...jail.spawnOptions() }))

  try {
    if (typeof sub.pid === 'number') spec.onSpawn?.(sub.pid)
    sub.stdout?.on('data', (c: Buffer) => stdout.push(c))
    sub.stderr?.on('data', (c: Buffer) => stderr.push(c))
    // reject:false swallows the spawn error into `result.failed`; keep the
    // original message from the 'error' event for the spawnFailed branch.
    let spawnErrorMessage: string | null = null
    sub.on('error', (e: NodeJS.ErrnoException) => {
      spawnErrorMessage = e.message
    })

    let result: ExecaResult
    try {
      result = await sub
    } catch (e) {
      // reject:false means this only fires on catastrophic failures; reap
      // anything we started, then let the tool surface the error.
      await terminateTree(jail, sub.pid)
      throw e
    }

    const aborted = result.timedOut || result.killed || result.isCanceled
    const spawnFailed = result.failed && typeof result.exitCode !== 'number' && !aborted
    if (aborted) await terminateTree(jail, sub.pid)

    const out = stdout.finish()
    const err = stderr.finish()
    const code = typeof result.exitCode === 'number' ? result.exitCode : null

    if (spawnFailed) {
      const message = spawnErrorMessage ?? 'process spawn failed'
      return {
        code: null,
        stdoutTail: out.tail,
        stderrTail: tailWithin(err.tail === '' ? message : `${err.tail}\n${message}`, SHELL_TAIL_BYTES),
        timedOut: false,
        truncated: out.truncated || err.truncated,
        killed: false,
      }
    }

    return {
      code,
      stdoutTail: out.tail,
      stderrTail: err.tail,
      timedOut: result.timedOut,
      truncated: out.truncated || err.truncated,
      killed: aborted,
    }
  } finally {
    // close() releases the KILL_ON_JOB_CLOSE backstop for any survivor
    // (native tier) and runs the watchdog kill when none happened yet.
    jail?.close()
  }
}
