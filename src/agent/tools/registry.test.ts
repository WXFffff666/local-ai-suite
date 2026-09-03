/**
 * registry.test.ts — todo23 interface smoke: strict-schema gate, registration,
 * list projection, and the execute trust boundary. Tool IMPLEMENTATIONS arrive
 * with todo27/28; everything a tool will rely on is pinned here.
 */
import { describe, expect, it, vi } from 'vitest'

import { assertStrictToolSchema, ToolRegistry, type ToolRegistration } from './registry'
import type { JsonValue, ToolDef } from '../runner/types'

const strictParams: ToolDef['parameters'] = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false
}

function tool(name: string, run?: ToolRegistration['run']): ToolRegistration {
  return {
    def: { name, description: `tool ${name}`, parameters: strictParams },
    run: run ?? (async (args) => args)
  }
}

const ctx = {
  callId: 'c1',
  signal: new AbortController().signal,
  reportPhase: (_phase: 'awaiting-permission' | 'running') => undefined
}

describe('assertStrictToolSchema (OpenAI strict mode, R7 anchor)', () => {
  it('accepts additionalProperties:false with all properties required', () => {
    expect(() => assertStrictToolSchema('ok', strictParams)).not.toThrow()
  })
  it('accepts an empty zero-property object schema', () => {
    expect(() => assertStrictToolSchema('empty', { type: 'object', additionalProperties: false })).not.toThrow()
  })
  it('rejects non-object, permissive, optional-property and inconsistent schemas', () => {
    expect(() => assertStrictToolSchema('a', { type: 'string', additionalProperties: false })).toThrow(/object schema/)
    expect(() => assertStrictToolSchema('b', { type: 'object', properties: {}, required: [] })).toThrow(/additionalProperties/)
    expect(() => assertStrictToolSchema('c', { type: 'object', properties: strictParams['properties'], additionalProperties: false })).toThrow(/required/)
    expect(() =>
      assertStrictToolSchema('d', {
        type: 'object',
        properties: { path: { type: 'string' }, other: { type: 'string' } },
        required: ['path'],
        additionalProperties: false
      })
    ).toThrow(/optional property 'other'/)
  })
})

describe('ToolRegistry', () => {
  it('register → list exposes exactly the advertised defs', () => {
    const reg = new ToolRegistry()
    reg.register(tool('read_file'))
    reg.register(tool('glob_list'))
    expect(reg.list().map((d) => d.name)).toEqual(['read_file', 'glob_list'])
  })

  it('duplicate names and non-strict schemas are refused at registration', () => {
    const reg = new ToolRegistry()
    reg.register(tool('read_file'))
    expect(() => reg.register(tool('read_file'))).toThrow(/already registered/)
    expect(() => reg.register({ def: { name: 'loose', description: 'd', parameters: { type: 'object' } }, run: async () => null })).toThrow(
      /additionalProperties/
    )
  })

  it('execute dispatches parsed args + context to the registered tool', async () => {
    const run = vi.fn(async (args: Record<string, JsonValue>) => `got ${String(args['path'])}`)
    const reg = new ToolRegistry()
    reg.register(tool('read_file', run))
    await expect(reg.execute('read_file', '{"path":"a.txt"}', ctx)).resolves.toBe('got a.txt')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toBe(ctx)
  })

  it('unknown tool and non-JSON args reject — the loop turns these into TOOL_ERROR', async () => {
    const reg = new ToolRegistry()
    reg.register(tool('read_file'))
    await expect(reg.execute('nope', '{}', ctx)).rejects.toThrow(/unknown tool 'nope'/)
    await expect(reg.execute('read_file', 'not json', ctx)).rejects.toThrow(/invalid tool arguments JSON/)
    await expect(reg.execute('read_file', '[1]', ctx)).rejects.toThrow(/must be a JSON object/)
  })
})
