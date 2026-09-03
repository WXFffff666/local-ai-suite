/**
 * AgentModeToggle.tsx — todo29 segmented 聊天|代理 switch (Chat page header).
 * The mode persists per chat session in the zustand agent slice. Mid-run
 * switch-away is guarded (plan Must: 不做后台无人值守运行 — the agent UI must
 * stay visible while a run owns the session): switching back to 聊天 while a
 * run is busy asks for an explicit confirm and stops the run on acceptance.
 */
import { useCallback, type ReactElement } from 'react'
import { Bot, MessageSquare } from 'lucide-react'

import { useAgentStore } from './agentStore'
import { isBusy } from './timeline'

export type AgentModeToggleProps = {
  readonly sessionKey: string
  /** Confirm surface (injectable for jsdom tests); defaults to window.confirm. */
  readonly confirm?: (message: string) => boolean
}

export default function AgentModeToggle({ sessionKey, confirm }: AgentModeToggleProps): ReactElement {
  const mode = useAgentStore((s) => s.modes[sessionKey] ?? 'chat')
  const busy = useAgentStore((s) => isBusy(s.runs[sessionKey]?.phase ?? 'idle'))
  const setMode = useAgentStore((s) => s.setMode)
  const stopRun = useAgentStore((s) => s.stopRun)

  const switchTo = useCallback(
    (next: 'chat' | 'agent'): void => {
      if (next === mode) return
      if (mode === 'agent' && busy) {
        const ask = confirm ?? ((msg: string): boolean => window.confirm(msg))
        if (!ask('代理任务正在运行，切换回聊天会停止它。确认切换？')) return
        void stopRun(sessionKey)
      }
      setMode(sessionKey, next)
    },
    [mode, busy, confirm, sessionKey, setMode, stopRun],
  )

  return (
    <div className="agent-mode-toggle" role="group" aria-label="会话模式" data-testid="agent-mode-toggle">
      <button
        type="button"
        className={mode === 'chat' ? 'agent-mode-btn agent-mode-btn-active' : 'agent-mode-btn'}
        aria-pressed={mode === 'chat'}
        data-testid="mode-chat"
        onClick={() => switchTo('chat')}
      >
        <MessageSquare size={14} aria-hidden /> 聊天
      </button>
      <button
        type="button"
        className={mode === 'agent' ? 'agent-mode-btn agent-mode-btn-active' : 'agent-mode-btn'}
        aria-pressed={mode === 'agent'}
        data-testid="mode-agent"
        onClick={() => switchTo('agent')}
      >
        <Bot size={14} aria-hidden /> 代理
      </button>
    </div>
  )
}
