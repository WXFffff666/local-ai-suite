/**
 * agentLoop.test.ts 鈥?the todo23 acceptance matrix, run against a scripted
 * fake fetch (no Electron, no sidecar): two-step tool convergence (QA-happy),
 * jsonrepair on truncated streamed args (QA-failure), abort mid-stream,
 * the MAX_ITERATIONS cap (AgentLimitError), unparseable args fed back as a
 * tool error, and the structured context-length surface for todo29.
 */
import { describe, expect, it } from 'vitest'

import { repairToolArguments, runAgentLoop, serializeToolOutput, MAX_TOOL_RESULT_CHARS } from './agentLoop'
import {
  AgentLimitError,
  AgentLoopError,
  type AgentEvent,
  type AgentFetch,
  type AgentMessage,
  type AgentResponse,
  type JsonValue,
  type ToolDef,
  type ToolExecutor
} from './types'

const enc = new TextEncoder()

// --- SSE scripting helpers ------------------------------------------------------

function sseLine(obj: JsonValue): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
const DONE = 'data: [DONE]\n\n'

function textChunk(content: string): JsonValue {
  return { choices: [{ delta: { content }, index: 0 }] }
}
function toolCallStart(index: number, id: string, name: string, firstArgs: string): JsonValue {
  return { choices: [{ delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: firstArgs } }] }, index: 0 }] }
}
function toolCallArgs(index: number, args: string): JsonValue {
  return { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args } }] }, index: 0 }] }
}
function finishChunk(reason: string): JsonValue {
  return { choices: [{ delta: {}, index: 0, finish_reason: reason }] }
}

function streamResponse(lines: readonly string[]): AgentResponse {
  const bytes = lines.map((l) => enc.encode(l))
  let next = 0
  return {
    ok: true,
    status: 200,
    text: async () => '',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < bytes.length) {
          controller.enqueue(bytes[next])
          next += 1
        } else {
          controller.close()
        }
      }
    })
  }
}

function errorResponse(status: number, detail: string): AgentResponse {
  return { ok: false, status, text: async () => detail, body: null }
}

// --- harness ---------------------------------------------------------------------

const readFileTool: ToolDef = {
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }
}

type ExecutedCall = { name: string; argsJson: string; phases: string[] }

function makeExecutor(execute: ToolExecutor['execute']): ToolExecutor {
  return { list: () => [readFileTool], execute }
}

function baseInput(executor: ToolExecutor = makeExecutor(async () => null)) {
  const controller = new AbortController()
  return {
    sessionId: 's1',
    baseUrl: 'http://127.0.0.1:9999',
    model: 'qwen3',
    messages: [{ role: 'user', content: 'summarize a.txt' } as AgentMessage],
    tools: [readFileTool],
    executor,
    signal: controller.signal,
    onEvent: (_e: AgentEvent) => undefined
  }
}

function scriptedFetch(responses: readonly AgentResponse[]): { impl: AgentFetch; bodies: JsonValue[]; calls: () => number } {
  const bodies: JsonValue[] = []
  let calls = 0
  const impl: AgentFetch = async (_url, init) => {
    const res = responses[calls]
    if (res === undefined) throw new Error(`scripted fetch exhausted after ${calls} calls`)
    calls += 1
    bodies.push(JSON.parse(init.body) as JsonValue)
    return res
  }
  return { impl, bodies, calls: () => calls }
}

function collector(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, onEvent: (e) => { events.push(e) } }
}

const eventTypes = (events: readonly AgentEvent[]): string[] => events.map((e) => e.type)

// --- helpers to read into JsonValue trees without casts ------------------------------------------------

function obj(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined
}
function arr(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : []
}

// --- the matrix -------------------------------------------------------------------

