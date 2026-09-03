/**
 * createShellTools — the todo28 jailed shell tool (run_shell) as a
 * registry-ready ToolRegistration, following the todo27 pattern exactly:
 * parse args (zod strictObject = trust boundary) -> optional program-list
 * filter -> cwd fence (audited) -> gate() funnel (audited; the PERMISSION
 * ENGINE is the security boundary) -> ctx.reportPhase('running') -> spawn.
 *
 * This file is also the lane's barrel: registerShellTools() is the surface
 * todo29 wires into services (it owns src/agent/tools/index.ts, so nothing
 * is re-exported through that barrel — import from './shell/index').
 */
import { realpathSync } from 'fs'
import { resolve } from 'path'

import { z, type ZodType } from 'zod'

import type { JsonObject, JsonSchema, ToolDef, ToolExecutionContext } from '../../runner/types'
import type { ToolRegistration, ToolRegistry } from '../registry'
import { fencePath, FsPathError, gate } from '../fs/gating'
import { runShellProcess, computeTimeoutMs, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_SHELL_TIMEOUT_MS, SHELL_TAIL_BYTES } from './process'
import { firstProgram } from './tokenize'
import type { ShellToolDeps, ShellToolLogger } from './types'

const runShellSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .describe(
      'A single shell command string, executed as `powershell.exe -EncodedCommand <command>` on Windows and `$SHELL -c <command>` elsewhere. Write quoting for the target shell (Windows PowerShell 5.1: prefer single quotes inside native-command arguments). Pipes, quotes and redirections are interpreted by the shell; the string itself is never rewritten.',
    ),
  cwd: z
    .string()
    .describe('Working directory relative to the workspace root ("" = workspace root). Absolute paths and escaping paths are rejected.'),
  timeoutMs: z
    .number()
    .int()
    .min(0)
    .describe('Kill the process tree after this many milliseconds. 0 = tool default; requests above the default are clamped down.'),
})

type RunShellArgs = { readonly command: string; readonly cwd: string; readonly timeoutMs: number }

function strictParams(schema: ZodType): JsonSchema {
  return z.toJSONSchema(schema) as unknown as JsonSchema
}

export function createShellTools(deps: ShellToolDeps): readonly ToolRegistration[] {
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
  const maxOutputBytes = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const allowedPrograms = deps.allowedPrograms ?? null
  const log: ShellToolLogger | undefined = deps.log

  const denyAndThrow = (
    kind: 'fs.shell',
    target: { cmd?: string; path?: string },
    reason: string,
  ): never => {
    deps.permission.record(
      { type: kind, target },
      { decision: 'deny', rule: null, ruleId: null, scope: null },
      { reason },
    )
    log?.warn('run_shell rejected', { reason, ...target })
    throw new Error(`run_shell: ${reason}`)
  }

  const run = async (args: JsonObject, ctx: ToolExecutionContext): Promise<unknown> => {
    const parsed = runShellSchema.parse(args) as RunShellArgs

    // (a) optional config-level program filter — pre-gate, audited
    if (allowedPrograms !== null) {
      const program = firstProgram(parsed.command)
      if (!allowedPrograms.some((p) => p.toLowerCase() === program)) {
        denyAndThrow('fs.shell', { cmd: parsed.command }, `program-not-allowed: ${program || '(empty)'}`)
      }
    }

    // (b) cwd fence — workspace-root is the shell's own root by design; the
    //     model may only move WITHIN it (plan: 越界即拒并计入审计, todo27 seam)
    let cwdAbs: string
    try {
      cwdAbs = parsed.cwd === '' ? realpathSync(resolve(deps.workspaceRoot)) : fencePath(deps.workspaceRoot, parsed.cwd)
    } catch (e) {
      if (e instanceof FsPathError) {
        deps.permission.record(
          { type: 'fs.shell', target: { cmd: parsed.command } },
          { decision: 'deny', rule: null, ruleId: null, scope: null },
          { reason: e.code },
        )
        log?.warn('run_shell cwd rejected', { reason: e.code, cwd: parsed.cwd })
      }
      throw e
    }

    // (c) the single permission funnel (27's DoneClaim contract)
    await gate(deps.permission, { type: 'fs.shell', target: { cmd: parsed.command } }, ctx)
    ctx.reportPhase('running')

    const result = await runShellProcess({
      callId: ctx.callId,
      command: parsed.command,
      cwd: cwdAbs,
      timeoutMs: computeTimeoutMs(parsed.timeoutMs, defaultTimeoutMs),
      maxOutputBytes,
      signal: ctx.signal,
      jailMode: deps.jailMode,
      onChunk: deps.onChunk,
      onWarning: (warning) => {
        log?.warn('shell jail degraded', { area: warning.area, message: warning.message })
        deps.onJailWarning?.(warning)
      },
    })
    return result
  }

  const def: ToolDef = {
    name: 'run_shell',
    description: `Run one non-interactive shell command inside the workspace (killed after the timeout; output streamed to the terminal panel, only the last ${Math.floor(SHELL_TAIL_BYTES / 1024)} KB tails are returned).`,
    parameters: strictParams(runShellSchema),
  }

  return [{ def, run }]
}

/** Registers run_shell (todo29 wiring surface; mirrors registerFileTools). */
export function registerShellTools(registry: ToolRegistry, deps: ShellToolDeps): void {
  for (const tool of createShellTools(deps)) {
    registry.register(tool)
  }
}

export { shellGrantSuggestion, firstProgram } from './tokenize'
export {
  runShellProcess,
  computeTimeoutMs,
  createStreamCollector,
  resolveShellInvocation,
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  SHELL_TAIL_BYTES,
} from './process'
export type {
  ShellChunk,
  ShellChunkSink,
  ShellResult,
  ShellStream,
  ShellToolDeps,
  ShellToolLogger,
} from './types'
