/**
 * index.test.ts — todo28 end-to-end: the run_shell tool driven through the
 * real ToolRegistry with the fake PermissionPort (todo27's testutils), REAL
 * child spawns, and the jail/kill chain exercised against live processes.
 *
 * Acceptance matrix pinned here (plan todo28 + task spec):
 *   echo ok / CJK UTF-8 roundtrip (real spawn) / exit-code propagation /
 *   timeout kill + NO orphan (tasklist/kill-0 assert) / gate deny => no spawn /
 *   abort mid-run / chunk streaming order + cap / cwd fence / program list.
 *
 * Timing: Windows powershell cold-start is ~1-2 s, so process tests carry
 * generous per-test timeouts and the "long-running" commands hang for 2 min —
 * tests only ever end them via the kill paths under test, never by racing.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createShellTools, registerShellTools, SHELL_TAIL_BYTES } from './index'
import { fakePermission, type FakePermission } from '../fs/testutils'
import { ToolRegistry } from '../registry'
import { PermissionDeniedError, FsPathError } from '../fs/gating'
import { pidAlive } from './testutils'
import type { ShellChunk, ShellResult } from './types'
import type { ToolExecutionContext } from '../../runner/types'

const isWin = process.platform === 'win32'

/** Platform-appropriate commands. Single-quoted bodies cross both shells safely. */
const cmd = {
  echoHello: isWin ? `Write-Output 'hello'` : `echo hello`,
  echoCJK: isWin ? `Write-Output '中文'` : `echo 中文`,
  hang: `node -e 'setTimeout(()=>{},120000)'`,
  // NOTE the quoting: Windows PowerShell 5.1 strips embedded double quotes
  // when forwarding native-command arguments (pwsh 7.3 fixed it), so the
  // win32 bodies quote INSIDE with single quotes. This is the documented
  // residual risk in process.ts — shell source is the model's responsibility.
  big: isWin
    ? `node -e "process.stdout.write('x'.repeat(200000))"`
    : `node -e 'process.stdout.write("x".repeat(200000))'`,
  /** pipes a real shell pipeline (tokenizer must NOT touch the string) */
  piped: isWin ? `Write-Output 'a','b','c' | Select-Object -Last 1` : `printf 'a\\nb\\nc\\n' | tail -n 1`,
  /** spawns a tracked grandchild, prints its pid, then waits on it */
  grandchild: isWin
    ? `$g = Start-Process node -ArgumentList '-e','setTimeout(()=>{},120000)' -PassThru; Write-Output "GPID=$($g.Id)"; Wait-Process -Id $g.Id`
    : `sleep 120 & echo "GPID=$!"; wait`,
}

const HANG_MS = 25_000

let root: string
let permission: FakePermission
let registry: ToolRegistry
let chunks: ShellChunk[]

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    callId: 'c-shell',
    signal: new AbortController().signal,
    reportPhase: vi.fn(),
    ...overrides,
  }
}

function makeRegistry(deps?: {
  jailMode?: 'native' | 'off'
  defaultTimeoutMs?: number
  maxOutputBytes?: number
  allowedPrograms?: readonly string[] | null
}): void {
  registry = new ToolRegistry()
  registerShellTools(registry, {
    workspaceRoot: root,
    permission: permission.port,
    jailMode: deps?.jailMode ?? 'native',
    defaultTimeoutMs: deps?.defaultTimeoutMs,
    maxOutputBytes: deps?.maxOutputBytes,
    allowedPrograms: deps?.allowedPrograms,
    onChunk: (_callId, chunk) => {
      chunks.push(chunk)
    },
  })
}

function execute(args: { command: string; cwd?: string; timeoutMs?: number }, execCtx?: ToolExecutionContext): Promise<unknown> {
  return registry.execute('run_shell', JSON.stringify({ cwd: '', timeoutMs: 0, ...args }), execCtx ?? ctx())
}

function emittedText(stream: 'stdout' | 'stderr'): string {
  return chunks.filter((c) => c.stream === stream).map((c) => c.data).join('')
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shelltools-'))
})
afterAll(() => {
  // Windows: a just-killed child's cwd can transiently lock the temp root
  // (EPERM). Bounded retry, final failure tolerated — it is a temp dir.
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // best effort, OS reaps %TEMP%
  }
})

