// @vitest-environment jsdom
/**
 * timeline.test.ts — the todo29 render matrix: one case per AgentEvent
 * variant (all six) plus the phase-badge updates, result folding, delta
 * accumulation, terminal states and every error code's friendly copy.
 * jsdom only because the sibling agentui tests share the environment; the
 * reducer itself holds no platform surface.
 */
import { describe, expect, it } from 'vitest'

import type { AgentEvent, JsonValue } from '../../../../agent/runner/types'
import { argsSummary, friendlyError, idleTimeline, isBusy, reduceTimeline, type TimelineState } from './timeline'

const ev = (over: Record<string, unknown>): AgentEvent => over as unknown as AgentEvent

function fold(...events: AgentEvent[]): TimelineState {
  return events.reduce(reduceTimeline, idleTimeline)
}

describe('reduceTimeline matrix (one case per event type)', () => {
  it('plan → running with a steps card', () => {
    const s = fold(
      ev({ type: 'plan', sessionId: 'a', iteration: 2, steps: [{ callId: 'c1', name: 'read_file', argsSummary: '{"path":"a.ts"}' }] }),
    )
    expect(s.phase).toBe('running')
    expect(s.cards).toEqual([{ kind: 'plan', iteration: 2, steps: [{ callId: 'c1', name: 'read_file', argsSummary: '{"path":"a.ts"}' }] }])
  })

  it('tool_call creates the awaiting-permission card with a compact args summary', () => {
    const s = fold(
      ev({
        type: 'tool_call',
        sessionId: 'a',
        callId: 'c1',
        name: 'write_file',
        args: { path: 'src/a.ts', content: 'x'.repeat(200) } as JsonValue,
        phase: 'awaiting-permission',
      }),
    )
    expect(s.cards).toHaveLength(1)
    const card = s.cards[0]
    expect(card?.kind === 'tool' && card.phase === 'awaiting-permission' && card.name === 'write_file' && card.argsSummary === 'src/a.ts').toBe(
      true,
    )
  })

  it('tool_call(running) upgrades the same card in place', () => {
    const s = fold(
      ev({ type: 'tool_call', sessionId: 'a', callId: 'c1', name: 'run_shell', args: { command: 'npm test' } as JsonValue, phase: 'awaiting-permission' }),
      ev({ type: 'tool_call', sessionId: 'a', callId: 'c1', name: 'run_shell', args: { command: 'npm test' } as JsonValue, phase: 'running' }),
    )
    expect(s.cards).toHaveLength(1)
    expect(s.cards[0]?.kind === 'tool' && s.cards[0].phase).toBe('running')
  })

  it('tool_result folds ok/content/durationMs into the card and marks done', () => {
    const s = fold(
      ev({ type: 'tool_call', sessionId: 'a', callId: 'c1', name: 'read_file', args: { path: 'n.txt' } as JsonValue, phase: 'running' }),
      ev({ type: 'tool_result', sessionId: 'a', callId: 'c1', name: 'read_file', ok: true, content: 'hello', durationMs: 12 }),
    )
    const card = s.cards[0]
    expect(card?.kind === 'tool' && card.phase === 'done' && card.ok && card.content === 'hello' && card.durationMs === 12).toBe(true)
    // a late phase regression cannot un-settle the card
    const s2 = reduceTimeline(
      s,
      ev({ type: 'tool_call', sessionId: 'a', callId: 'c1', name: 'read_file', args: {} as JsonValue, phase: 'awaiting-permission' }),
    )
    expect(s2.cards[0]?.kind === 'tool' && s2.cards[0].phase).toBe('done')
  })

  it('tool_result without a card (args-repair path) still renders a failed card', () => {
    const s = fold(
      ev({ type: 'tool_result', sessionId: 'a', callId: 'cx', name: 'read_file', ok: false, content: 'TOOL_ARGS_ERROR: x', durationMs: 0 }),
    )
    expect(s.cards[0]?.kind === 'tool' && s.cards[0].ok).toBe(false)
  })

  it('message_delta accumulates one live answer card; a later tool closes it', () => {
    const s = fold(ev({ type: 'message_delta', sessionId: 'a', delta: 'He' }), ev({ type: 'message_delta', sessionId: 'a', delta: 'llo' }))
    expect(s.cards).toEqual([{ kind: 'answer', text: 'Hello', final: false }])
    const s2 = fold(
      ev({ type: 'message_delta', sessionId: 'a', delta: 'mid' }),
      ev({ type: 'tool_call', sessionId: 'a', callId: 'c1', name: 'glob_list', args: { pattern: '**' } as JsonValue, phase: 'awaiting-permission' }),
      ev({ type: 'message_delta', sessionId: 'a', delta: 'after' }),
    )
    expect(s2.cards.filter((c) => c.kind === 'answer').map((c) => (c.kind === 'answer' ? c.text : ''))).toEqual(['mid', 'after'])
  })

  it('finished(completed) marks the answer final and carries iterations', () => {
    const s = fold(
      ev({ type: 'message_delta', sessionId: 'a', delta: 'partial ' }),
      ev({ type: 'finished', sessionId: 'a', status: 'completed', iterations: 3, text: 'partial full answer' }),
    )
    expect(s.phase).toBe('completed')
    expect(s.iterations).toBe(3)
    expect(s.cards[0]).toEqual({ kind: 'answer', text: 'partial full answer', final: true })
  })

  it('finished(aborted) sets the aborted phase (Stop button visual)', () => {
    const s = fold(ev({ type: 'finished', sessionId: 'a', status: 'aborted', iterations: 1, text: '' }))
    expect(s.phase).toBe('aborted')
    expect(s.cards).toHaveLength(0)
  })

  it('error sets the error phase and appends the friendly card', () => {
    const s = fold(ev({ type: 'error', sessionId: 'a', code: 'context-length', message: 'Context length exceeded', iteration: 4 }))
    expect(s.phase).toBe('error')
    expect(s.iterations).toBe(4)
    expect(s.cards[0]).toEqual({ kind: 'error', code: 'context-length', message: '上下文窗口不足：请新建会话或缩短任务目标后重试。' })
  })
})

describe('error-code copy', () => {
  it('every AgentErrorCode maps to a non-empty user message', () => {
    const codes = ['max-iterations', 'context-length', 'upstream-status', 'upstream-transport', 'upstream-shape'] as const
    for (const code of codes) {
      expect(friendlyError(code, 'detail').length).toBeGreaterThan(0)
    }
    expect(friendlyError('context-length', 'ignored')).toContain('新建会话')
    expect(friendlyError('upstream-transport', 'boom')).toContain('本地引擎')
  })
})

describe('helpers', () => {
  it('argsSummary prefers semantic fields, falls back to clipped JSON', () => {
    expect(argsSummary({ command: 'git status' })).toBe('git status')
    expect(argsSummary({ path: 'a/b.ts' })).toBe('a/b.ts')
    expect(argsSummary({ foo: 'bar' })).toBe('{"foo":"bar"}')
    expect(argsSummary({ path: `x/${'y'.repeat(200)}` }).length).toBeLessThanOrEqual(90)
  })
  it('isBusy covers starting/running/stopping only', () => {
    expect(isBusy('starting')).toBe(true)
    expect(isBusy('running')).toBe(true)
    expect(isBusy('stopping')).toBe(true)
    expect(isBusy('idle')).toBe(false)
    expect(isBusy('completed')).toBe(false)
    expect(isBusy('aborted')).toBe(false)
    expect(isBusy('error')).toBe(false)
  })
})