describe('runAgentLoop 鈥?tool-calling cycle', () => {
  it('two-step convergence: streamed tool_call 鈫?result fed back 鈫?final text (QA-happy)', async () => {
    const executed: ExecutedCall[] = []
    const executor = makeExecutor(async (name, argsJson, ctx) => {
      ctx.reportPhase('running')
      executed.push({ name, argsJson, phases: [] })
      return 'hello from a.txt'
    })
    const stream1 = streamResponse([
      sseLine(toolCallStart(0, 'tc-1', 'read_file', '{"pat')),
      sseLine(toolCallArgs(0, 'h": "a.txt"}')),
      sseLine(finishChunk('tool_calls')),
      DONE
    ])
    const stream2 = streamResponse([sseLine(textChunk('all done')), sseLine(finishChunk('stop')), DONE])
    const fetch = scriptedFetch([stream1, stream2])
    const { events, onEvent } = collector()

    const result = await runAgentLoop({ ...baseInput(executor), fetchImpl: fetch.impl, onEvent })

    expect(result).toEqual({ sessionId: 's1', status: 'completed', iterations: 2, text: 'all done' })
    expect(fetch.calls()).toBe(2)
    expect(eventTypes(events)).toEqual([
      'plan',
      'tool_call',
      'tool_call',
      'tool_result',
      'message_delta',
      'finished'
    ])
    expect(executed).toHaveLength(1)
    expect(executed[0]?.name).toBe('read_file')
    expect(JSON.parse(executed[0]!.argsJson)).toEqual({ path: 'a.txt' })

    // second request carries the OpenAI history: user 鈫?assistant(tool_calls) 鈫?tool(result)
    const secondBody = obj(fetch.bodies[1])
    const msgs = arr(secondBody?.['messages'])
    expect(msgs).toHaveLength(3)
    const assistant = obj(msgs[1])
    expect(assistant?.['role']).toBe('assistant')
    const toolCallsWire = arr(assistant?.['tool_calls'])
    expect(obj(obj(toolCallsWire[0])?.['function'])?.['arguments']).toBe('{"path":"a.txt"}')
    const toolMsg = obj(msgs[2])
    expect(toolMsg?.['role']).toBe('tool')
    expect(toolMsg?.['tool_call_id']).toBe('tc-1')
    expect(toolMsg?.['content']).toBe('hello from a.txt')

    // tools array rides every request; the phase pair is awaiting-permission 鈫?running
    const firstBody = obj(fetch.bodies[0])
    expect(obj(arr(firstBody?.['tools'])[0])?.['function'] !== undefined).toBe(true)
    const phases = events.filter((e) => e.type === 'tool_call').map((e) => (e as { phase: string }).phase)
    expect(phases).toEqual(['awaiting-permission', 'running'])
  })

  it('truncated streamed arguments are repaired by jsonrepair before execute (QA-failure)', async () => {
    let seenArgs: string | undefined
    const executor = makeExecutor(async (_n, argsJson) => {
      seenArgs = argsJson
      return 'written'
    })
    // deliberately broken: unterminated string + unclosed brace
    const stream1 = streamResponse([
      sseLine(toolCallStart(0, 'tc-1', 'write_file', '{"path": "a.txt", "content": "he')),
      sseLine(finishChunk('tool_calls')),
      DONE
    ])
    const stream2 = streamResponse([sseLine(textChunk('ok')), DONE])
    const { events, onEvent } = collector()

    await runAgentLoop({
      ...baseInput(executor),
      fetchImpl: scriptedFetch([stream1, stream2]).impl,
      onEvent
    })
    expect(JSON.parse(seenArgs ?? 'null')).toEqual({ path: 'a.txt', content: 'he' })
    const resultEvent = events.find((e) => e.type === 'tool_result')
    expect(resultEvent?.type === 'tool_result' && resultEvent.ok).toBe(true)
  })

  it('abort mid-stream: in-flight read dies, no new request, terminal aborted event', async () => {
    const controller = new AbortController()
    let streamCtrl: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        streamCtrl = c
      }
    })
    controller.signal.addEventListener('abort', () => {
      try {
        streamCtrl?.error(new Error('socket closed'))
      } catch {
        /* already closed */
      }
    })
    let calls = 0
    const impl: AgentFetch = async () => {
      calls += 1
      return { ok: true, status: 200, text: async () => '', body }
    }
    streamCtrl?.enqueue(enc.encode(sseLine(textChunk('half a sentence'))))
    const { events, onEvent } = collector()

    const running = runAgentLoop({
      ...baseInput(),
      signal: controller.signal,
      fetchImpl: impl,
      onEvent
    })
    // let the pump consume the queued chunk, then cancel the session
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()

    const result = await running
    expect(result.status).toBe('aborted')
    expect(calls).toBe(1)
    const last = events[events.length - 1]
    expect(last?.type === 'finished' && last.status === 'aborted').toBe(true)
  })

  it('iteration cap: AgentLimitError + max-iterations error event, no cap-overflow request', async () => {
    const executor = makeExecutor(async () => 'fine')
    const toolRound = (): AgentResponse =>
      streamResponse([
        sseLine(toolCallStart(0, 'tc', 'read_file', '{"path":"a"}')),
        sseLine(finishChunk('tool_calls')),
        DONE
      ])
    const fetch = scriptedFetch([toolRound(), toolRound()])
    const { events, onEvent } = collector()

    await expect(
      runAgentLoop({
        ...baseInput(executor),
        fetchImpl: fetch.impl,
        onEvent,
        maxIterations: 2
      })
    ).rejects.toBeInstanceOf(AgentLimitError)
    expect(fetch.calls()).toBe(2)
    const err = events[events.length - 1]
    expect(err?.type === 'error' && err.code === 'max-iterations' && err.iteration === 2).toBe(true)
  })

  it('args that cannot become a JSON object are fed back as TOOL_ARGS_ERROR without execute', async () => {
    let executed = false
    const executor = makeExecutor(async () => {
      executed = true
      return 'never'
    })
    const stream1 = streamResponse([
      sseLine(toolCallStart(0, 'tc-1', 'read_file', '42')), // valid JSON, wrong shape
      sseLine(finishChunk('tool_calls')),
      DONE
    ])
    const stream2 = streamResponse([sseLine(textChunk('sorry')), DONE])
    const fetch = scriptedFetch([stream1, stream2])
    const { events, onEvent } = collector()

    await runAgentLoop({
      ...baseInput(executor),
      fetchImpl: fetch.impl,
      onEvent
    })
    expect(executed).toBe(false)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult?.type === 'tool_result' && toolResult.ok === false).toBe(true)
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toContain('TOOL_ARGS_ERROR')
    }
    const secondBody = obj(fetch.bodies[1])
    const toolMsg = obj(arr(secondBody?.['messages']).find((m) => obj(m)?.['role'] === 'tool'))
    expect(String(toolMsg?.['content'])).toContain('TOOL_ARGS_ERROR')
  })

  it('executor rejection (permission denied) becomes TOOL_ERROR fed back; the loop continues', async () => {
    const executor = makeExecutor(async () => {
      throw new Error('permission-denied')
    })
    const stream1 = streamResponse([
      sseLine(toolCallStart(0, 'tc-1', 'read_file', '{"path":"secret"}')),
      sseLine(finishChunk('tool_calls')),
      DONE
    ])
    const stream2 = streamResponse([sseLine(textChunk('understood, skipping')), DONE])
    const fetch = scriptedFetch([stream1, stream2])
    const { events, onEvent } = collector()

    const result = await runAgentLoop({
      ...baseInput(executor),
      fetchImpl: fetch.impl,
      onEvent
    })
    expect(result.status).toBe('completed')
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult?.type === 'tool_result' && !toolResult.ok).toBe(true)
    const secondBody = obj(fetch.bodies[1])
    const toolMsg = obj(arr(secondBody?.['messages']).find((m) => obj(m)?.['role'] === 'tool'))
    expect(String(toolMsg?.['content'])).toContain('TOOL_ERROR: permission-denied')
  })

  it('4xx context-length upstream 鈫?structured error event + AgentLoopError (todo29 renders)', async () => {
    const { events, onEvent } = collector()
    await expect(
      runAgentLoop({
        ...baseInput(),
        fetchImpl: scriptedFetch([errorResponse(400, '{"error":{"message":"This model\'s maximum context length is 4096 tokens"}}')]).impl,
        onEvent
      })
    ).rejects.toBeInstanceOf(AgentLoopError)
    const err = events[events.length - 1]
    expect(err?.type === 'error' && err.code === 'context-length').toBe(true)
  })

  it('tools array is omitted when the registry is empty (pure-chat session)', async () => {
    const fetch = scriptedFetch([streamResponse([sseLine(textChunk('hi')), DONE])])
    const { onEvent } = collector()
    await runAgentLoop({
      ...baseInput({ list: (): readonly ToolDef[] => [], execute: async () => null }),
      tools: [],
      fetchImpl: fetch.impl,
      onEvent
    })
    expect(obj(fetch.bodies[0])?.['tools']).toBeUndefined()
  })
})

describe('repairToolArguments / serializeToolOutput', () => {
  it('empty fragment defaults to {} (arg-less tools), clean JSON skips repair', () => {
    expect(repairToolArguments('')).toEqual({ ok: true, argsJson: '{}', args: {} })
    expect(repairToolArguments('{"a":1}')).toEqual({ ok: true, argsJson: '{"a":1}', args: { a: 1 } })
  })
  it('arrays and scalars are not objects 鈫?feedback, executor never sees them', () => {
    expect(repairToolArguments('[1,2]').ok).toBe(false)
    expect(repairToolArguments('"str"').ok).toBe(false)
  })
  it('huge results are truncated at the cap with a visible marker', () => {
    const out = serializeToolOutput({ text: 'x'.repeat(MAX_TOOL_RESULT_CHARS + 100) })
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + '鈥truncated]'.length)
    expect(out).toMatch(/\[truncated\]$/)
  })
})
