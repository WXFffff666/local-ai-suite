/**
 * tools.test.ts — the registry bridge (todo40): sanitizeToolSchema keeps the
 * OpenAI strict contract derivable from ANY remote inputSchema (loose, absent,
 * or hostile), and syncMcpTools reconciles live tool sets on a real
 * ToolRegistry (register on connect / unregister on stop / sibling-survives
 * when one remote tool is unnameable).
 */
import { describe, expect, it, vi } from 'vitest'

import { ToolRegistry } from '../agent/tools/registry'
import assert from 'assert'
import { McpPool } from './pool'
import { registerMcpTools, syncMcpTools, toToolDef } from './tools'
import { mcpWireToolName, EMPTY_STRICT_SCHEMA, sanitizeToolSchema, type McpServersMap, type McpSdkSurface, type McpToolInfo } from './types'
import { fakePermission } from '../agent/tools/fs/testutils'

// --- sanitizeToolSchema ----------------------------------------------------------

describe('sanitizeToolSchema', () => {
  it('typical loose schema → object + additionalProperties:false + ALL required', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    })
    assert(out.type === 'object' && out.additionalProperties === false)
    assert(out.required !== undefined)
    expect(out.required).toEqual(['a', 'b'])
  })

  it('nested object properties recurse (each level strict + fully required)', () => {
    const out = sanitizeToolSchema({
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { inner: { type: 'string' } } },
      },
    })
    assert(out.properties !== undefined && out.properties.outer.type === 'object')
    expect(out.properties.outer.additionalProperties).toBe(false)
    expect(out.properties.outer.required).toEqual(['inner'])
  })

  it('missing / non-object / array garbage degrades to the empty strict schema', () => {
    expect(sanitizeToolSchema(undefined)).toEqual(EMPTY_STRICT_SCHEMA)
    expect(sanitizeToolSchema(null)).toEqual(EMPTY_STRICT_SCHEMA)
    expect(sanitizeToolSchema('nope')).toEqual(EMPTY_STRICT_SCHEMA)
    expect(sanitizeToolSchema({ type: 'string' })).toEqual(EMPTY_STRICT_SCHEMA)
    expect(sanitizeToolSchema([{ type: 'object' }])).toEqual(EMPTY_STRICT_SCHEMA)
  })

  it('object without properties (server shorthand) → empty strict schema', () => {
    expect(sanitizeToolSchema({ type: 'object' })).toEqual(EMPTY_STRICT_SCHEMA)
  })

  it('unknown top-level keys survive only in the projected set (via toToolDef)', () => {
    const def = toToolDef('srv', {
      name: 't',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } }, $schema: 'http://json-schema.org/draft-07/schema#', definitions: { junk: {} } },
    })
    expect(def.parameters['$schema']).toBeUndefined()
    expect(def.parameters['definitions']).toBeUndefined()
    expect(Object.keys(def.parameters).sort()).toEqual(['additionalProperties', 'properties', 'required', 'type'])
  })

  it('absent description falls back to the server/tool identity line', () => {
    expect(toToolDef('srv', { name: 't' }).description).toContain("'t'")
  })
})

// --- wire names --------------------------------------------------------------

describe('mcpWireToolName', () => {
  it('unique, OpenAI-safe, ≤64 chars, prefix-carries the server', () => {
    expect(mcpWireToolName('fs', 'read_file')).toBe('mcp_fs__read_file')
    expect(mcpWireToolName('my server!', 'tool.name')).toBe('mcp_my_server___tool_name')
    const long = mcpWireToolName('x'.repeat(40), 'y'.repeat(60))
    expect(long.length).toBeLessThanOrEqual(64)
    expect(long).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

// --- syncMcpTools ------------------------------------------------------------

function makePoolStub(): McpPool {
  const servers: McpServersMap = { demo: { command: 'node' } }
  return new McpPool({ readServers: () => servers, permission: fakePermission().port, loadSdk: async () => {
    throw new Error('not used')
  } })
}

describe('syncMcpTools', () => {
  it('registers remote tools as strict ToolDefs and routes calls to the pool', async () => {
    const registry = new ToolRegistry()
    const pool = makePoolStub()
    const callTool = vi.spyOn(pool, 'callTool').mockResolvedValue({ content: [] })
    const live = new Map()
    const tools: McpToolInfo[] = [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { m: { type: 'string' } } } }]
    const names = syncMcpTools(registry, live, 'demo', tools, pool)
    expect(names).toEqual(['mcp_demo__echo'])
    const defs = registry.list()
    expect(defs[0]?.description).toBe('echoes')
    expect(defs[0]?.parameters['additionalProperties']).toBe(false)
    const ctx = { callId: 'c1', signal: new AbortController().signal, reportPhase: () => undefined }
    await registry.execute('mcp_demo__echo', '{"m":"hi"}', ctx)
    expect(callTool).toHaveBeenCalledWith('demo', 'echo', { m: 'hi' }, ctx)
  })

  it('re-sync replaces the prior set; empty set unregisters all', () => {
    const registry = new ToolRegistry()
    const pool = makePoolStub()
    const live = new Map()
    syncMcpTools(registry, live, 'demo', [{ name: 'a' }, { name: 'b' }], pool)
    expect(registry.list()).toHaveLength(2)
    syncMcpTools(registry, live, 'demo', [{ name: 'c' }], pool)
    expect(registry.list().map((d) => d.name)).toEqual(['mcp_demo__c'])
    syncMcpTools(registry, live, 'demo', [], pool)
    expect(registry.list()).toHaveLength(0)
    expect(live.has('demo')).toBe(false)
  })

  it('two servers never collide; a bad remote tool is skipped, siblings survive', () => {
    const registry = new ToolRegistry()
    const pool = makePoolStub()
    const warn = vi.spyOn(pool, 'warn').mockImplementation(() => undefined)
    const live = new Map()
    syncMcpTools(registry, live, 'one', [{ name: 'x' }, { name: 'x' }], pool) // second collides
    syncMcpTools(registry, live, 'two', [{ name: 'x' }], pool)
    expect(registry.list().map((d) => d.name).sort()).toEqual(['mcp_one__x', 'mcp_two__x'])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('registerMcpTools wires the pool tools-listener into the registry', async () => {
    const registry = new ToolRegistry()
    const servers: McpServersMap = { demo: { command: 'node' } }
    const tools: McpToolInfo[] = [{ name: 'echo' }]
    const fakeClient = {
      connect: async () => undefined, close: async () => undefined,
      listTools: async () => ({ tools }), callTool: async () => ({ content: [] }),
      onclose: undefined,
    }
    const pool = new McpPool({
      readServers: () => servers,
      permission: fakePermission().port,
      loadSdk: async () => ({
        Client: class {
          constructor() {
            return fakeClient
          }
        } as unknown as McpSdkSurface['Client'],
        StdioClientTransport: class {
          constructor(readonly params: unknown) {}
        } as unknown as McpSdkSurface['StdioClientTransport'],
      }),
    })
    registerMcpTools(registry, pool)
    await pool.listTools('demo')
    expect(registry.list().map((d) => d.name)).toEqual(['mcp_demo__echo'])
    pool.stopServer('demo')
    expect(registry.list()).toHaveLength(0)
  })
})
