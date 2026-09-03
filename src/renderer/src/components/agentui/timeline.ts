/**
 * timeline.ts — pure state machine turning the todo23 AgentEvent stream into
 * renderable timeline cards (todo29). No React, no window.api: the store
 * filters events by the active agent sessionId and feeds them here, so the
 * whole render matrix (plan / tool phases / results / deltas / terminal
 * states / error codes) is unit-testable in plain node.
 */
import type {
  AgentErrorCode,
  AgentEvent,
  AgentPlanStep,
  JsonValue,
  ToolCallPhase,
} from '../../../../agent/runner/types'

export type AgentRunPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'completed' | 'aborted' | 'error'

export type PlanCard = { readonly kind: 'plan'; readonly iteration: number; readonly steps: readonly AgentPlanStep[] }
export type ToolCard = {
  readonly kind: 'tool'
  readonly callId: string
  readonly name: string
  readonly argsSummary: string
  /** 'done' is synthesised here when the tool_result lands. */
  readonly phase: ToolCallPhase | 'done'
  readonly ok: boolean | null
  readonly content: string
  readonly durationMs: number | null
}
export type AnswerCard = { readonly kind: 'answer'; readonly text: string; readonly final: boolean }
export type ErrorCard = { readonly kind: 'error'; readonly code: AgentErrorCode; readonly message: string }
export type TimelineCard = PlanCard | ToolCard | AnswerCard | ErrorCard

export type TimelineState = {
  readonly phase: AgentRunPhase
  readonly cards: readonly TimelineCard[]
  readonly iterations: number
}

export const idleTimeline: TimelineState = { phase: 'idle', cards: [], iterations: 0 }

/** Compact one-line summary of a tool call's arguments for the card header. */
export function argsSummary(args: JsonValue): string {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    for (const key of ['command', 'path', 'pattern', 'host'] as const) {
      const v = (args as Record<string, JsonValue>)[key]
      if (typeof v === 'string' && v !== '') return clip(v)
    }
  }
  return clip(JSON.stringify(args) ?? String(args))
}

function clip(s: string, max = 90): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** Machine error codes → user-facing Chinese copy (plan QA: UI 明示). */
export function friendlyError(code: AgentErrorCode, message: string): string {
  switch (code) {
    case 'context-length':
      return '上下文窗口不足：请新建会话或缩短任务目标后重试。'
    case 'max-iterations':
      return `达到迭代上限：${message}`
    case 'upstream-status':
      return `引擎返回错误：${message}`
    case 'upstream-transport':
      return `无法连接本地引擎（侧车可能未就绪）：${message}`
    case 'upstream-shape':
      return `引擎响应格式异常：${message}`
    default: {
      const unreachable: never = code
      throw new Error(`unknown agent error code: ${String(unreachable)}`)
    }
  }
}

/**
 * Fold one runner event into the timeline. Events are already filtered to
 * the active session by the caller; sessionId itself is bookkeeping for the
 * store, not rendered.
 */
export function reduceTimeline(state: TimelineState, ev: AgentEvent): TimelineState {
  switch (ev.type) {
    case 'plan':
      return {
        ...state,
        phase: 'running',
        cards: [...state.cards, { kind: 'plan', iteration: ev.iteration, steps: ev.steps }],
      }
    case 'tool_call': {
      const idx = state.cards.findIndex((c) => c.kind === 'tool' && c.callId === ev.callId)
      const card: ToolCard = {
        kind: 'tool',
        callId: ev.callId,
        name: ev.name,
        argsSummary: argsSummary(ev.args),
        phase: ev.phase,
        ok: null,
        content: '',
        durationMs: null,
      }
      if (idx === -1) return { ...state, phase: 'running', cards: [...state.cards, card] }
      const prev = state.cards[idx] as ToolCard
      const cards = [...state.cards]
      // never regress a settled card back to a live phase
      cards[idx] = prev.phase === 'done' ? prev : { ...prev, phase: ev.phase, name: ev.name, argsSummary: card.argsSummary }
      return { ...state, phase: 'running', cards }
    }
    case 'tool_result': {
      const idx = state.cards.findIndex((c) => c.kind === 'tool' && c.callId === ev.callId)
      const cards = [...state.cards]
      const done: ToolCard = {
        kind: 'tool',
        callId: ev.callId,
        name: ev.name,
        argsSummary: idx === -1 ? '' : (cards[idx] as ToolCard).argsSummary,
        phase: 'done',
        ok: ev.ok,
        content: ev.content,
        durationMs: ev.durationMs,
      }
      if (idx === -1) cards.push(done)
      else cards[idx] = done
      return { ...state, cards }
    }
    case 'message_delta':
      return { ...state, phase: 'running', cards: appendDelta(state.cards, ev.delta, false) }
    case 'finished':
      return {
        phase: ev.status === 'completed' ? 'completed' : 'aborted',
        cards: appendDelta(state.cards, ev.text, true),
        iterations: ev.iterations,
      }
    case 'error':
      return {
        ...state,
        phase: 'error',
        iterations: ev.iteration,
        cards: [...state.cards, { kind: 'error', code: ev.code, message: friendlyError(ev.code, ev.message) }],
      }
    default: {
      const unreachable: never = ev
      throw new Error(`unknown agent event: ${JSON.stringify(unreachable)}`)
    }
  }
}

/** Append a delta (or settle the final answer text) on the trailing answer card. */
function appendDelta(cards: readonly TimelineCard[], delta: string, final: boolean): readonly TimelineCard[] {
  const last = cards[cards.length - 1]
  if (last !== undefined && last.kind === 'answer' && !last.final) {
    const next = [...cards]
    next[next.length - 1] = { ...last, text: final && delta !== '' ? delta : last.text + delta, final }
    return next
  }
  if (delta === '') return cards
  return [...cards, { kind: 'answer', text: delta, final }]
}

/** True while a run owns the UI (Stop visible, mode-switch guarded). */
export function isBusy(phase: AgentRunPhase): boolean {
  return phase === 'starting' || phase === 'running' || phase === 'stopping'
}
