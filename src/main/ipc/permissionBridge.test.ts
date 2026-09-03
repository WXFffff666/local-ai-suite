/**
 * todo25 — permission bridge unit tests (pure, no Electron).
 * Contract under test: requestDecision emits 'permission:request'-shaped
 * payloads and resolves exactly one of once|session|always|deny; 120 s
 * auto-deny (never hangs the agent); abort-signal -> deny; respond rejects
 * unknown ids, stale (settled) ids and off-enum choices; onGrant fires only
 * for the persistent scopes (session/always) — the bridge itself stays
 * engine-agnostic (todo29 wires engine.addRule through the callback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPermissionBridge, PERMISSION_DEFAULT_TIMEOUT_MS } from './permissionBridge'
import type { PermissionGrantChoice, PermissionPreview, PermissionRequestEvent } from './whitelist'
import type { Assessment, PermissionAction } from '../../agent/policy/types'

const action: PermissionAction = { type: 'fs.write', target: { path: 'src/app.ts' } }
const assessment: Assessment = { decision: 'ask', rule: null, ruleId: null, scope: null }
const preview: PermissionPreview = { kind: 'diff', path: 'src/app.ts', oldText: 'a\n', newText: 'b\n' }

function makeBridge(opts?: { timeoutMs?: number }) {
  const sent: PermissionRequestEvent[] = []
  const grants: { choice: 'session' | 'always'; action: PermissionAction; assessment: Assessment }[] = []
  let seq = 0
  const bridge = createPermissionBridge({
    send: (event) => sent.push(event),
    onGrant: (grant) => grants.push(grant),
    newRequestId: () => `req-${(seq += 1)}`,
    timeoutMs: opts?.timeoutMs
  })
  return { bridge, sent, grants }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('requestDecision -> respond matrix', () => {
  const choices = ['once', 'session', 'always', 'deny'] as const satisfies readonly PermissionGrantChoice[]

  for (const choice of choices) {
    it(`respond('${choice}') resolves the pending promise with '${choice}'`, async () => {
      const { bridge, sent } = makeBridge()
      const p = bridge.requestDecision({ action, assessment, preview })
      expect(sent).toHaveLength(1)
      expect(bridge.respond('req-1', choice)).toBe(true)
      await expect(p).resolves.toBe(choice)
    })
  }

  it('emits the full request payload (id, action, assessment, preview, timeout budget)', () => {
    const { bridge, sent } = makeBridge()
    void bridge.requestDecision({ action, assessment, preview })
    const event = sent[0]
    expect(event).toBeDefined()
    expect(event?.requestId).toBe('req-1')
    expect(event?.action).toEqual(action)
    expect(event?.assessment).toEqual(assessment)
    expect(event?.preview).toEqual(preview)
    expect(event?.timeoutMs).toBe(PERMISSION_DEFAULT_TIMEOUT_MS)
    expect(typeof event?.requestedAt).toBe('number')
  })

  it('grant persistence callback fires for session/always only, never once/deny', async () => {
    const { bridge, grants } = makeBridge()
    const p1 = bridge.requestDecision({ action, assessment, preview })
    bridge.respond('req-1', 'session')
    await p1
    const p2 = bridge.requestDecision({ action, assessment, preview })
    bridge.respond('req-2', 'always')
    await p2
    const p3 = bridge.requestDecision({ action, assessment, preview })
    bridge.respond('req-3', 'once')
    await p3
    const p4 = bridge.requestDecision({ action, assessment, preview })
    bridge.respond('req-4', 'deny')
    await p4
    expect(grants).toHaveLength(2)
    expect(grants[0]?.choice).toBe('session')
    expect(grants[1]?.choice).toBe('always')
    expect(grants[1]?.action).toEqual(action)
  })
})

describe('auto-deny and abort (never hang the agent)', () => {
  it('timeout resolves deny and closes the request (no grant)', async () => {
    const { bridge, grants } = makeBridge({ timeoutMs: 5_000 })
    const p = bridge.requestDecision({ action, assessment, preview })
    vi.advanceTimersByTime(5_000)
    await expect(p).resolves.toBe('deny')
    expect(grants).toHaveLength(0)
    // the settled id rejects late responses
    expect(bridge.respond('req-1', 'always')).toBe(false)
  })

  it('abort BEFORE the request: deny resolves synchronously and nothing is sent', async () => {
    const { bridge, sent } = makeBridge()
    const controller = new AbortController()
    controller.abort()
    const p = bridge.requestDecision({ action, assessment, preview, signal: controller.signal })
    await expect(p).resolves.toBe('deny')
    expect(sent).toHaveLength(0)
  })

  it('abort DURING the request: pending promise resolves deny, later respond is refused', async () => {
    const { bridge, sent } = makeBridge()
    const controller = new AbortController()
    const p = bridge.requestDecision({ action, assessment, preview, signal: controller.signal })
    expect(sent).toHaveLength(1)
    controller.abort()
    await expect(p).resolves.toBe('deny')
    expect(bridge.respond('req-1', 'once')).toBe(false)
  })

  it('abort listener is removed on respond (settled promise unaffected by later abort)', async () => {
    const { bridge } = makeBridge()
    const controller = new AbortController()
    const p = bridge.requestDecision({ action, assessment, preview, signal: controller.signal })
    bridge.respond('req-1', 'once')
    await expect(p).resolves.toBe('once')
    controller.abort()
    await expect(p).resolves.toBe('once')
  })
})

describe('respond input validation (pending + choice membership)', () => {
  it('unknown requestId is refused', () => {
    const { bridge } = makeBridge()
    expect(bridge.respond('nope', 'once')).toBe(false)
  })

  it('double respond: first wins, second is refused', async () => {
    const { bridge } = makeBridge()
    const p = bridge.requestDecision({ action, assessment, preview })
    expect(bridge.respond('req-1', 'once')).toBe(true)
    expect(bridge.respond('req-1', 'always')).toBe(false)
    await expect(p).resolves.toBe('once')
  })

  it('off-enum choice is refused and leaves the request pending', async () => {
    const { bridge } = makeBridge()
    const p = bridge.requestDecision({ action, assessment, preview })
    expect(bridge.respond('req-1', 'yolo' as PermissionGrantChoice)).toBe(false)
    expect(bridge.respond('req-1', '')).toBe(false)
    expect(bridge.respond('req-1', 'once')).toBe(true)
    await expect(p).resolves.toBe('once')
  })

  it('concurrent requests are independent (each id settles its own promise)', async () => {
    const { bridge, sent } = makeBridge()
    const pA = bridge.requestDecision({ action, assessment, preview })
    const pB = bridge.requestDecision({ action, assessment, preview })
    expect(sent.map((e) => e.requestId)).toEqual(['req-1', 'req-2'])
    bridge.respond('req-2', 'always')
    bridge.respond('req-1', 'deny')
    await expect(pA).resolves.toBe('deny')
    await expect(pB).resolves.toBe('always')
  })
})
