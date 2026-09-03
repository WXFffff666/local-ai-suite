/**
 * Agent runner wire + tool contracts (todo23) — single source of truth for
 * the tool-calling loop, the agent:* IPC channels, and the todo27/28 tool
 * implementations that plug into them.
 *
 * This file is deliberately SELF-CONTAINED (no imports): src/main/ipc/
 * whitelist.ts type-re-exports AgentEvent for the renderer, and this file is
 * compiled under both tsconfig.node and tsconfig.web. The runner layer must
 * stay Electron-free (100% unit-testable); nothing here may import electron,
 * node builtins, or zod.
 *
 * Security posture (Appendix R3-C, LLM01/05/06): every piece of LLM output —
 * tool names, arguments, message text — is DATA, never instructions. The
 * executor layer (todo27/28) gates each call through PermissionEngine before
 * touching the outside world; the runner itself stays policy-agnostic.
 */

// --- JSON documents -----------------------------------------------------------

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

/** A JSON Schema document (zod v4 `z.toJSONSchema()` output lands here). */
export type JsonSchema = JsonObject

// --- OpenAI-compatible wire shapes (the only protocol the runner speaks) ------

/** One entry of the request `tools` array (strict-function mode). */
export type OpenAiToolWire = {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: JsonSchema
  }
}

/** A tool call the assistant asked for, as sent back in an assistant message. */
export type AgentToolCallWire = {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

/** Conversation message as stored/sent by the runner (OpenAI chat roles). */
export type AgentMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string; readonly tool_calls?: readonly AgentToolCallWire[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string }

// --- Tool contract (todo27/28 implement; todo23 owns the interface) ------------

/**
 * A tool as advertised to the model. `parameters` MUST be an OpenAI-strict
 * JSON Schema object: type 'object', `additionalProperties: false`, and EVERY
 * property listed in `required` (zod v4: build it with `z.strictObject({...})`
 * using only required fields, then `z.toJSONSchema(schema)`). The registry
 * rejects non-strict schemas at registration time.
 */
export type ToolDef = {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
}

/**
 * Lifecycle of one tool execution, as visible to the UI (todo29 renders it).
 * The runner emits `tool_call` with phase 'awaiting-permission' before calling
 * execute; the executor (todo27/28 — it owns the PermissionEngine call) must
 * call `ctx.reportPhase('running')` exactly when the permission decision came
 * back allow and actual work starts. 'denied' is NOT a phase — a denial is an
 * execute() rejection and surfaces as a failed tool_result.
 */
export type ToolCallPhase = 'awaiting-permission' | 'running'

export type ToolExecutionContext = {
  readonly callId: string
  /** Aborted when the session is cancelled — long-running tools must obey it. */
  readonly signal: AbortSignal
  /** Drives the runner's tool_call phase events. See ToolCallPhase. */
  readonly reportPhase: (phase: ToolCallPhase) => void
}

/**
 * The seam between the loop and the tool world. Implementations: todo27/28's
 * ToolRegistry-backed host, which pre-gates every execute() through
 * PermissionEngine.evaluate() BEFORE any effect. The runner never gates and
 * never inspects results beyond `JSON.stringify`-ability.
 */
export type ToolExecutor = {
  list(): readonly ToolDef[]
  /** Rejection (incl. permission-denied) becomes a tool_result(ok:false). */
  execute(name: string, argsJson: string, ctx: ToolExecutionContext): Promise<unknown>
}

// --- Events ('agent:event' IPC payload; one tagged union, exhaustively matched) --

export type AgentPlanStep = { readonly callId: string; readonly name: string; readonly argsSummary: string }
/** Emitted once per tool round, before any execute(): the round's step list. */
export type AgentPlanEvent = { readonly type: 'plan'; readonly sessionId: string; readonly iteration: number; readonly steps: readonly AgentPlanStep[] }
export type AgentToolCallEvent = { readonly type: 'tool_call'; readonly sessionId: string; readonly callId: string; readonly name: string; readonly args: JsonValue; readonly phase: ToolCallPhase }
export type AgentToolResultEvent = { readonly type: 'tool_result'; readonly sessionId: string; readonly callId: string; readonly name: string; readonly ok: boolean; readonly content: string; readonly durationMs: number }
export type AgentMessageDeltaEvent = { readonly type: 'message_delta'; readonly sessionId: string; readonly delta: string }
export type AgentFinishedEvent = { readonly type: 'finished'; readonly sessionId: string; readonly status: 'completed' | 'aborted'; readonly iterations: number; readonly text: string }
export type AgentErrorCode = 'max-iterations' | 'context-length' | 'upstream-status' | 'upstream-transport' | 'upstream-shape'
export type AgentErrorEvent = { readonly type: 'error'; readonly sessionId: string; readonly code: AgentErrorCode; readonly message: string; readonly iteration: number }

export type AgentEvent =
  | AgentPlanEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentMessageDeltaEvent
  | AgentFinishedEvent
  | AgentErrorEvent

// --- Session status (agent:status reply; wire shape, kept here so both
//     tsconfig projects can see it without reaching into sessions.ts) ---------

export type AgentSessionState = 'running' | 'completed' | 'aborted' | 'error'

export type AgentSessionStatus = {
  readonly sessionId: string
  readonly state: AgentSessionState
  readonly iterations: number
  readonly updatedAt: number
  readonly error?: string
}

// --- Loop input / result --------------------------------------------------------

/** Hard ceiling on completion requests per session (LLM10 无界消耗, Appendix C). */
export const MAX_AGENT_ITERATIONS = 25

/** The slice of a fetch Response the loop consumes (global Response satisfies it). */
export type AgentResponse = {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
  readonly body: ReadableStream<Uint8Array> | null
}

/**
 * Structural fetch seam — deliberately narrower than typeof globalThis.fetch so
 * scripted tests (and sessions.ts passing the global through) share one type.
 * The loop only ever issues the one POST shape below.
 */
export type AgentFetch = (
  url: string,
  init: { readonly method: 'POST'; readonly headers: Record<string, string>; readonly body: string; readonly signal: AbortSignal }
) => Promise<AgentResponse>

export type AgentLoopInput = {
  readonly sessionId: string
  /** Local engine origin, e.g. http://127.0.0.1:11434 — validated by the caller; the runner appends /v1/chat/completions. */
  readonly baseUrl: string
  readonly model: string
  readonly messages: readonly AgentMessage[]
  readonly tools: readonly ToolDef[]
  readonly executor: ToolExecutor
  readonly signal: AbortSignal
  readonly onEvent: (event: AgentEvent) => void
  readonly maxIterations?: number
  readonly fetchImpl?: AgentFetch
}

export type AgentRunResult = {
  readonly sessionId: string
  readonly status: 'completed' | 'aborted'
  readonly iterations: number
  readonly text: string
}

// --- Errors ---------------------------------------------------------------------

/** Thrown (and preceded by an error event, code 'max-iterations') at the cap. */
export class AgentLimitError extends Error {
  constructor(readonly sessionId: string, readonly iterations: number) {
    super(`agent session ${sessionId} exceeded ${iterations} iterations`)
    this.name = 'AgentLimitError'
  }
}

export type AgentLoopErrorInfo = {
  readonly sessionId: string
  readonly code: AgentErrorCode
  readonly iteration: number
  readonly status?: number
}

/** Every non-limit failure mode of one loop iteration; preceded by an error event. */
export class AgentLoopError extends Error {
  constructor(message: string, readonly info: AgentLoopErrorInfo) {
    super(message)
    this.name = 'AgentLoopError'
  }
}
