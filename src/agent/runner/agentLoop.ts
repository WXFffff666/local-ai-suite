/**
 * runAgentLoop — the todo23 tool-calling loop over a local OpenAI-compatible
 * endpoint. One iteration = one streamed /v1/chat/completions call; streamed
 * tool_call fragments are merged (sse.ts) and their argument JSON repaired via
 * jsonrepair at end-of-stream. Tool results are appended as role:'tool'
 * messages and the loop continues until an answer arrives without tool calls,
 * the caller aborts, or the MAX_AGENT_ITERATIONS hard cap trips (AgentLimitError).
 *
 * Layering (plan R7 判决): self-built thin loop — NO langchain/vercel-ai.
 * Permission gating lives in the injected ToolExecutor (todo27/28 call
 * PermissionEngine there); the runner only mirrors the executor's phase
 * callbacks into tool_call events so todo29 can render the timeline.
 * Every LLM-produced value is treated as data, never instructions (R3-C).
 *
 * Electron-free by construction: fetch + AbortSignal only, so the whole loop
 * is unit-tested against a scripted fake fetch.
 */

import { jsonrepair } from 'jsonrepair'

import { parseSseLine, projectChunk, toOpenAiTools, ToolCallAccumulator, type AccumulatedToolCall } from './sse'
import {
  AgentLimitError,
  AgentLoopError,
  MAX_AGENT_ITERATIONS,
  type AgentErrorCode,
  type AgentEvent,
  type AgentFetch,
  type AgentLoopErrorInfo,
  type AgentLoopInput,
  type AgentMessage,
  type AgentResponse,
  type AgentRunResult,
  type JsonValue,
  type OpenAiToolWire,
  type ToolCallPhase,
  type ToolExecutionContext
} from './types'

/** Tool output larger than this is truncated before being fed back (context guard). */
export const MAX_TOOL_RESULT_CHARS = 32_000

/** Matches the context-window rejection phrasing llama.cpp / Ollama / vLLM all emit. */
const CONTEXT_LENGTH_RE = /context[\s_-]*length|too many tokens|maximum context|prompt too long/i

type RepairedArgs =
  | { readonly ok: true; readonly argsJson: string; readonly args: JsonValue }
  | { readonly ok: false; readonly feedback: string }

/**
 * Repairs one streamed arguments fragment: direct parse first (well-formed
 * streams never touch jsonrepair), then repair, then — only if the repaired
 * document is a JSON object — hand it to the executor. Failure becomes the
 * tool-error feedback text fed back to the model (QA-failure path: "坏 JSON
 * 经 jsonrepair 成功或计失败步").
 */
export function repairToolArguments(fragment: string): RepairedArgs {
  const src = fragment.trim() === '' ? '{}' : fragment
  const notObject = (v: JsonValue): RepairedArgs =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? { ok: true, argsJson: JSON.stringify(v), args: v }
      : { ok: false, feedback: 'TOOL_ARGS_ERROR: tool arguments must be a JSON object' }
  try {
    return notObject(JSON.parse(src) as JsonValue)
  } catch {
    /* fall through to repair */
  }
  try {
    return notObject(JSON.parse(jsonrepair(src)) as JsonValue)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, feedback: `TOOL_ARGS_ERROR: unrepairable JSON arguments (${reason})` }
  }
}

