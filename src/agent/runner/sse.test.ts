/**
 * sse.test.ts — line parsing + per-index tool_call accumulation semantics of
 * the runner parser (the pieces the scripted loop tests cannot isolate).
 */
import { describe, expect, it } from 'vitest'

import { parseSseLine, projectChunk, ToolCallAccumulator, toOpenAiTools } from './sse'
import type { JsonObject, JsonValue } from './types'

function objOf(frame: JsonValue): JsonObject {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    throw new Error('test fixture: frame must be an object')
  }
  return frame
}

describe('parseSseLine', () => {
  it('data line → json; [DONE] → done; noise → null', () => {
    expect(parseSseLine('data: {"a":1}')).toEqual({ kind: 'data', json: { a: 1 } })
    expect(parseSseLine('data: [DONE]')).toEqual({ kind: 'done' })
    expect(parseSseLine(': keep-alive')).toBeNull()
    expect(parseSseLine('event: message')).toBeNull()
    expect(parseSseLine('data: {broken')).toBeNull()
    expect(parseSseLine('data:')).toBeNull()
    expect(parseSseLine('data: 42')).toBeNull() // scalar payload is not an object chunk
  })
})

describe('projectChunk', () => {
  it('extracts content, tool_call deltas and finish_reason', () => {
    const frame: import('./types').JsonValue = {
      choices: [{ delta: { content: 'hi', tool_calls: [{ index: 0 }] }, finish_reason: 'tool_calls' }]
    }
    expect(projectChunk(objOf(frame))).toEqual({
      content: 'hi',
      toolCallDeltas: [{ index: 0 }],
      finishReason: 'tool_calls'
    })
  })
  it('choiceless / malformed frames project to nothing', () => {
    expect(projectChunk(objOf({ id: 'x' }))).toEqual({ content: '', toolCallDeltas: [], finishReason: undefined })
    expect(projectChunk(objOf({ choices: [] }))).toEqual({ content: '', toolCallDeltas: [], finishReason: undefined })
    const noContent = projectChunk(objOf({ choices: [{ delta: { reasoning_content: 'think' } }] }))
    expect(noContent.content).toBe('')
  })
})

describe('ToolCallAccumulator', () => {
  const toolDelta = (index: number, id?: string, name?: string, args?: string): JsonValue => ({
    index,
    ...(id === undefined ? {} : { id }),
    function: { ...(name === undefined ? {} : { name }), ...(args === undefined ? {} : { arguments: args }) }
  })

  it('merges fragments by index, keeps first-seen order, ignores malformed entries', () => {
    const acc = new ToolCallAccumulator('call_1')
    acc.addDelta(toolDelta(1, undefined, undefined, '{"b":1}'))
    acc.addDelta(toolDelta(0, 'tc-a', 'read_file', '{"a"'))
    acc.addDelta('not-an-object')
    acc.addDelta(toolDelta(-0.5))
    acc.addDelta(toolDelta(0, undefined, undefined, ':2}'))
    expect(acc.snapshot()).toEqual([
      { callId: 'tc-a', name: 'read_file', argsFragment: '{"a":2}' },
      { callId: 'call_1_1', name: '', argsFragment: '{"b":1}' }
    ])
  })

  it('a late id does not overwrite the first one', () => {
    const acc = new ToolCallAccumulator('x')
    acc.addDelta(toolDelta(0, 'first'))
    acc.addDelta(toolDelta(0, 'second'))
    expect(acc.snapshot()[0]?.callId).toBe('first')
  })
})

describe('toOpenAiTools', () => {
  it('wraps each ToolDef as a strict function entry', () => {
    const tools = toOpenAiTools([
      { name: 't', description: 'd', parameters: { type: 'object', additionalProperties: false } }
    ])
    expect(tools).toEqual([
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', additionalProperties: false } } }
    ])
  })
})
