/**
 * Thin main-process chat relay (plan W1-8). Streams an OpenAI-compatible
 * /v1/chat/completions response from the ONE legal upstream and pushes
 * chat:delta / chat:done / chat:error to the SENDING frame only.
 *
 * Upstream selection encodes the plan's two-source rule (todo10/11/30):
 * - external-takeover  -> the external engine already serving 127.0.0.1:11434
 * - otherwise          -> the internal llama-server on its RESOLVED port
 * The embedded facade on 11434 is NEVER called back (no self-loop): 11434 is
 * only ever dialed when ownership.mode === 'external-takeover', i.e. when our
 * own facade is guaranteed not to be listening there.
 *
 * Full-featured relay behaviour (store wiring, resolver-driven multi-upstream)
 * is todo11; this module owns the IPC event contract + abort registry.
 */

import { SIDECAR_HOST } from '../../core/types'
import { OLLAMA_PORT } from '../../api/openai'
import type { ChatAbortInput, ChatSendInput } from './schemas'
import type { ChatDeltaEvent, ChatDoneEvent, ChatErrorEvent, IpcSendFn } from './whitelist'

export type ChatUpstream =
  | { kind: 'external-ollama'; port: number }
  | { kind: 'internal-llama'; port: number }

export type RelayServices = {
  /** Lazy container accessor (never invoked at import time). */
  ensureSidecar: (name: 'llama') => Promise<{ running: boolean; port: number; state: string }>
}

export type EngineOwnershipView = { mode: 'external-takeover' | 'embedded' | 'conflict' | 'unknown' }

export type ChatRelayDeps = {
  services: () => RelayServices
  /** todo10 arbitration view; absent/null until wired ⇒ internal llama. */
  getEngineOwnership?: () => EngineOwnershipView | undefined
  fetchImpl?: typeof globalThis.fetch
}

export type RelayAck = { ok: true; id: string; streaming: true }

type SendEvent = (
  channel: 'chat:delta' | 'chat:done' | 'chat:error',
  payload: ChatDeltaEvent | ChatDoneEvent | ChatErrorEvent
) => void

export class ChatRelay {
  private readonly controllers = new Map<string, AbortController>()
  private readonly doFetch: typeof globalThis.fetch

  constructor(private readonly deps: ChatRelayDeps) {
    this.doFetch = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  }

  /** Returns the invoke ack synchronously; the stream runs detached. */
  start(payload: ChatSendInput, send: IpcSendFn): RelayAck {
    void this.run(payload, send)
    return { ok: true, id: payload.id, streaming: true }
  }

  abort(input: ChatAbortInput): { ok: true; id: string; aborted: boolean } {
    const controller = this.controllers.get(input.id)
    if (!controller) return { ok: true, id: input.id, aborted: false }
    controller.abort()
    return { ok: true, id: input.id, aborted: true }
  }

  /** Active relay count (tests / tray diagnostics). */
  active(): number {
    return this.controllers.size
  }

  private async resolveUpstream(): Promise<ChatUpstream> {
    const ownership = this.deps.getEngineOwnership?.()
    if (ownership?.mode === 'external-takeover') {
      // The external engine owns 11434; our facade is not listening ⇒ legal dial.
      return { kind: 'external-ollama', port: OLLAMA_PORT }
    }
    const status = await this.deps.services().ensureSidecar('llama')
    if (!status.running) {
      throw new Error(`llama-server unavailable (state: ${status.state})`)
    }
    // The resolved (possibly reallocated) port — never the 11434 facade.
    return { kind: 'internal-llama', port: status.port }
  }

  private async run(payload: ChatSendInput, send: IpcSendFn): Promise<void> {
    const { id } = payload
    const emit = ((channel, event) => {
      send(channel, event)
    }) satisfies SendEvent

    if (this.controllers.has(id)) {
      emit('chat:error', { id, message: `a relay for session ${id} is already running` })
      return
    }
    const controller = new AbortController()
    this.controllers.set(id, controller)
    try {
      const upstream = await this.resolveUpstream()
      const url = `http://${SIDECAR_HOST}:${upstream.port}/v1/chat/completions`
      const body: Record<string, unknown> = {
        model: payload.model,
        messages: payload.messages,
        stream: true
      }
      if (payload.temperature !== undefined) body.temperature = payload.temperature
      if (payload.top_p !== undefined) body.top_p = payload.top_p
      if (payload.max_tokens !== undefined) body.max_tokens = payload.max_tokens
      if (payload.stop !== undefined) body.stop = payload.stop

      const res = await this.doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        emit('chat:error', { id, message: `upstream ${upstream.kind} returned ${res.status}${text ? `: ${text.slice(0, 512)}` : ''}` })
        return
      }
      if (!res.body) {
        emit('chat:error', { id, message: `upstream ${upstream.kind} returned no body` })
        return
      }
      await this.pumpSse(id, payload.model, res.body as ReadableStream<Uint8Array>, emit, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        emit('chat:done', { id, model: payload.model, aborted: true })
        return
      }
      emit('chat:error', { id, message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.controllers.delete(id)
    }
  }

  /** Parses OpenAI-shaped SSE (both llama-server and Ollama emit it on /v1). */
  private async pumpSse(
    id: string,
    model: string,
    stream: ReadableStream<Uint8Array>,
    emit: SendEvent,
    signal: AbortSignal
  ): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined)
          emit('chat:done', { id, model, aborted: true })
          return
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (handleSseLine(line.trim(), id, model, emit)) return
        }
      }
      if (handleSseLine(buffer.trim(), id, model, emit)) return
      emit('chat:done', { id, model })
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* already released */
      }
    }
  }
}

/** Returns true when the terminal [DONE] sentinel was seen. */
function handleSseLine(line: string, id: string, model: string, emit: SendEvent): boolean {
  if (!line.startsWith('data:')) return false
  const data = line.slice(5).trim()
  if (!data) return false
  if (data === '[DONE]') {
    emit('chat:done', { id, model })
    return true
  }
  try {
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> }
    const content = chunk.choices?.[0]?.delta?.content
    if (typeof content === 'string' && content.length > 0) {
      emit('chat:delta', { id, delta: content })
    }
  } catch {
    /* malformed keep-alive/comment line — ignore */
  }
  return false
}
