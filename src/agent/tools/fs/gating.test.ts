/**
 * gating.test.ts — todo27 security surfaces: the workspace path fence
 * (fencePath) and the permission gate helper (gate). These are the two
 * invariants every fs tool depends on, so they are pinned independently of
 * any tool: fence = lexical casefolded containment + realpath re-check
 * (symlink escape), gate = deny>ask semantics with audit on every decision.
 */
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fencePath, FsPathError, gate, PermissionDeniedError } from './gating'
import { fakePermission } from './testutils'
import type { PermissionAction } from '../../policy/types'

const readAction: PermissionAction = { type: 'fs.read', target: { path: 'a.txt' } }

function makeCtx(signal?: AbortSignal) {
  const phases: string[] = []
  return {
    phases,
    ctx: {
      callId: 'call-1',
      signal: signal ?? new AbortController().signal,
      reportPhase: (p: string) => phases.push(p),
    },
  }
}

describe('fencePath — workspace containment', () => {
  let root: string
  let outside: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fsfence-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'fsout-')))
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'a.txt'), 'inside')
    writeFileSync(join(outside, 'secret.txt'), 'outside')
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('accepts an inside relative path and returns the resolved absolute path', () => {
    expect(fencePath(root, 'a.txt')).toBe(resolve(root, 'a.txt'))
    expect(fencePath(root, join('sub', 'b.txt'))).toBe(resolve(root, 'sub', 'b.txt'))
  })

  it('rejects .. traversal above the root before touching fs', () => {
    expect(() => fencePath(root, '../outside')).toThrow(FsPathError)
    expect(() => fencePath(root, 'sub/../../escape')).toThrow(/outside/)
  })

  it('rejects absolute paths outside the root and the root itself', () => {
    expect(() => fencePath(root, join(outside, 'secret.txt'))).toThrow(FsPathError)
    expect(() => fencePath(root, '.')).toThrow(FsPathError)
    expect(() => fencePath(root, '')).toThrow(FsPathError)
  })

  it('casefolds on containment (drive-letter/casing traps)', () => {
    const upper = fencePath(root, 'A.TXT')
    const lower = fencePath(root, 'a.txt')
    // both must fence-pass; equality of the two is platform-case behavior,
    // what matters is neither throws (Windows is case-insensitive)
    expect(upper.toLowerCase()).toBe(lower.toLowerCase())
  })

  it('re-checks containment after realpath: a symlink to outside is rejected', () => {
    const linkPath = join(root, 'evil')
    try {
      symlinkSync(join(outside, 'secret.txt'), linkPath, 'file')
    } catch {
      // Windows non-elevated fallback: an NTFS junction to the outside dir
      try {
        symlinkSync(outside, linkPath, 'junction')
      } catch {
        return // neither primitive available in this environment
      }
    }
    expect(() => fencePath(root, 'evil')).toThrow(FsPathError)
    expect(() => fencePath(root, 'evil/secret.txt')).toThrow(/outside/)
  })

  it('allows a symlink that stays inside the workspace', () => {
    const dir = join(root, 'realdir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.txt'), 'x')
    const link = join(root, 'inner')
    try {
      symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    expect(fencePath(root, join('inner', 'x.txt')).toLowerCase()).toBe(resolve(dir, 'x.txt').toLowerCase())
  })

  it('fences a not-yet-existing write target by its nearest existing ancestor', () => {
    const fresh = join(root, 'newdir', 'deeper', 'file.txt')
    expect(fencePath(root, fresh)).toBe(fresh)
    expect(() => fencePath(root, join(root, '..', 'fsout-x', 'f.txt'))).toThrow(FsPathError)
  })
})

describe('gate — permission decisions and audit', () => {
  it('allow: resolves, records once, no ask', async () => {
    const p = fakePermission()
    p.decision = 'allow'
    const { ctx } = makeCtx()
    const assessment = await gate(p.port, readAction, ctx)
    expect(assessment.decision).toBe('allow')
    expect(p.asks).toHaveLength(0)
    expect(p.audits).toHaveLength(1)
    expect(p.audits[0]?.detail).toMatchObject({ via: 'policy', callId: 'call-1' })
  })

  it('deny: throws PermissionDeniedError and still records the audit row', async () => {
    const p = fakePermission()
    p.decision = 'deny'
    const { ctx } = makeCtx()
    await expect(gate(p.port, readAction, ctx)).rejects.toThrow(PermissionDeniedError)
    expect(p.asks).toHaveLength(0)
    expect(p.audits).toHaveLength(1)
    expect(p.audits[0]?.assessment.decision).toBe('deny')
  })

  it('ask → user allow: asks once with the signal, records the user decision', async () => {
    const p = fakePermission()
    p.decision = 'ask'
    p.userAnswer = 'allow'
    const { ctx } = makeCtx()
    const assessment = await gate(p.port, readAction, ctx)
    expect(p.asks).toEqual([readAction])
    expect(assessment.decision).toBe('allow')
    expect(p.audits[0]?.detail).toMatchObject({ via: 'user', callId: 'call-1' })
  })

  it('ask → user deny: throws and records with via=user', async () => {
    const p = fakePermission()
    p.decision = 'ask'
    p.userAnswer = 'deny'
    const { ctx } = makeCtx()
    await expect(gate(p.port, readAction, ctx)).rejects.toThrow(PermissionDeniedError)
    expect(p.audits).toHaveLength(1)
    expect(p.audits[0]?.detail).toMatchObject({ via: 'user' })
    expect(p.audits[0]?.assessment.decision).toBe('deny')
  })

  it('ask → aborted signal: rejects, records the denial, never proceeds', async () => {
    const p = fakePermission()
    p.decision = 'ask'
    p.userAnswer = 'allow' // would allow if asked, but abort wins
    const ac = new AbortController()
    ac.abort()
    const { ctx } = makeCtx(ac.signal)
    await expect(gate(p.port, readAction, ctx)).rejects.toThrow(/abort|cancel/i)
    expect(p.asks).toHaveLength(1) // fake ask observes the aborted signal and rejects
    expect(p.audits.some((a) => a.assessment.decision === 'deny')).toBe(true)
  })

  it('ask → dialog throws (window closed): denial is recorded and rethrown as PermissionDenied', async () => {
    const p = fakePermission()
    p.decision = 'ask'
    p.userAnswer = 'throw'
    const { ctx } = makeCtx()
    await expect(gate(p.port, readAction, ctx)).rejects.toThrow(PermissionDeniedError)
    expect(p.audits[0]?.assessment.decision).toBe('deny')
  })
})
