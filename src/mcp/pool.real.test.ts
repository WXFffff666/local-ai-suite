/**
 * pool.real.test.ts — the todo40 hands-on proof: the REAL @modelcontextprotocol
 * SDK (via the default lazy loadMcpSdk) against a REAL child process
 * speaking raw JSON-RPC-over-stdio (tests/fixtures/mcp-fixture-server.mjs,
 * node built-ins only). Covers initialize → tools/list → gated tools/call →
 * crash → auto-restart recovery. Real timers, generous budgets (spawn +
 * handshake dominate); this is the integration rung of the pyramid.
 */
import { join } from 'path'

import { afterEach, describe, expect, it } from 'vitest'

import { fakePermission } from '../agent/tools/fs/testutils'
import type { ToolExecutionContext } from '../agent/runner/types'
import { McpPool } from './pool'
import type { McpServersMap } from './types'

// vitest's root (project root) — the fixture lives at tests/fixtures/ relative to it.
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'mcp-fixture-server.mjs')

let pool: McpPool | null = null

afterEach(() => {
  pool?.stopAll()
  pool = null
})

function realPool(): McpPool {
  const servers: McpServersMap = {
    fixture: { command: process.execPath, args: [FIXTURE], enabled: true },
  }
  const p = new McpPool({
    readServers: () => servers,
    permission: fakePermission().port, // decision default 'allow'
  })
  pool = p
  return p
}

function ctx(): ToolExecutionContext {
  return { callId: 'real-1', signal: AbortSignal.timeout(30_000), reportPhase: () => undefined }
}

describe('McpPool — real SDK over a real stdio child process', () => {
  it('initialize → tools/list returns the fixture catalog', async () => {
    const tools = await realPool().listTools('fixture')
    expect(tools.map((t) => t.name).sort()).toEqual(['crash', 'echo', 'loose'])
    expect(pool?.status()[0].state).toBe('running')
    expect(pool?.status()[0].toolCount).toBe(3)
  }, 30_000)

  it('gated tools/call round-trips through the wire protocol', async () => {
    const p = realPool()
    const result = (await p.callTool('fixture', 'echo', { message: 'ping' }, ctx())) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0].text).toBe('echo:{"message":"ping"}')
  }, 30_000)

  it('crash (server exits mid-session) → backoff auto-restart → tools available again', async () => {
    const p = realPool()
    await p.listTools('fixture')
    const first = p.status()[0]
    // 'crash' exits(7) WITHOUT answering: the call rejects, onclose fires.
    await expect(p.callTool('fixture', 'crash', {}, ctx())).rejects.toThrow(/crash|exit|transport|closed/i)
    // 500ms backoff + a fresh handshake inside — poll with a real deadline.
    const deadline = Date.now() + 20_000
    for (;;) {
      const st = p.status()[0]
      if (st.state === 'running' && (st.toolCount ?? 0) === 3) break
      if (Date.now() > deadline) throw new Error(`never recovered (state: ${st.state}, lastError: ${st.lastError})`)
      await new Promise((r) => setTimeout(r, 150))
    }
    const result = (await p.callTool('fixture', 'echo', { message: 'again' }, ctx())) as {
      content: { text: string }[]
    }
    expect(result.content[0].text).toBe('echo:{"message":"again"}')
    expect(p.status()[0].name).toBe(first.name)
  }, 40_000)

  it('stopAll kills the child (no orphan processes)', async () => {
    const p = realPool()
    await p.listTools('fixture')
    const viewBefore = p.status()[0]
    expect(viewBefore.state).toBe('running')
    p.stopAll()
    await new Promise((r) => setTimeout(r, 300))
    // The pool no longer reports the server as running; a fresh list would respawn.
    expect(p.status()[0].state).not.toBe('running')
  }, 30_000)
})
