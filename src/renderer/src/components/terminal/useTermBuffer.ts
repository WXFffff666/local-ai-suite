/**
 * useTermBuffer.ts — todo28 renderer scrollback state for the xterm panel.
 * Pure React state machine (no xterm import here — that lives in
 * TerminalPanel.tsx so this hook stays cheap to unit-test in jsdom):
 * subscribes the whitelisted 'agent:term' event ({id, chunk}, payload owned
 * by src/main/ipc/whitelist.ts) plus 'agent:event' tool_result to mark each
 * callId's buffer done (the panel collapses on done). Each buffer is capped
 * at ~200 KB and keeps the TAIL (oldest chunks drop first).
 *
 * Runs OUTSIDE Electron too: no window.api => available:false, everything
 * renders nothing (same guarded-structural-slice pattern as todo25's
 * PermissionDialogHost).
 */
import { useCallback, useEffect, useState } from 'react'

import type { AgentTermEvent } from '../../../../main/ipc/whitelist'
import type { AgentEvent } from '../../../../agent/runner/types'

/** per-callId scrollback cap (plan: ≤200 KB/buffer) */
export const TERM_BUFFER_MAX_BYTES = 200_000

export type TermEntry = {
  readonly callId: string
  readonly text: string
  readonly bytes: number
  readonly done: boolean
}

export type TermBuffersState = {
  readonly available: boolean
  readonly entries: readonly TermEntry[]
  readonly activeId: string | null
  select(id: string): void
}

/** The preload slice this hook consumes (guarded at runtime — window.api may be absent). */
export type TermApi = {
  on(channel: 'agent:term', listener: (payload: AgentTermEvent) => void): () => void
  on(channel: 'agent:event', listener: (payload: AgentEvent) => void): () => void
}

export function getTermApi(): TermApi | null {
  if (typeof window === 'undefined') return null
  const raw = (window as unknown as { api?: Partial<TermApi> }).api
  if (typeof raw?.on !== 'function') return null
  return raw as TermApi
}

const encoder = new TextEncoder()

/** append one chunk, dropping the OLDEST pieces once the byte cap is crossed. */
function appendChunk(entries: readonly TermEntry[], callId: string, chunk: string): TermEntry[] {
  const addBytes = encoder.encode(chunk).length
  const next = entries.map((e) =>
    e.callId === callId
      ? { ...e, text: e.text + chunk, bytes: e.bytes + addBytes }
      : e,
  )
  const idx = next.findIndex((e) => e.callId === callId)
  const entry = next[idx]
  if (entry !== undefined && entry.bytes > TERM_BUFFER_MAX_BYTES) {
    // trim from the head in ~1 KB steps (scrollback semantics: tail wins)
    let text = entry.text
    let bytes = entry.bytes
    while (bytes > TERM_BUFFER_MAX_BYTES && text.length > 0) {
      const drop = text.slice(0, 1024)
      text = text.slice(1024)
      bytes -= encoder.encode(drop).length
    }
    next[idx] = { ...entry, text, bytes }
  }
  return next
}

function markDone(entries: readonly TermEntry[], callId: string): TermEntry[] {
  return entries.map((e) => (e.callId === callId ? { ...e, done: true } : e))
}

export function useTermBuffer(): TermBuffersState {
  const [api] = useState(getTermApi)
  const [entries, setEntries] = useState<readonly TermEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  useEffect(() => {
    if (!api) return undefined
    const offTerm = api.on('agent:term', (payload: AgentTermEvent) => {
      setEntries((prev) => {
        if (prev.some((e) => e.callId === payload.id)) return appendChunk(prev, payload.id, payload.chunk)
        return [...prev, { callId: payload.id, text: payload.chunk, bytes: encoder.encode(payload.chunk).length, done: false }]
      })
      // first buffer seen claims focus (later buffers do NOT steal it)
      setActiveId((cur) => cur ?? payload.id)
    })
    const offEvent = api.on('agent:event', (event: AgentEvent) => {
      if (event.type !== 'tool_result') return
      setEntries((prev) => markDone(prev, event.callId))
    })
    return () => {
      offTerm()
      offEvent()
    }
  }, [api])

  // a cancelled/errored session can leave buffers unfinished; nothing to
  // subscribe beyond the two channels above (tool_result always lands for
  // executed calls, and Stop clears the run upstream).

  const select = useCallback((id: string) => setActiveId(id), [])

  return { available: api !== null, entries, activeId, select }
}
