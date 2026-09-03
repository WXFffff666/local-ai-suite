/**
 * pool.test.ts — McpPool lifecycle unit suite (todo40): fake McpSdkSurface
 * injection (no module mocking — the deps seam is the fake point), fake
 * timers for the 500ms·2^(n-1) backoff, and the shared fakePermission port.
 * Pins: gate-before-spawn, lazy start, tools caching + onToolsChanged, the
 * 3-restart budget → terminal 'failed', restartServer budget clear, listener
 * fanout, and honest McpError codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePermission } from '../agent/tools/fs/testutils'
import { PermissionDeniedError } from '../agent/tools/fs/gating'
import type { ToolExecutionContext } from '../agent/runner/types'
import { McpError } from './errors'
import { McpPool, type McpPoolDeps } from './pool'
import type { McpSdkClient, McpSdkSurface, McpServersMap, McpStatusEvent, McpToolInfo } from './types'

// --- fake SDK ------------------------------------------------------------------

type FakeClient = McpSdkClient & {
  readonly id: number
  closed: boolean
  calls: { name: string; arguments?: Record<string, unknown> }[]
  tools: McpToolInfo[]
}

type FakeSdk = {
  surface: McpSdkSurface
  clients: FakeClient[]
  connectMode: 'ok' | 'reject'
  spawnCount: () => number
}

function makeFakeSdk(tools: McpToolInfo[]): FakeSdk {
  let seq = 0
  const clients: FakeClient[] = []
  const sdk: FakeSdk = {
    clients,
    connectMode: 'ok',
    spawnCount: () => clients.length,
    surface: {
      Client: class {
        constructor() {
          seq += 1
          const inner: FakeClient = {
            id: seq,
            closed: false,
            calls: [],
            tools: [...tools],
            connect: async () => {
              if (sdk.connectMode === 'reject') throw new Error('spawn ENOENT')
            },
            close: async () => {
              inner.closed = true
            },
            listTools: async () => ({ tools: inner.tools.map((t) => ({ name: t.name, ...(t.description === undefined ? {} : { description: t.description }), ...(t.inputSchema === undefined ? {} : { inputSchema: t.inputSchema }) })) }),
            callTool: async (params) => {
              inner.calls.push({ name: params.name, ...(params.arguments === undefined ? {} : { arguments: params.arguments }) })
              return { content: [{ type: 'text', text: `ok:${params.name}` }] }
            },
            onclose: undefined,
          }
          clients.push(inner)
          return inner
        }
      } as unknown as McpSdkSurface['Client'],
      StdioClientTransport: class {
        constructor(readonly params: unknown) {}
      } as unknown as McpSdkSurface['StdioClientTransport'],
    },
  }
  return sdk
}

const ECHO: McpToolInfo = { name: 'echo', description: 'echoes', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }

function ctx(): ToolExecutionContext {
  return { callId: 'call-1', signal: new AbortController().signal, reportPhase: () => undefined }
}

type Harness = {
  pool: McpPool
  sdk: FakeSdk
  perm: ReturnType<typeof fakePermission>
  events: McpStatusEvent[]
  toolChanges: [string, number][]
}

let currentServers: McpServersMap

function makeHarness(opts: { extra?: Partial<McpPoolDeps> } = {}): Harness {
  const sdk = makeFakeSdk([ECHO])
  const perm = fakePermission()
  const events: McpStatusEvent[] = []
  const toolChanges: [string, number][] = []
  const pool = new McpPool({
    readServers: () => currentServers,
    permission: perm.port,
    loadSdk: async () => sdk.surface,
    onToolsChanged: (name, tools) => toolChanges.push([name, tools.length]),
    ...opts.extra,
  })
  pool.subscribe((ev) => events.push(ev))
  return { pool, sdk, perm, events, toolChanges }
}

beforeEach(() => {
  vi.useFakeTimers()
  currentServers = { demo: { command: 'node', args: ['server.js'], enabled: true } }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('McpPool — gating', () => {
  it('denies BEFORE spawn: policy-deny throws PermissionDeniedError and no client is created', async () => {
    const h = makeHarness()
    h.perm.decision = 'deny'
    await expect(h.pool.callTool('demo', 'echo', {}, ctx())).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(h.sdk.spawnCount()).toBe(0)
    expect(h.perm.audits).toHaveLength(1)
    expect(h.perm.audits[0].action).toEqual({ type: 'mcp', target: 'demo:echo' })
  })

  it('allow policy gates the call, then spawns lazily and executes once', async () => {
    const h = makeHarness()
    const result = await h.pool.callTool('demo', 'echo', { message: 'hi' }, ctx())
    expect(h.sdk.spawnCount()).toBe(1)
    const [client] = h.sdk.clients
    expect(client.calls).toEqual([{ name: 'echo', arguments: { message: 'hi' } }])
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok:echo' }] })
  })

  it('user-deny via ask also denies pre-spawn', async () => {
    const h = makeHarness()
    h.perm.decision = 'ask'
    h.perm.userAnswer = 'deny'
    await expect(h.pool.callTool('demo', 'echo', {}, ctx())).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(h.sdk.spawnCount()).toBe(0)
  })

  it('unknown / disabled servers fail with the honest codes', async () => {
    const h = makeHarness()
    await expect(h.pool.callTool('nope', 'x', {}, ctx())).rejects.toThrow(McpError)
    currentServers = { demo: { command: 'node', enabled: false } }
    await expect(h.pool.listTools('demo')).rejects.toMatchObject({ code: 'server-disabled' })
  })
})

describe('McpPool — lazy lifecycle', () => {
  it('nothing spawns at construction; listTools starts once and caches', async () => {
    const h = makeHarness()
    expect(h.pool.status()[0].state).toBe('stopped')
    const tools = await h.pool.listTools('demo')
    expect(tools).toHaveLength(1)
    await h.pool.listTools('demo')
    expect(h.sdk.spawnCount()).toBe(1)
    expect(h.toolChanges).toEqual([['demo', 1]])
  })

  it('concurrent ensureStarted dedupes into a single spawn', async () => {
    const h = makeHarness()
    await Promise.all([h.pool.ensureStarted('demo'), h.pool.ensureStarted('demo'), h.pool.listTools('demo')])
    expect(h.sdk.spawnCount()).toBe(1)
  })

  it('stopServer closes the client, clears tools ([] change fires), no crash reaction', async () => {
    const h = makeHarness()
    await h.pool.ensureStarted('demo')
    h.pool.stopServer('demo')
    await vi.waitFor(() => expect(h.sdk.clients[0].closed).toBe(true))
    expect(h.toolChanges.at(-1)).toEqual(['demo', 0])
    expect(h.pool.status()[0].state).toBe('stopped')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sdk.spawnCount()).toBe(1) // no ghost restart after a manual stop
  })
})

describe('McpPool — crash backoff → terminal failed', () => {
  function crash(client: FakeClient): void {
    client.onclose?.()
  }

  it('one crash schedules backoff (500ms) and restarts once; a clean call then reuses the new client', async () => {
    const h = makeHarness()
    await h.pool.ensureStarted('demo')
    crash(h.sdk.clients[0])
    expect(h.pool.status()[0].state).toBe('backoff')
    await vi.advanceTimersByTimeAsync(500)
    expect(h.sdk.spawnCount()).toBe(2)
    expect(h.pool.status()[0].state).toBe('running')
    await h.pool.callTool('demo', 'echo', {}, ctx())
    expect(h.sdk.clients[1].calls).toHaveLength(1)
    expect(h.sdk.spawnCount()).toBe(2)
  })

  it('3 restart tries then terminal failed — further calls throw server-failed, listeners saw backoff×3 + failed', async () => {
    const h = makeHarness()
    await h.pool.ensureStarted('demo') // client 1
    for (let i = 0; i < 3; i += 1) {
      crash(h.sdk.clients.at(-1)!)
      await vi.advanceTimersByTimeAsync(5000) // covers 500/1000/2000 delays
    }
    expect(h.sdk.spawnCount()).toBe(4) // 1 initial + 3 restart tries
    expect(h.pool.status()[0].state).toBe('running')
    crash(h.sdk.clients.at(-1)!) // the 4th death finds the budget spent
    expect(h.pool.status()[0].state).toBe('failed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sdk.spawnCount()).toBe(4) // terminal: nothing more fires
    await expect(h.pool.ensureStarted('demo')).rejects.toMatchObject({ code: 'server-failed' })
    const states = h.events.map((e) => e.state)
    expect(states.filter((s) => s === 'backoff')).toHaveLength(3)
    expect(states.at(-1)).toBe('failed')
    expect(h.pool.status()[0].lastError).toBeTruthy()
    // tools were dropped for the registry bridge on the way down
    expect(h.toolChanges.at(-1)).toEqual(['demo', 0])
  })

  it('failed is terminal even across timers; restartServer clears the budget', async () => {
    const h = makeHarness()
    await h.pool.ensureStarted('demo')
    for (let i = 0; i < 4; i += 1) {
      crash(h.sdk.clients.at(-1)!)
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(h.pool.status()[0].state).toBe('failed')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.sdk.spawnCount()).toBe(4) // nothing fires after terminal failed
    await h.pool.restartServer('demo')
    expect(h.sdk.spawnCount()).toBe(5)
    expect(h.pool.status()[0].state).toBe('running')
    expect(h.pool.status()[0].lastError).toBeNull()
  })

  it('a call landing mid-backoff restarts NOW instead of waiting', async () => {
    const h = makeHarness()
    await h.pool.ensureStarted('demo')
    crash(h.sdk.clients[0])
    const p = h.pool.ensureStarted('demo')
    await expect(p).resolves.toBeUndefined()
    expect(h.sdk.spawnCount()).toBe(2)
  })

  it('never-startable command burns the budget and converges to failed (no per-call infinite retry)', async () => {
    const h = makeHarness()
    h.sdk.connectMode = 'reject'
    await expect(h.pool.ensureStarted('demo')).rejects.toMatchObject({ code: 'server-start-failed' })
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(5000)
    expect(h.pool.status()[0].state).toBe('failed')
    expect(h.sdk.spawnCount()).toBe(4)
  })
})

describe('McpPool — views & listeners', () => {
  it('status views env KEYS only (values never surface)', async () => {
    currentServers = { demo: { command: 'node', env: { TOKEN: '***' }, enabled: true } }
    const h = makeHarness()
    const view = h.pool.status()[0]
    expect(view.envKeys).toEqual(['TOKEN'])
    expect(JSON.stringify(view)).not.toContain('s3cret')
    expect(view.toolCount).toBeNull()
    await h.pool.listTools('demo')
    expect(h.pool.status()[0].toolCount).toBe(1)
  })

  it('unsubscribe stops the fanout; a throwing listener never breaks the lifecycle', async () => {
    const h = makeHarness()
    let heard = 0
    const off = h.pool.subscribe(() => {
      heard += 1
      throw new Error('bad listener')
    })
    await h.pool.ensureStarted('demo')
    off()
    const before = heard
    h.pool.stopServer('demo')
    expect(heard).toBe(before)
    expect(h.pool.status()[0].state).toBe('stopped')
  })

  it('startEnabled kicks only enabled servers, swallowing per-server start noise', async () => {
    currentServers = { on: { command: 'node', enabled: true }, off: { command: 'node', enabled: false } }
    const h = makeHarness()
    h.sdk.connectMode = 'reject'
    h.pool.startEnabled()
    await vi.waitFor(() => expect(h.sdk.spawnCount()).toBe(1))
    expect(h.pool.status().map((s) => s.name).sort()).toEqual(['off', 'on'])
  })
})
