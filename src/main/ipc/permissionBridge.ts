/**
 * Permission approval bridge (todo25) — the main-process half of the
 * human-in-the-loop dialog. Pure module: NO Electron import, fully unit
 * testable (same discipline as src/agent/runner/** and src/agent/policy/**).
 *
 * Flow: the tool executor (todo27/28, gated by PermissionEngine.assess() ===
 * 'ask') calls requestDecision(); the bridge emits a 'permission:request'
 * event (payload contract lives in whitelist.ts) and returns a promise the
 * agent loop awaits. The renderer dialog answers via the 'permission:respond'
 * IPC channel; handlers.ts routes it through respond().
 *
 * Safety posture (Appendix C LLM06, OWASP human-in-the-loop; plan "无跳过
 * 确认总开关"):
 *   - a request that is never answered auto-denies after PERMISSION_DEFAULT_
 *     TIMEOUT_MS — the agent can NEVER hang on a lost dialog;
 *   - an aborted session denies (the executor's AbortSignal is honored);
 *   - respond() only accepts ids this bridge issued, exactly once each, and
 *     only the four off-enum-free choices;
 *   - the bridge persists nothing itself: 'session'/'always' decisions are
 *     surfaced through the onGrant callback (engine-agnostic by design —
 *     todo29 wires it to PermissionEngine.addRule; timeouts/denials/once
 *     never reach it).
 */
import { randomUUID } from 'node:crypto'
import type { Assessment, PermissionAction } from '../../agent/policy/types'
import {
  PERMISSION_GRANT_CHOICES,
  type PermissionActionWire,
  type PermissionAssessmentWire,
  type PermissionGrantChoice,
  type PermissionPreview,
  type PermissionRequestEvent
} from './whitelist'

/** Await budget before a silent dialog auto-denies (visual countdown is the renderer's). */
export const PERMISSION_DEFAULT_TIMEOUT_MS = 120_000

/** A persistent grant the caller (todo29) maps onto PermissionEngine.addRule. */
export type PermissionGrant = {
  action: PermissionAction
  assessment: Assessment
  choice: 'session' | 'always'
}

export type PermissionBridgeOptions = {
  /** Deliver the prompt to the renderer (bound to the focused window's send in wiring). */
  send: (event: PermissionRequestEvent) => void
  /** Persist a session/always grant. Absent ⇒ grants are acknowledged but not stored. */
  onGrant?: (grant: PermissionGrant) => void
  /** Override the auto-deny budget (tests / stricter deployments). */
  timeoutMs?: number
  /** Injectable id factory (tests); defaults to crypto.randomUUID. */
  newRequestId?: () => string
  /** Injectable clock (tests); defaults to Date.now. */
  now?: () => number
}

export type PermissionRequest = {
  action: PermissionAction
  assessment: Assessment
  /** What the dialog should show for this exact call (diff / command / net). */
  preview: PermissionPreview
  /** Session abort — a pending request settles 'deny' the instant it fires. */
  signal?: AbortSignal
}

export type PermissionBridge = {
  /** Emit the prompt and await the user's decision. Resolves EXACTLY once. */
  requestDecision(request: PermissionRequest): Promise<PermissionGrantChoice>
  /** Apply a renderer response. True iff the id was pending and the choice legal. */
  respond(requestId: string, choice: PermissionGrantChoice): boolean
}

type PendingEntry = {
  resolve: (choice: PermissionGrantChoice) => void
  timer: ReturnType<typeof setTimeout>
  action: PermissionAction
  assessment: Assessment
  /** Detach the abort listener (no leak across settled requests). */
  dispose: () => void
}

const CHOICE_SET: ReadonlySet<string> = new Set<string>(PERMISSION_GRANT_CHOICES)

export function createPermissionBridge(options: PermissionBridgeOptions): PermissionBridge {
  const timeoutMs = options.timeoutMs ?? PERMISSION_DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  const nextId = options.newRequestId ?? randomUUID
  const pending = new Map<string, PendingEntry>()

  /** Settle (and forget) a request. Internal paths (timeout/abort) pass a proven choice. */
  function settle(requestId: string, choice: PermissionGrantChoice): boolean {
    const entry = pending.get(requestId)
    if (!entry) return false
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.dispose()
    if (choice === 'session' || choice === 'always') {
      options.onGrant?.({ action: entry.action, assessment: entry.assessment, choice })
    }
    entry.resolve(choice)
    return true
  }

  function requestDecision(request: PermissionRequest): Promise<PermissionGrantChoice> {
    const { action, assessment, preview, signal } = request
    // Already cancelled: never prompt a dead session.
    if (signal?.aborted) return Promise.resolve('deny')
    const requestId = nextId()
    return new Promise<PermissionGrantChoice>((resolve) => {
      const timer = setTimeout(() => settle(requestId, 'deny'), timeoutMs)
      let onAbort: (() => void) | null = null
      if (signal) {
        onAbort = () => settle(requestId, 'deny')
        signal.addEventListener('abort', onAbort, { once: true })
      }
      pending.set(requestId, {
        resolve,
        timer,
        action,
        assessment,
        dispose: () => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        }
      })
      const event: PermissionRequestEvent = {
        requestId,
        action,
        assessment,
        preview,
        timeoutMs,
        requestedAt: now()
      }
      options.send(event)
    })
  }

  function respond(requestId: string, choice: PermissionGrantChoice): boolean {
    if (!CHOICE_SET.has(choice)) return false
    return settle(requestId, choice)
  }

  return { requestDecision, respond }
}

// Compile-time wire alignment proofs (mirror of the CHAT_CONTENT_WIRE_ALIGNED
// pattern): the engine's real types must stay assignable to the self-contained
// whitelist wire shapes, or todo29's wiring breaks HERE, not in production.
export const PERMISSION_ACTION_WIRE_ALIGNED: PermissionAction extends PermissionActionWire ? true : never = true
export const PERMISSION_ASSESSMENT_WIRE_ALIGNED: Assessment extends PermissionAssessmentWire ? true : never = true
