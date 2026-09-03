/**
 * agentWiring.test.ts — todo29 wiring integration over REAL pieces
 * (PermissionEngine on :memory: sqlite, real fs/shell tools + real gate(),
 * real AgentSessions) with fake Electron surfaces (send callbacks) and a
 * scripted upstream fetch. Pins the contracts lanes 23-28 handed to 29:
 *   1. ask → dialog respond 'always' → engine.addRule (right kind/scope/rule;
 *      fs.shell = Bash(<prog>:*) prefix, others = the dialog's previewed text)
 *   2. gate allow → tool_call awaiting-permission → running → tool_result order
 *   3. abort cascade: cancel mid-ask settles the dialog, session aborts,
 *      no grant persists, second respond refused
 *   4. facade: baseUrl rewrite, duplicate ack, cancel-during-startup,
 *      upstream-resolution failure surfaces as an error event
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

import { migrate, type Database } from './storage/db'
import { PermissionEngine } from '../agent/policy/engine'
import type { AgentEvent, AgentMessage, JsonValue } from '../agent/runner/types'
import {
  buildAgentWiring,
  createAgentSurface,
  grantRuleText,
  previewFor,
  type AgentSurface,
  type AgentWiring,
} from './agentWiring'
import { AgentSessions } from '../agent/runner/sessions'
import type { PermissionRequestEvent } from './ipc/whitelist'

// --- scripted upstream helpers (same wire shape agentLoop.test.ts pins) -------

const enc = new TextEncoder()

function stream(...groups: JsonValue[][]): ReadableStream<Uint8Array> {
  const bytes: Uint8Array[] = []
  for (const group of groups) {
    for (const chunk of group) bytes.push(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`))
  }
  bytes.push(enc.encode('data: [DONE]\n\n'))
  let next = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < bytes.length) controller.enqueue(bytes[next++])
      else controller.close()
    },
  })
}
const textChunk = (content: string): JsonValue => ({ choices: [{ delta: { content }, index: 0 }] })
const toolStart = (id: string, name: string, args: string): JsonValue => ({
  choices: [
    { delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, index: 0 },
  ],
})

function stubFetch(...bodies: ReadableStream<Uint8Array>[]): { urls: string[] } {
  const urls: string[] = []
  let calls = 0
  vi.stubGlobal('fetch', async (url: unknown, init?: { body?: string }) => {
    urls.push(String(url))
    void (JSON.parse(String(init?.body)) as { messages: AgentMessage[] })
    const body = bodies[Math.min(calls, bodies.length - 1)]
    calls += 1
    return { ok: true, status: 200, text: async () => '', body }
  })
  return { urls }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function settled(agent: AgentSurface, id: string): Promise<void> {
  await waitFor(() => {
    const st = agent.status(id).status
    return st === null || st.state !== 'running'
  })
}

function collect(): { events: AgentEvent[]; emit: (e: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const startReq = {
  sessionId: 's1',
  baseUrl: 'http://127.0.0.1:1', // renderer placeholder — the facade must rewrite it
  model: 'qwen3',
  goal: 'do the thing',
}

// --- fixtures ----------------------------------------------------------------

let root: string
let db: Database
let engine: PermissionEngine
let sent: PermissionRequestEvent[]
let wiring: AgentWiring

function freshWiring(resolveUpstream: () => Promise<string> = async () => 'http://127.0.0.1:9'): AgentWiring {
  return buildAgentWiring({
    engine,
    workspaceRoot: root,
    jailMode: 'off',
    sendPermission: (event) => sent.push(event),
    sendTerm: () => undefined,
    resolveUpstream,
  })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agentwiring-'))
  writeFileSync(join(root, 'note.txt'), 'hello\n', 'utf8')
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  db = new BetterSqlite3(':memory:')
  migrate(db)
  engine = new PermissionEngine(db)
  sent = []
  wiring = freshWiring()
})
afterEach(() => {
  vi.unstubAllGlobals()
  db.close()
})

// --- 1+2: tool rounds through gate() + the dialog ----------------------------

describe('ask → respond → grant persistence + event order', () => {
  it('run_shell always-grant persists Bash(<prog>:*) allow and executes the call', async () => {
    const harness = collect()
    stubFetch(
      stream([toolStart('k1', 'run_shell', '{"command":"echo hi","cwd":"","timeoutMs":0}')]),
      stream([textChunk('done')]),
    )
    expect(wiring.agent.start({ ...startReq, sessionId: 'g1', goal: 'echo' }, harness.emit).ok).toBe(true)
    await waitFor(() => sent.length === 1)
    expect(sent[0]?.action.type).toBe('fs.shell')
    expect(sent[0]?.preview).toMatchObject({ kind: 'command', cmd: 'echo hi' })
    expect(wiring.permission.respond(sent[0]!.requestId, 'always')).toBe(true)
    await settled(wiring.agent, 'g1')
    const rules = engine.listRules({ kind: 'fs.shell' })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ rule: 'Bash(echo:*)', scope: 'always', decision: 'allow' })
    const result = harness.events.find((e) => e.type === 'tool_result')
    expect(result?.type === 'tool_result' && result.ok).toBe(true)
  })

  it('read_file ask: awaiting-permission → running order; session grant is memory-only', async () => {
    const harness = collect()
    const read = (id: string): JsonValue[] => [toolStart(id, 'read_file', '{"path":"note.txt"}')]
    stubFetch(stream(read('c1')), stream(read('c2')), stream([textChunk('finished')]))
    expect(wiring.agent.start({ ...startReq, sessionId: 's2' }, harness.emit).ok).toBe(true)
    await waitFor(() => sent.length === 1)
    const preview = sent[0]?.preview
    expect(preview !== undefined && preview.kind === 'diff' && (preview as { path: string }).path.replace(/\\/g, '/')).toBe(
      'note.txt',
    )
    expect(wiring.permission.respond(sent[0]!.requestId, 'session')).toBe(true)
    await settled(wiring.agent, 's2')

    const order = harness.events
      .filter((e) => e.type === 'plan' || e.type === 'tool_call' || e.type === 'tool_result')
      .map((e) => (e.type === 'tool_call' ? `tool_call:${e.phase}` : e.type))
    expect(order).toEqual([
      'plan',
      'tool_call:awaiting-permission',
      'tool_call:running',
      'tool_result',
      'plan',
      'tool_call:awaiting-permission', // runner always starts the card awaiting;
      'tool_call:running', // the session grant means no dialog before running
      'tool_result',
    ])
    // session-scope rules never hit disk: a fresh engine over the same db sees none
    expect(engine.listRules({ kind: 'fs.read' })[0]).toMatchObject({ scope: 'session', decision: 'allow' })
    expect(new PermissionEngine(db).listRules({ kind: 'fs.read' })).toHaveLength(0)
    // two rounds, but only ONE dialog: the session grant covered the second read
    expect(sent).toHaveLength(1)
    // gate audited every decision
    expect(engine.listAudit({ limit: 10 }).length).toBeGreaterThanOrEqual(2)
  })
})

// --- 3: abort cascade ---------------------------------------------------------

describe('abort cascade', () => {
  it('cancel while a dialog is pending settles the ask, marks the tool failed, ends aborted with no grant', async () => {
    const harness = collect()
    stubFetch(
      stream([toolStart('c1', 'read_file', '{"path":"note.txt"}')]),
      stream([textChunk('never reached')]),
    )
    wiring.agent.start({ ...startReq, sessionId: 's3' }, harness.emit)
    await waitFor(() => sent.length === 1)
    expect(wiring.agent.cancel('s3').cancelled).toBe(true)
    await settled(wiring.agent, 's3')
    const failed = harness.events.find((e) => e.type === 'tool_result')
    expect(failed?.type === 'tool_result' && !failed.ok).toBe(true)
    const last = harness.events[harness.events.length - 1]
    expect(last?.type === 'finished' && last.status === 'aborted').toBe(true)
    // the abort already settled the request: a late user answer is refused
    expect(wiring.permission.respond(sent[0]!.requestId, 'always')).toBe(false)
    expect(engine.listRules({ kind: 'fs.read' })).toHaveLength(0)
  })
})

// --- 4: facade ----------------------------------------------------------------

describe('agent facade', () => {
  it('rewrites the renderer placeholder with the resolved upstream URL', async () => {
    const spy = stubFetch(stream([textChunk('ok')]))
    wiring.agent.start({ ...startReq, sessionId: 's4' }, collect().emit)
    await settled(wiring.agent, 's4')
    expect(spy.urls).toEqual(['http://127.0.0.1:9/v1/chat/completions'])
  })

  it('upstream-resolution failure surfaces as an upstream-transport error event', async () => {
    wiring = freshWiring(async () => {
      throw new Error('llama-server unavailable (state: failed)')
    })
    const harness = collect()
    const ack = wiring.agent.start({ ...startReq, sessionId: 's5' }, harness.emit)
    expect(ack).toEqual({ ok: true, sessionId: 's5', started: true })
    await settled(wiring.agent, 's5')
    expect(harness.events).toContainEqual({
      type: 'error',
      sessionId: 's5',
      code: 'upstream-transport',
      message: 'llama-server unavailable (state: failed)',
      iteration: 0,
    })
  })

  it('duplicate ids rejected synchronously; cancel during startup never starts the loop', async () => {
    let fetchCalls = 0
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1
      return { ok: true, status: 200, text: async () => '', body: stream([textChunk('ok')]) }
    })
    let releaseResolve: () => void = () => {}
    const hold = new Promise<void>((r) => {
      releaseResolve = r
    })
    wiring = freshWiring(async () => {
      await hold
      return 'http://127.0.0.1:9'
    })
    const harness = collect()
    expect(wiring.agent.start({ ...startReq, sessionId: 's6' }, harness.emit).ok).toBe(true)
    expect(wiring.agent.start({ ...startReq, sessionId: 's6' }, harness.emit)).toEqual({
      ok: false,
      error: 'session-already-running',
    })
    // still resolving: status reports the pending snapshot, cancel kills it pre-start
    expect(wiring.agent.status('s6').status?.state).toBe('running')
    expect(wiring.agent.cancel('s6').cancelled).toBe(true)
    releaseResolve()
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCalls).toBe(0)
    expect(wiring.agent.status('s6').status).toBeNull()
    expect(harness.events).toHaveLength(0)
  })

  it('missing model is rejected without touching the upstream', () => {
    stubFetch(stream([textChunk('x')]))
    expect(wiring.agent.start({ ...startReq, sessionId: 's7', model: undefined }, collect().emit)).toEqual({
      ok: false,
      error: 'model-not-selected',
    })
  })

  it('cancel of a RUNNING loop reaches aborted (facade delegates to AgentSessions)', async () => {
    const sessions = new AgentSessions({ list: () => [], execute: async () => null })
    let streaming = false
    vi.stubGlobal('fetch', async (_url: unknown, init?: { signal?: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streaming = true
          const fail = (): void => {
            controller.error(new Error('aborted'))
          }
          if (init?.signal?.aborted) fail()
          else init?.signal?.addEventListener('abort', fail, { once: true })
        },
      })
      return { ok: true, status: 200, text: async () => '', body }
    })
    const surface = createAgentSurface(sessions, async () => 'http://127.0.0.1:9')
    const harness = collect()
    surface.start({ ...startReq, sessionId: 's8' }, harness.emit)
    await waitFor(() => streaming)
    expect(surface.cancel('s8').cancelled).toBe(true)
    await settled(surface, 's8')
    const last = harness.events[harness.events.length - 1]
    expect(last?.type === 'finished' && last.status === 'aborted').toBe(true)
  })
})

// --- pure builders ------------------------------------------------------------

describe('grant rule + preview builders', () => {
  it('grantRuleText matches the dialog previewed text for non-shell kinds', () => {
    const w = join('src', 'app.ts')
    expect(grantRuleText({ type: 'fs.read', target: { path: w } })).toBe('Read(src/app.ts)')
    expect(grantRuleText({ type: 'fs.write', target: { path: w } })).toBe('Edit(src/app.ts)')
    expect(grantRuleText({ type: 'net', target: { host: 'Example.COM', path: '/v1' } })).toBe('Net(example.com/v1)')
    expect(grantRuleText({ type: 'fs.shell', target: { cmd: 'git push origin main' } })).toBe('Bash(git:*)')
  })

  it('previewFor covers every kind without throwing', () => {
    expect(previewFor({ type: 'fs.read', target: { path: 'a' } }, root)).toMatchObject({ kind: 'diff', path: 'a' })
    expect(previewFor({ type: 'fs.shell', target: 'dir' }, root)).toMatchObject({ kind: 'command', cmd: 'dir' })
    expect(previewFor({ type: 'net', target: { host: 'x.io' } }, root)).toEqual({ kind: 'net', host: 'x.io' })
    expect(previewFor({ type: 'mcp', target: { server: 's', tool: 't' } }, root)).toMatchObject({ kind: 'command' })
  })
})
