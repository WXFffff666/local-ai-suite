/**
 * ipc.test.ts — mcp:* handler factories (todo40): zod boundary (bad names /
 * stray keys → the stable 400-shape), config persistence through the storage
 * seam, pool side-effect ordering (upsert ⇒ stop+start, disable ⇒ stop), and
 * the callTool error projection (PermissionDeniedError → 'permission-denied',
 * McpError → its code, no pool → 'not-ready').
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PermissionDeniedError } from '../agent/tools/fs/gating'
import { McpError } from './errors'
import { createMcpHandlers, type McpPoolSurface } from './ipc'
import type { McpServerView } from './types'

// --- in-memory config store (the storage/config.ts seam) ------------------------

let store: Record<string, unknown> = {}

vi.mock('../main/storage/config', () => ({
  getConfig: () => store,
  setConfig: (partial: Record<string, unknown>) => {
    store = { ...store, ...partial }
    return store
  },
}))

function view(name: string, over: Partial<McpServerView> = {}): McpServerView {
  return {
    name, command: 'node', args: [], envKeys: [], enabled: true,
    state: 'running', toolCount: 1, lastError: null, ...over,
  }
}

function fakePool(): McpPoolSurface & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    status: vi.fn(() =>
      Object.keys((store.mcpServers ?? {}) as Record<string, unknown>).map((n) => view(n)),
    ) as unknown as McpPoolSurface['status'],
    listTools: vi.fn(async () => [{ name: 'echo', description: 'e' }]) as unknown as McpPoolSurface['listTools'],
    callTool: vi.fn(async () => ({ content: [] })) as unknown as McpPoolSurface['callTool'],
    ensureStarted: vi.fn(async () => undefined) as unknown as McpPoolSurface['ensureStarted'],
    restartServer: vi.fn(async () => undefined) as unknown as McpPoolSurface['restartServer'],
    stopServer: vi.fn(() => calls.push('stop')) as unknown as McpPoolSurface['stopServer'],
  }
}

const ctx = { send: vi.fn() }

describe('mcp ipc', () => {
  beforeEach(() => {
    store = { mcpServers: { demo: { command: 'node', args: ['s.js'], env: { TOKEN: '***' }, enabled: true } } }
  })

  it('no pool wired → honest not-ready on every channel', async () => {
    const h = createMcpHandlers({ pool: () => null })
    const payloads: Record<string, unknown> = {
      'mcp:listServers': {},
      'mcp:upsertServer': { name: 'demo', command: 'node' },
      'mcp:removeServer': { name: 'demo' },
      'mcp:setEnabled': { name: 'demo', enabled: true },
      'mcp:listTools': { name: 'demo' },
      'mcp:callTool': { name: 'demo', tool: 'echo' },
    }
    for (const channel of Object.keys(h) as Array<keyof typeof h>) {
      const res = (await h[channel]([payloads[channel]], ctx)) as { ok: boolean; error?: string }
      expect(res).toEqual({ ok: false, error: 'not-ready' })
    }
  })

  it('listServers returns the pool view', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    const res = (await h['mcp:listServers']([{}], ctx)) as { ok: true; servers: McpServerView[] }
    expect(res.ok).toBe(true)
    expect(res.servers[0].name).toBe('demo')
  })

  it('upsertServer: bad name → 400-shape; valid → config write + stop + (enabled) start', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    const bad = (await h['mcp:upsertServer']([{ name: 'bad name!', command: 'x' }], ctx)) as { ok: boolean; error: string }
    expect(bad.error).toBe('invalid-payload')
    const ok = (await h['mcp:upsertServer']([{ name: 'new', command: 'node', args: ['a'], env: { K: 'v' } }], ctx)) as { ok: boolean }
    expect(ok.ok).toBe(true)
    const servers = (store.mcpServers ?? {}) as Record<string, { command: string }>
    expect(Object.keys(servers).sort()).toEqual(['demo', 'new'])
    expect(pool.stopServer).toHaveBeenCalledWith('new')
    expect(pool.ensureStarted).toHaveBeenCalledWith('new')
  })

  it('upsertServer disabled → no start; stopServer still applied', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    await h['mcp:upsertServer']([{ name: 'demo', command: 'node', enabled: false }], ctx)
    expect(pool.ensureStarted).not.toHaveBeenCalled()
    expect(pool.stopServer).toHaveBeenCalled()
  })

  it('removeServer drops the config entry and stops the runtime', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    const res = (await h['mcp:removeServer']([{ name: 'demo' }], ctx)) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(store.mcpServers).toEqual({})
    expect(pool.stopServer).toHaveBeenCalledWith('demo')
  })

  it('setEnabled false stops (config kept, flag flipped); true restarts via budget-cleared path', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    await h['mcp:setEnabled']([{ name: 'demo', enabled: false }], ctx)
    expect((store.mcpServers as Record<string, { enabled: boolean }>).demo.enabled).toBe(false)
    expect(pool.stopServer).toHaveBeenCalledWith('demo')
    await h['mcp:setEnabled']([{ name: 'demo', enabled: true }], ctx)
    expect(pool.restartServer).toHaveBeenCalledWith('demo')
  })

  it('setEnabled unknown server → server-not-found', async () => {
    const h = createMcpHandlers({ pool: () => fakePool() })
    const res = (await h['mcp:setEnabled']([{ name: 'ghost', enabled: true }], ctx)) as { ok: boolean; error: string }
    expect(res.error).toBe('server-not-found')
  })

  it('listTools lazy-starts and projects name+description only', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    const res = (await h['mcp:listTools']([{ name: 'demo' }], ctx)) as { ok: true; tools: unknown[] }
    expect(pool.ensureStarted).not.toBeUndefined()
    expect(res.tools).toEqual([{ name: 'echo', description: 'e' }])
  })

  it('callTool goes through the pool (gated funnel) and projects errors honestly', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    const ok = (await h['mcp:callTool']([{ name: 'demo', tool: 'echo', args: { a: 1 } }], ctx)) as { ok: boolean }
    expect(ok.ok).toBe(true)
    expect(pool.callTool).toHaveBeenCalledWith('demo', 'echo', { a: 1 }, expect.objectContaining({ callId: 'mcp-debug' }))

    ;(pool.callTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new PermissionDeniedError({ type: 'mcp', target: 'demo:echo' }, 'user'))
    const denied = (await h['mcp:callTool']([{ name: 'demo', tool: 'echo' }], ctx)) as { ok: boolean; error: string }
    expect(denied.error).toBe('permission-denied')

    ;(pool.callTool as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new McpError('server-failed', 'boom'))
    const failed = (await h['mcp:callTool']([{ name: 'demo', tool: 'echo' }], ctx)) as { ok: boolean; error: string; detail?: string }
    expect(failed.error).toBe('server-failed')
    expect(failed.detail).toContain('boom')
  })

  it('callTool payload is zod-gated (unknown keys / empty tool rejected before the pool)', async () => {
    const pool = fakePool()
    const h = createMcpHandlers({ pool: () => pool })
    const res = (await h['mcp:callTool']([{ name: 'demo', tool: '' }], ctx)) as { ok: boolean; error: string }
    expect(res.error).toBe('invalid-payload')
    expect(pool.callTool).not.toHaveBeenCalled()
  })
})