beforeEach(() => {
  permission = fakePermission()
  permission.decision = 'allow'
  chunks = []
})

describe('registry contract', () => {
  it('registers exactly run_shell with a strict all-required schema', () => {
    makeRegistry()
    expect(registry.list().map((d) => d.name)).toEqual(['run_shell'])
    const params = registry.list()[0]?.parameters as Record<string, unknown>
    expect(params['type']).toBe('object')
    expect(params['additionalProperties']).toBe(false)
    expect(Object.keys(params['properties'] as object).sort()).toEqual(['command', 'cwd', 'timeoutMs'])
    expect([...(params['required'] as string[])].sort()).toEqual(['command', 'cwd', 'timeoutMs'])
  })

  it('createShellTools is the raw registration list consumed by registerShellTools', () => {
    const tools = createShellTools({ workspaceRoot: root, permission: permission.port, jailMode: 'native' })
    expect(tools.map((t) => t.def.name)).toEqual(['run_shell'])
  })
})

describe('exec matrix (real spawns)', () => {
  beforeEach(() => makeRegistry({ defaultTimeoutMs: 20_000 }))

  it(
    'echo exit 0 with streamed chunks and tail text',
    async () => {
      const result = (await execute({ command: cmd.echoHello })) as ShellResult
      expect(result.code).toBe(0)
      expect(result.stdoutTail).toContain('hello')
      expect(result.timedOut).toBe(false)
      expect(result.killed).toBe(false)
      expect(result.truncated).toBe(false)
      expect(emittedText('stdout')).toContain('hello')
    },
    HANG_MS,
  )

  it(
    'CJK roundtrips as UTF-8 through the forced-codepage prefix',
    async () => {
      const result = (await execute({ command: cmd.echoCJK })) as ShellResult
      expect(result.code).toBe(0)
      expect(result.stdoutTail).toContain('中文')
      expect(emittedText('stdout')).toContain('中文')
    },
    HANG_MS,
  )

  it('propagates a non-zero exit code as data, not as a rejection', async () => {
    const result = (await execute({ command: isWin ? 'exit 3' : 'exit 3' })) as ShellResult
    expect(result.code).toBe(3)
  })

  it(
    'keeps pipe characters intact in the command string (no tokenizer rewrite)',
    async () => {
      const result = (await execute({ command: cmd.piped })) as ShellResult
      expect(result.code).toBe(0)
      expect(result.stdoutTail.trim().endsWith('c')).toBe(true)
    },
    HANG_MS,
  )

  it('surfaces a missing program as a non-zero exit + shell error text (the shell itself always starts)', async () => {
    const result = (await execute({ command: 'definitely-not-a-real-program-xyz --version' })) as ShellResult
    // win32: powershell reports CommandNotFound (exit 1); posix: sh reports 127.
    expect(result.code).not.toBe(0)
    expect(result.stderrTail.length + result.stdoutTail.length).toBeGreaterThan(0)
  })
})

