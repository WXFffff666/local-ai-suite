/**
 * AgentTimeline.tsx — todo29 message-stream surface: plan step lists,
 * tool-call cards (name + args summary + 待授权/执行中 phase badge), folded
 * tool results (ok/fail + durationMs + expandable content), the live answer
 * text and the terminal finished/error states (context-length gets its own
 * friendly copy). Stop (右上代理停止) invokes agent:cancel and rides the
 * finished(aborted) event into the aborted visual. The xterm terminal lives
 * in a collapsible drawer below — TerminalPanel owns its own per-callId
 * buffers ('agent:term') and auto-collapse (tool_result contract).
 */
import { useState, type ReactElement } from 'react'
import { CircleCheck, CircleDashed, CircleX, ListChecks, Loader, Square, SquareTerminal, TriangleAlert } from 'lucide-react'

import { useAgentStore } from './agentStore'
import type { AnswerCard, ErrorCard, PlanCard, TimelineCard, ToolCard } from './timeline'
import TerminalPanel from '../terminal/TerminalPanel'
import './agentui.css'

const PHASE_LABEL = { 'awaiting-permission': '待授权', running: '执行中' } as const

function PlanRow({ card }: { card: PlanCard }): ReactElement {
  return (
    <div className="agent-plan" data-testid="agent-plan">
      <div className="agent-plan-title">
        <ListChecks size={14} aria-hidden /> 第 {card.iteration} 轮计划
      </div>
      <ol className="agent-plan-steps">
        {card.steps.map((step) => (
          <li key={step.callId}>
            {step.name} <span className="agent-plan-args">{step.argsSummary}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ToolRow({ card }: { card: ToolCard }): ReactElement {
  const failed = card.ok === false
  return (
    <div className={failed ? 'agent-tool agent-tool-failed' : 'agent-tool'} data-testid="agent-tool" data-call-id={card.callId}>
      <div className="agent-tool-head">
        {card.phase === 'awaiting-permission' ? (
          <CircleDashed size={14} aria-hidden className="agent-phase-icon" />
        ) : card.phase === 'running' ? (
          <Loader size={14} aria-hidden className="agent-phase-icon agent-spin" />
        ) : failed ? (
          <CircleX size={14} aria-hidden className="agent-phase-icon agent-icon-fail" />
        ) : (
          <CircleCheck size={14} aria-hidden className="agent-phase-icon agent-icon-ok" />
        )}
        <span className="agent-tool-name">{card.name}</span>
        <span className="agent-tool-args" title={card.argsSummary}>
          {card.argsSummary}
        </span>
        {card.phase !== 'done' ? (
          <span className={`agent-badge agent-badge-${card.phase}`} data-testid="agent-phase-badge">
            {PHASE_LABEL[card.phase]}
          </span>
        ) : (
          <span className="agent-duration">{card.durationMs}ms</span>
        )}
      </div>
      {card.phase === 'done' && card.content !== '' ? (
        <details className="agent-tool-result">
          <summary>{failed ? '错误详情' : '结果详情'}</summary>
          <pre>{card.content}</pre>
        </details>
      ) : null}
    </div>
  )
}

function AnswerRow({ card }: { card: AnswerCard }): ReactElement {
  return (
    <div className={card.final ? 'agent-answer' : 'agent-answer agent-answer-live'} data-testid="agent-answer">
      <pre className="agent-answer-text">{card.text}</pre>
    </div>
  )
}

function ErrorRow({ card }: { card: ErrorCard }): ReactElement {
  return (
    <div className="agent-error" data-testid="agent-error" role="alert">
      <TriangleAlert size={14} aria-hidden />
      <span>{card.message}</span>
      <code className="agent-error-code">{card.code}</code>
    </div>
  )
}

function Card({ card }: { card: TimelineCard }): ReactElement {
  if (card.kind === 'plan') return <PlanRow card={card} />
  if (card.kind === 'tool') return <ToolRow card={card} />
  if (card.kind === 'answer') return <AnswerRow card={card} />
  return <ErrorRow card={card} />
}

export type AgentTimelineProps = {
  readonly sessionKey: string
}

export default function AgentTimeline({ sessionKey }: AgentTimelineProps): ReactElement {
  const run = useAgentStore((s) => s.runs[sessionKey])
  const stopRun = useAgentStore((s) => s.stopRun)
  const [termOpen, setTermOpen] = useState(true)
  const phase = run?.phase ?? 'idle'
  const stoppable = phase === 'starting' || phase === 'running' || phase === 'stopping'

  return (
    <section className="agent-timeline" aria-label="代理时间线" data-testid="agent-timeline" data-phase={phase}>
      <header className="agent-timeline-bar">
        <span className="agent-timeline-status" data-testid="agent-run-phase">
          {phase === 'idle' && '代理就绪 — 在下方输入任务目标，回车启动'}
          {phase === 'starting' && '正在启动代理…'}
          {phase === 'running' && '代理运行中'}
          {phase === 'stopping' && '正在停止…'}
          {phase === 'completed' && `已完成（${run?.iterations ?? 0} 轮）`}
          {phase === 'aborted' && '已停止'}
          {phase === 'error' && '运行出错'}
        </span>
        {stoppable ? (
          <button type="button" className="agent-stop" data-testid="agent-stop" onClick={() => void stopRun(sessionKey)}>
            <Square size={12} aria-hidden /> 停止
          </button>
        ) : null}
      </header>
      <div className="agent-timeline-body">
        {(run?.cards ?? []).map((card, i) => (
          <Card key={`${card.kind}:${i}:${card.kind === 'tool' ? card.callId : ''}`} card={card} />
        ))}
        {phase === 'aborted' ? (
          <div className="agent-aborted-note" data-testid="agent-aborted">
            <CircleX size={14} aria-hidden /> 任务已取消，挂起的审批已按拒绝处理。
          </div>
        ) : null}
      </div>
      <div className="agent-term-drawer" data-testid="agent-term-drawer">
        <button type="button" className="agent-term-toggle" aria-expanded={termOpen} onClick={() => setTermOpen((v) => !v)}>
          <SquareTerminal size={14} aria-hidden /> 终端输出
        </button>
        {termOpen ? <TerminalPanel /> : null}
      </div>
    </section>
  )
}
