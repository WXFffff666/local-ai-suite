/**
 * TerminalPanel.tsx — todo28 read-only xterm panel. One @xterm/xterm
 * instance renders the ACTIVE callId's scrollback (tab per run_shell call,
 * FitAddon on window resize); buffer state lives in useTermBuffer. The
 * terminal never accepts input (v1 is output-only by plan — no node-pty,
 * no interactive stdin). Collapses automatically when the runner's
 * tool_result event marks the run done.
 *
 * Theme syncs from the app CSS custom properties (--las-bg/--las-fg, see
 * App.css light/dark blocks) with a dark default for the terminal surface.
 * Mounting is todo29's job (App-level, beside PermissionDialogHost); this
 * component renders nothing outside Electron.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getTermApi, useTermBuffer } from './useTermBuffer'
import './terminal.css'

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

export default function TerminalPanel(): ReactElement | null {
  const api = useMemo(getTermApi, [])
  const { entries, activeId, select } = useTermBuffer()
  const [expanded, setExpanded] = useState(true)
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  /** exactly what the terminal currently shows (drives the diff-vs-rewrite decision) */
  const writtenRef = useRef('')
  const active = entries.find((e) => e.callId === activeId) ?? null
  const visible = api !== null && entries.length > 0

  // xterm instance lifecycle: one per visible-panel mount
  useEffect(() => {
    if (!visible) return undefined
    const host = hostRef.current
    if (host === null) return undefined
    const term = new Terminal({
      // read-only v1 (plan: no interactive pty): xterm 6 dropped `readOnly`,
      // disableStdin is the input kill-switch
      disableStdin: true,
      convertEol: true,
      scrollback: 2000,
      fontSize: 12,
      fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
      theme: {
        background: cssVar('--las-bg', '#0d1117'),
        foreground: cssVar('--las-fg', '#e6edf3'),
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    const onResize = (): void => fit.fit()
    window.addEventListener('resize', onResize)
    termRef.current = term
    writtenRef.current = ''
    return () => {
      window.removeEventListener('resize', onResize)
      term.dispose()
      termRef.current = null
      writtenRef.current = ''
    }
  }, [visible])

  // buffer -> terminal: append the delta when it extends what's shown,
  // full reset+rewrite when the source buffer switched (tab) or was trimmed
  const text = active?.text ?? ''
  useEffect(() => {
    const term = termRef.current
    if (term === null) return
    if (text === writtenRef.current) return
    if (text.startsWith(writtenRef.current)) {
      term.write(text.slice(writtenRef.current.length))
    } else {
      term.reset()
      term.write(text)
    }
    writtenRef.current = text
  }, [text])

  // collapse on completion of the active run (plan: collapse on tool_result)
  const activeDone = active?.done ?? false
  useEffect(() => {
    if (activeDone) setExpanded(false)
  }, [activeDone])

  if (!visible) return null

  return (
    <section className="term-panel" data-testid="terminal-panel" aria-label="Shell 输出">
      <header className="term-tabs" role="tablist">
        {entries.map((entry) => (
          <button
            key={entry.callId}
            type="button"
            role="tab"
            className={entry.callId === activeId ? 'term-tab term-tab-active' : 'term-tab'}
            data-testid="term-tab"
            data-done={String(entry.done)}
            aria-selected={entry.callId === activeId}
            onClick={() => {
              if (entry.callId === activeId) {
                setExpanded((v) => !v)
              } else {
                select(entry.callId)
                setExpanded(true)
              }
            }}
          >
            <span className={entry.done ? 'term-dot term-dot-done' : 'term-dot term-dot-run'} aria-hidden />
            {entry.callId}
          </button>
        ))}
      </header>
      <div className="term-view" data-testid="term-view" ref={hostRef} hidden={!expanded} />
    </section>
  )
}
