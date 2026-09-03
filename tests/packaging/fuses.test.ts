/**
 * todo31 — fuse hardening contract tests.
 *
 * Pure-unit tier: matrix constants + findAppExe error paths + CLI --verify
 * failing cleanly pre-build (spawned as a real child process).
 * Integration tier (skipped when the local electron binary is a CI stub):
 * flip the matrix on a COPY of the real dist/electron.exe and read it back.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { FUSE_MATRIX, applyFuses, findAppExe, verifyFuses } from '../../scripts/fuses.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FUSES_CLI = join(ROOT, 'scripts', 'fuses.mjs')

const tempDirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'las-fuses-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

describe('FUSE_MATRIX — plan row 31 contract', () => {
  it('disables the node-injection pair', () => {
    expect(FUSE_MATRIX.RunAsNode).toBe(false)
    expect(FUSE_MATRIX.EnableNodeOptionsEnvironmentVariable).toBe(false)
  })

  it('keeps EnableNodeCliInspectArguments ON for Playwright _electron.launch (R9/todo12)', () => {
    // Regression guard: someone "hardening" this OFF silently bricks every e2e.
    expect(FUSE_MATRIX.EnableNodeCliInspectArguments).toBe(true)
  })

  it('enforces asar loading for the PROD artifact only', () => {
    expect(FUSE_MATRIX.OnlyLoadAppFromAsar).toBe(true)
    expect(typeof FUSE_MATRIX.EnableEmbeddedAsarIntegrityValidation).toBe('boolean')
  })

  it('leaves cookie encryption OFF (no persisted per-install key -> rotating invalidation)', () => {
    expect(FUSE_MATRIX.EnableCookieEncryption).toBe(false)
  })
})

describe('findAppExe', () => {
  it('fails with a clean "build first" message when the dir is missing', () => {
    expect(() => findAppExe(join(freshDir(), 'nope'))).toThrowError(/run 'pnpm pack:local' first/)
  })

  it('fails when the dir holds no EXE', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'readme.txt'), 'x')
    expect(() => findAppExe(dir)).toThrowError(/no top-level \*\.exe/)
  })

  it('fails on ambiguous multiple EXEs', () => {
    const dir = freshDir()
    writeFileSync(join(dir, 'A.exe'), 'x')
    writeFileSync(join(dir, 'B.exe'), 'y')
    expect(() => findAppExe(dir)).toThrowError(/ambiguous/)
  })

  it('returns the single top-level exe', () => {
    const dir = freshDir()
    const exe = join(dir, 'Local AI Suite.exe')
    writeFileSync(exe, 'MZ')
    expect(findAppExe(dir)).toBe(exe)
  })
})

describe('CLI --verify (pre-build honesty)', () => {
  it('exits non-zero with a clean message when no artifact exists yet', () => {
    const empty = freshDir()
    const r = spawnSync(process.execPath, [FUSES_CLI, '--verify', empty], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/no top-level \*\.exe/)
    // Must NOT be a stack trace — a usable gate prints a usable error.
    expect(r.stderr).not.toMatch(/at .*node_modules/)
  })

  it('exits non-zero naming the missing dir for a nonexistent path', () => {
    const r = spawnSync(process.execPath, [FUSES_CLI, '--verify', join(freshDir(), 'ghost')], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/pack:local/)
  })
})

// ---------------------------------------------------------------------------
// Integration tier: real fuse-wire flip on a COPY of the local Electron binary.
// ci.yml STUBS node_modules/electron/dist with a zero-byte touch file — detect
// the stub by size and skip there (the flip needs a genuine fuse wire).
// ---------------------------------------------------------------------------

const ELECTRON_EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const realBinary = existsSync(ELECTRON_EXE) && statSync(ELECTRON_EXE).size > 1_000_000
const itReal = realBinary ? it : it.skip

describe('applyFuses + verifyFuses round-trip (real Electron wire)', () => {
  itReal('flips the matrix and the read-back matches', async () => {
    const dir = freshDir()
    const copy = join(dir, 'app.exe')
    copyFileSync(ELECTRON_EXE, copy)

    const before = await verifyFuses(copy)
    // Electron ships RunAsNode ENABLED by default — if a future Electron flips
    // that default, this precondition pin tells us the OFF-matrix is vacuous.
    expect(before.checked.RunAsNode).toBe(true)

    await applyFuses(copy)
    const after = await verifyFuses(copy)
    expect(after.ok).toBe(true)
    expect(after.mismatches).toEqual([])
    expect(after.checked.RunAsNode).toBe(false)
    expect(after.checked.EnableNodeCliInspectArguments).toBe(true)
    expect(after.checked.OnlyLoadAppFromAsar).toBe(true)
  })

  itReal('verify reports the exact key when the wire drifts', async () => {
    const dir = freshDir()
    const copy = join(dir, 'app.exe')
    copyFileSync(ELECTRON_EXE, copy)
    await applyFuses(copy)
    // Drift one fuse behind the matrix's back (simulates hand-edited artifact).
    const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')
    await flipFuses(copy, { version: FuseVersion.V1, [FuseV1Options.RunAsNode]: true })

    const res = await verifyFuses(copy)
    expect(res.ok).toBe(false)
    expect(res.mismatches.join('\n')).toMatch(/RunAsNode: want false/)
  })
})
