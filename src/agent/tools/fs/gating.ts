/**
 * gating.ts — the two cross-cutting safety primitives for fs tools (todo27):
 *
 * 1. fencePath: workspace containment. Lexical casefolded `path.relative`
 *    containment FIRST (rejects `..` and absolute escapes before any fs
 *    call — MCP servers path-utils / gallery.ts:143 / loraFs.ts pattern),
 *    then a realpath re-check of the deepest existing ancestor (symlink /
 *    junction escape). TOCTOU caveat: between the realpath check and the
 *    tool's own fs call an attacker who can already write the workspace
 *    could swap a directory for a symlink; closing that window needs
 *    O_NOFOLLOW fd-relative opens, which Node does not expose portably —
 *    out of scope by plan (the permission gate, not the fence, is the
 *    security boundary; the fence bounds blast radius).
 * 2. gate: one decision funnel — assess → (ask → user verdict) → record →
 *    allow-or-throw, so every tool audits identically. reportPhase('running')
 *    is the CALLER's job after gate resolves (types.ts contract).
 *
 * PermissionPort is duck-typed against the real PermissionEngine (todo24)
 * with `import type` only; lane 25's IPC bridge supplies `ask` (dialog →
 * user verdict, rejecting when the session is cancelled / aborted).
 */
import { realpathSync } from 'fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path'

import type {
  Assessment,
  PermissionAction,
  PermissionDecision,
} from '../../policy/types'
import type { ToolExecutionContext } from '../../runner/types'

// --- PermissionPort (contract shared with lanes 25/28/29) --------------------

/**
 * Structural view of PermissionEngine plus the one method the engine does
 * NOT have: `ask`, implemented by lane 25's bridge (render a dialog, await
 * the verdict). `ask` must obey `signal` (reject on abort) and resolve
 * 'allow' | 'deny'; anything else is treated as denial by gate().
 */
export type PermissionPort = {
  evaluate(action: PermissionAction): PermissionDecision
  assess(action: PermissionAction): Assessment
  record(action: PermissionAction, assessment: Assessment, detail?: Record<string, unknown>): void
  ask(action: PermissionAction, signal: AbortSignal): Promise<PermissionDecision>
}

export class PermissionDeniedError extends Error {
  constructor(action: PermissionAction, readonly reason: 'policy' | 'user' | 'aborted' | 'dialog-error') {
    super(`permission ${action.type} '${targetText(action.target)}' denied (${reason})`)
    this.name = 'PermissionDeniedError'
  }
}

function targetText(target: PermissionAction['target']): string {
  if (typeof target === 'string') return target
  return Object.values(target).filter((v): v is string => typeof v === 'string').join(' ')
}

/**
 * The single gating funnel. Records exactly one audit row per call
 * (policy allow/deny, or the user/aborted verdict after ask) and throws
 * PermissionDeniedError for every non-allow outcome.
 */
export async function gate(
  permission: PermissionPort,
  action: PermissionAction,
  ctx: Pick<ToolExecutionContext, 'callId' | 'signal'>,
): Promise<Assessment> {
  const assessment = permission.assess(action)
  const callId = ctx.callId
  if (assessment.decision === 'allow') {
    permission.record(action, assessment, { via: 'policy', callId })
    return assessment
  }
  if (assessment.decision === 'deny') {
    permission.record(action, assessment, { via: 'policy', callId })
    throw new PermissionDeniedError(action, 'policy')
  }
  // decision === 'ask' — suspend on the user verdict (no timeout here:
  // cancellation is the session AbortSignal, todo29's Stop button).
  let verdict: PermissionDecision
  try {
    verdict = await permission.ask(action, ctx.signal)
  } catch {
    const reason = ctx.signal.aborted ? 'aborted' : 'dialog-error'
    permission.record(action, { ...assessment, decision: 'deny' }, { via: reason, callId })
    throw new PermissionDeniedError(action, reason)
  }
  if (verdict !== 'allow' || ctx.signal.aborted) {
    permission.record(action, { ...assessment, decision: 'deny' }, { via: 'user', callId })
    throw new PermissionDeniedError(action, ctx.signal.aborted ? 'aborted' : 'user')
  }
  const final: Assessment = { ...assessment, decision: 'allow' }
  permission.record(action, final, { via: 'user', callId })
  return final
}

// --- path fence ---------------------------------------------------------------

export type FsPathErrorCode = 'path-invalid' | 'path-outside-workspace'

export class FsPathError extends Error {
  constructor(readonly code: FsPathErrorCode) {
    super(`path rejected: ${code}`)
    this.name = 'FsPathError'
  }
}

function isInside(root: string, candidate: string): boolean {
  // Casefolded containment (Windows drive/dir casing + `\\?\` traps are
  // neutralised by resolve()). On POSIX this is generous about case, but a
  // wrong-case path simply fails the later fs access — never a leak.
  const rel = relative(root.toLowerCase(), candidate.toLowerCase())
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Realpath of the deepest existing ancestor + the missing remainder joined back. */
function realpathExisting(abs: string): string {
  const missing: string[] = []
  let probe = abs
  for (;;) {
    try {
      return resolve(realpathSync(probe), ...missing)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e
      const parent = dirname(probe)
      if (parent === probe) throw new FsPathError('path-outside-workspace')
      missing.unshift(basename(probe))
      probe = parent
    }
  }
}

/**
 * Resolve `target` (relative to `workspaceRoot`, or absolute-inside) to an
 * absolute path proven — as far as the lexical + realpath check can — to stay
 * inside the workspace's real path. Throws FsPathError before any other fs
 * operation on escape. The returned path has the existing prefix realpath'd,
 * so writing through it cannot traverse a workspace-internal symlink out.
 */
export function fencePath(workspaceRoot: string, target: string): string {
  if (typeof target !== 'string' || target === '' || target.includes('\0')) {
    throw new FsPathError('path-invalid')
  }
  const rootAbs = resolve(workspaceRoot)
  const abs = resolve(rootAbs, target)
  if (!isInside(rootAbs, abs)) throw new FsPathError('path-outside-workspace')
  const real = realpathExisting(abs)
  if (!isInside(realpathSync(rootAbs), real)) throw new FsPathError('path-outside-workspace')
  return real
}

/** Workspace-relative slash path for permission targets (post-fence). */
export function toRelativeSlash(workspaceRoot: string, fencedAbs: string): string {
  return relative(realpathSync(resolve(workspaceRoot)), fencedAbs).split(sep).join('/')
}