describe('timeout + orphan reaping (jail-first, tree-kill fallback)', () => {
  it(
    'kills a real long-running command tree: no orphan survives the timeout',
    async () => {
      makeRegistry({ defaultTimeoutMs: 6_000 })
      const result = (await execute({ command: cmd.grandchild })) as ShellResult
      expect(result.timedOut).toBe(true)
      expect(result.code).toBeNull()
      const gpidMatch = /GPID=(\d+)/.exec(result.stdoutTail)
      expect(gpidMatch, `stdoutTail must carry the grandchild pid, got: ${result.stdoutTail}`).not.toBeNull()
      const grandchildPid = Number(gpidMatch?.[1])
      // The kill chain (jail TerminateJobObject / taskkill /T / tree-kill) has
      // already been awaited inside the tool by the time it resolves; the
      // bounded poll only tolerates OS teardown-visibility latency.
      const deadline = Date.now() + 5_000
      while (pidAlive(grandchildPid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(pidAlive(grandchildPid)).toBe(false)
    },
    HANG_MS,
  )
})

describe('abort mid-run', () => {
  it('AbortSignal kills the child and marks killed without throwing', async () => {
    makeRegistry({ jailMode: 'off', defaultTimeoutMs: 60_000 })
    const ac = new AbortController()
    const execCtx = ctx({ signal: ac.signal, callId: 'c-abort' })
    const p = execute({ command: cmd.hang }, execCtx)
    // abort once powershell/node is genuinely up (fixed delay is fine here:
    // we are aborting, not racing a completion)
    await new Promise((r) => setTimeout(r, 2_000))
    ac.abort()
    const result = (await p) as ShellResult
    expect(result.killed).toBe(true)
    expect(result.code).toBeNull()
  }, HANG_MS)
})

describe('permission funnel', () => {
  it('policy deny: rejects before any spawn, chunks never emitted', async () => {
    makeRegistry()
    permission.decision = 'deny'
    await expect(execute({ command: cmd.echoHello })).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(chunks).toHaveLength(0)
    expect(permission.audits[0]?.action).toEqual({ type: 'fs.shell', target: { cmd: cmd.echoHello } })
    expect(permission.audits[0]?.assessment.decision).toBe('deny')
    expect(permission.audits).toHaveLength(1)
  })

  it('ask + user allow: gate suspends, then runs and reports phase running', async () => {
    makeRegistry()
    permission.decision = 'ask'
    permission.userAnswer = 'allow'
    const execCtx = ctx()
    const result = (await execute({ command: cmd.echoHello }, execCtx)) as ShellResult
    expect(result.code).toBe(0)
    expect(permission.asks).toHaveLength(1)
    expect(execCtx.reportPhase).toHaveBeenCalledWith('running')
  })

  it('ask + user deny: PermissionDeniedError(user), no spawn, no running phase', async () => {
    makeRegistry()
    permission.decision = 'ask'
    permission.userAnswer = 'deny'
    const execCtx = ctx()
    await expect(execute({ command: cmd.echoHello }, execCtx)).rejects.toThrow(/denied \(user\)/)
    expect(execCtx.reportPhase).not.toHaveBeenCalled()
    expect(chunks).toHaveLength(0)
  })
})

describe('cwd fence + program allowlist', () => {
  it('rejects cwd escaping the workspace before the gate and audits the denial', async () => {
    makeRegistry()
    await expect(execute({ command: cmd.echoHello, cwd: '../outside' })).rejects.toBeInstanceOf(FsPathError)
    expect(permission.asks).toHaveLength(0)
    const deny = permission.audits.find((a) => a.assessment.decision === 'deny')
    expect(deny?.detail?.['reason']).toBe('path-outside-workspace')
    expect(chunks).toHaveLength(0)
  })

  it('allowedPrograms gates by first token BEFORE the permission engine', async () => {
    makeRegistry({ allowedPrograms: ['node'] })
    await expect(execute({ command: cmd.echoHello })).rejects.toThrow(/program-not-allowed/)
    expect(permission.asks).toHaveLength(0)
    expect(permission.audits[0]?.assessment.decision).toBe('deny')
    expect(chunks).toHaveLength(0)
  })

  it('allowedPrograms null (default) admits any program to the permission engine', async () => {
    makeRegistry()
    const result = (await execute({ command: cmd.echoHello })) as ShellResult
    expect(result.code).toBe(0)
    expect(permission.audits[0]?.action.type).toBe('fs.shell')
  }, HANG_MS)
})

describe('output caps', () => {
  it(
    'truncates at maxOutputBytes: emission stops at the cap, result tail stays <= 16KB',
    async () => {
      makeRegistry({ defaultTimeoutMs: 20_000, maxOutputBytes: 65_536 })
      const result = (await execute({ command: cmd.big })) as ShellResult
      expect(result.truncated).toBe(true)
      const emitted = Buffer.byteLength(emittedText('stdout'), 'utf8')
      expect(emitted).toBeLessThanOrEqual(65_536)
      expect(emitted).toBeGreaterThan(60_000) // the cap really engaged mid-stream
      expect(Buffer.byteLength(result.stdoutTail, 'utf8')).toBeLessThanOrEqual(SHELL_TAIL_BYTES)
    },
    HANG_MS,
  )
})