/** Stringifies executor output for the role:'tool' message, capped for context. */
export function serializeToolOutput(value: unknown): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated]` : text
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentRunResult> {
  const emit = (event: AgentEvent): void => {
    input.onEvent(event)
  }
  const doFetch: AgentFetch = input.fetchImpl ?? globalThis.fetch
  // 25 is a HARD ceiling (LLM10): callers may lower it, never raise it.
  const cap = Math.min(input.maxIterations ?? MAX_AGENT_ITERATIONS, MAX_AGENT_ITERATIONS)
  const toolsWire: readonly OpenAiToolWire[] | undefined = input.tools.length > 0 ? toOpenAiTools(input.tools) : undefined
  const messages: AgentMessage[] = [...input.messages]
  const url = `${input.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`

  const finishAborted = (iterations: number, text: string): AgentRunResult => {
    emit({ type: 'finished', sessionId: input.sessionId, status: 'aborted', iterations, text })
    return { sessionId: input.sessionId, status: 'aborted', iterations, text }
  }
  const fail: (code: AgentErrorCode, message: string, iteration: number, status?: number) => never = (code, message, iteration, status) => {
    emit({ type: 'error', sessionId: input.sessionId, code, message, iteration })
    const info: AgentLoopErrorInfo =
      status === undefined
        ? { sessionId: input.sessionId, code, iteration }
        : { sessionId: input.sessionId, code, iteration, status }
    throw new AgentLoopError(message, info)
  }

  for (let iteration = 1; iteration <= cap; iteration += 1) {
    if (input.signal.aborted) return finishAborted(iteration - 1, '')

    const body: { model: string; messages: AgentMessage[]; stream: true; tools?: readonly OpenAiToolWire[] } = {
      model: input.model,
      messages,
      stream: true
    }
    if (toolsWire !== undefined) body.tools = toolsWire

    let res: AgentResponse
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal: input.signal
      })
    } catch (error) {
      if (input.signal.aborted) return finishAborted(iteration - 1, '')
      const reason = error instanceof Error ? error.message : String(error)
      fail('upstream-transport', `agent upstream unreachable: ${reason}`, iteration)
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      const clipped = detail.slice(0, 512)
      if (CONTEXT_LENGTH_RE.test(detail)) {
        fail('context-length', `context window exceeded${clipped ? `: ${clipped}` : ''}`, iteration, res.status)
      }
      fail('upstream-status', `upstream returned ${res.status}${clipped ? `: ${clipped}` : ''}`, iteration, res.status)
    }
    if (!res.body) fail('upstream-shape', 'upstream returned no stream body', iteration)

    // Pump the SSE stream: text deltas out immediately, tool_call fragments in.
    // (undici types body as ReadableStream without the element generic; the
    //  wire chunks are always Uint8Array — same narrowing chatRelay does.)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const acc = new ToolCallAccumulator(`call_${iteration}`)
    let buffer = ''
    let assistantText = ''
    let sawDone = false
    try {
      pump: for (;;) {
        if (input.signal.aborted) {
          await reader.cancel().catch(() => undefined)
          return finishAborted(iteration, assistantText)
        }
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const sse = parseSseLine(line.trim())
          if (sse?.kind === 'done') {
            sawDone = true
            break
          }
          if (sse?.kind === 'data') {
            const proj = projectChunk(sse.json)
            if (proj.content) {
              assistantText += proj.content
              emit({ type: 'message_delta', sessionId: input.sessionId, delta: proj.content })
            }
            for (const toolCallDelta of proj.toolCallDeltas) acc.addDelta(toolCallDelta)
          }
        }
        if (sawDone) break pump
      }
      if (!sawDone && buffer.trim()) {
        const sse = parseSseLine(buffer.trim())
        if (sse?.kind === 'data') {
          const proj = projectChunk(sse.json)
          if (proj.content) {
            assistantText += proj.content
            emit({ type: 'message_delta', sessionId: input.sessionId, delta: proj.content })
          }
          for (const toolCallDelta of proj.toolCallDeltas) acc.addDelta(toolCallDelta)
        }
      }
    } catch (error) {
      if (input.signal.aborted) return finishAborted(iteration, assistantText)
      throw error
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* already released (cancel path) */
      }
    }
    if (input.signal.aborted) return finishAborted(iteration, assistantText)

    const toolCalls = acc.snapshot()
    if (toolCalls.length === 0) {
      emit({ type: 'finished', sessionId: input.sessionId, status: 'completed', iterations: iteration, text: assistantText })
      return { sessionId: input.sessionId, status: 'completed', iterations: iteration, text: assistantText }
    }

    if (iteration >= cap) {
      emit({ type: 'error', sessionId: input.sessionId, code: 'max-iterations', message: `agent hit the ${cap}-iteration cap while still requesting tools`, iteration })
      throw new AgentLimitError(input.sessionId, cap)
    }

    // History: assistant turn (broken args go out as '{}' — the matching
    // tool message carries the TOOL_ARGS_ERROR feedback the model sees).
    const repaired = toolCalls.map((call) => ({ call, args: repairToolArguments(call.argsFragment) }))
    emit({
      type: 'plan',
      sessionId: input.sessionId,
      iteration,
      steps: toolCalls.map((call) => ({
        callId: call.callId,
        name: call.name,
        argsSummary: call.argsFragment.slice(0, 200)
      }))
    })
    messages.push({
      role: 'assistant',
      content: assistantText,
      tool_calls: repaired.map(({ call, args }) => ({
        id: call.callId,
        type: 'function' as const,
        function: { name: call.name, arguments: args.ok ? args.argsJson : '{}' }
      }))
    })

    for (const { call, args } of repaired) {
      if (input.signal.aborted) return finishAborted(iteration, assistantText)
      if (!args.ok) {
        pushToolResult(messages, emit, input.sessionId, call, false, args.feedback, 0)
        continue
      }
      const startedAt = Date.now()
      const reportPhase = (phase: ToolCallPhase): void => {
        emit({ type: 'tool_call', sessionId: input.sessionId, callId: call.callId, name: call.name, args: args.args, phase })
      }
      reportPhase('awaiting-permission')
      const ctx: ToolExecutionContext = { callId: call.callId, signal: input.signal, reportPhase }
      let ok = true
      let content: string
      try {
        content = serializeToolOutput(await input.executor.execute(call.name, args.argsJson, ctx))
      } catch (error) {
        ok = false
        content = `TOOL_ERROR: ${error instanceof Error ? error.message : String(error)}`
      }
      pushToolResult(messages, emit, input.sessionId, call, ok, content, Date.now() - startedAt)
    }
  }
  // unreachable: the cap trips inside the loop with AgentLimitError
  throw new AgentLimitError(input.sessionId, cap)
}

function pushToolResult(
  messages: AgentMessage[],
  emit: (event: AgentEvent) => void,
  sessionId: string,
  call: AccumulatedToolCall,
  ok: boolean,
  content: string,
  durationMs: number
): void {
  messages.push({ role: 'tool', tool_call_id: call.callId, content })
  emit({ type: 'tool_result', sessionId, callId: call.callId, name: call.name, ok, content, durationMs })
}
