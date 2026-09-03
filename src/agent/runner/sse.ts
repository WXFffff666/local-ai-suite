/**
 * Minimal OpenAI-SSE parser for the agent loop (todo23). chatRelay's parser
 * is private and chat-event-shaped, so the runner owns its own — the wire
 * facts are identical: `data: <json>\n\n` lines, `data: [DONE]` sentinel,
 * choices[0].delta carrying `content` strings and `tool_calls` fragments
 * keyed by an integer `index` (id/name arrive once, arguments stream in
 * pieces that are often invalid JSON until the stream ends — repair lives
 * in agentLoop, not here).
 *
 * Pure + Electron-free; every unknown chunk is narrowed, never cast.
 */

import type { JsonObject, JsonValue, OpenAiToolWire, ToolDef } from './types'

export function asRecord(value: JsonValue | unknown): JsonObject | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as JsonObject
  }
  return undefined
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

// --- one SSE line --------------------------------------------------------------

export type SseLine =
  | { readonly kind: 'data'; readonly json: JsonObject }
  | { readonly kind: 'done' }
  | null

/** Parses one SSE line. Comments/keep-alives/non-data lines → null. */
export function parseSseLine(line: string): SseLine {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (!data) return null
  if (data === '[DONE]') return { kind: 'done' }
  let parsed: JsonValue
  try {
    parsed = JSON.parse(data) as JsonValue
  } catch {
    return null
  }
  const obj = asRecord(parsed)
  return obj ? { kind: 'data', json: obj } : null
}

// --- tool-call accumulation ----------------------------------------------------

export type AccumulatedToolCall = {
  readonly callId: string
  readonly name: string
  readonly argsFragment: string
}

/**
 * Merges `delta.tool_calls` fragments by their wire `index`. The first chunk
 * for an index carries id/name (llama.cpp and Ollama both do); later chunks
 * only carry `function.arguments` pieces. Call ids that never arrive get a
 * deterministic synthetic one (`call_<iteration>_<index>`) so the tool-result
 * back-fill always has a matching tool_call_id.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, { id: string; name: string; args: string }>()

  constructor(private readonly idPrefix: string) {}

  /** Feeds one wire `delta.tool_calls` entry. Malformed entries are ignored. */
  addDelta(entry: JsonValue): void {
    const item = asRecord(entry)
    if (!item) return
    const index = asNumber(item['index'])
    if (index === undefined) return
    const fn = asRecord(item['function'])
    const slot = this.slots.get(index) ?? { id: '', name: '', args: '' }
    const id = asString(item['id'])
    if (id !== undefined && slot.id === '') slot.id = id
    const name = fn ? asString(fn['name']) : undefined
    if (name !== undefined && slot.name === '') slot.name = name
    const args = fn ? asString(fn['arguments']) : undefined
    if (args !== undefined) slot.args += args
    this.slots.set(index, slot)
  }

  /** Index order = first-seen order (wire indices are dense from 0). */
  snapshot(): readonly AccumulatedToolCall[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, slot]) => ({
        callId: slot.id || `${this.idPrefix}_${index}`,
        name: slot.name,
        argsFragment: slot.args
      }))
  }
}

// --- chunk projection ------------------------------------------------------------

export type ChunkProjection = {
  readonly content: string
  readonly toolCallDeltas: readonly JsonValue[]
  readonly finishReason: string | undefined
}

const NO_CHUNK: ChunkProjection = { content: '', toolCallDeltas: [], finishReason: undefined }

/** Projects one chat.completion.chunk onto (text delta, tool-call deltas, finish_reason). */
export function projectChunk(json: JsonObject): ChunkProjection {
  const choices = json['choices']
  if (!Array.isArray(choices) || choices.length === 0) return NO_CHUNK
  const choice = asRecord(choices[0])
  if (!choice) return NO_CHUNK
  const delta = asRecord(choice['delta'])
  const content = delta ? asString(delta['content']) ?? '' : ''
  const rawToolCalls = delta?.['tool_calls']
  const toolCallDeltas = Array.isArray(rawToolCalls) ? rawToolCalls : []
  const finishReason = asString(choice['finish_reason'])
  return { content, toolCallDeltas, finishReason }
}

// --- request tools ---------------------------------------------------------------

/** Maps ToolDefs onto the OpenAI `tools` array (strict function mode). */
export function toOpenAiTools(defs: readonly ToolDef[]): readonly OpenAiToolWire[] {
  return defs.map((fn) => ({ type: 'function' as const, function: fn }))
}
