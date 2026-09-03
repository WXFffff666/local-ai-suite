#!/usr/bin/env node
/**
 * fuses.mjs — Electron fuse hardening for the PACKAGED app (plan todo31).
 *
 * Dual-build split (plan R3b + todo12 constraint):
 *   PROD  : `pnpm pack` / `dist:win` -> release/win-unpacked/<exe> — afterPack
 *           flips the fuse wire in the copied Electron binary; nsis + portable
 *           artifacts both inherit it.
 *   TEST  : `pnpm test:e2e` launches the dev-style app (out/ + the Electron
 *           binary in node_modules, app dir passed via argv). That binary is
 *           NEVER touched by this hook, so OnlyLoadAppFromAsar (which forbids
 *           dir-path app loading) and fuse churn can never hit the e2e path.
 *
 * Final matrix — every entry carries its reason; the same object drives both
 * flipping and `--verify` read-back, so the two can never drift.
 *
 * | fuse                              | state | reason |
 * |-----------------------------------|-------|--------|
 * | RunAsNode                         | OFF   | no ELECTRON_RUN_AS_NODE => the shipped exe cannot be abused as a generic Node to run arbitrary JS |
 * | EnableNodeOptionsEnvironmentVariable | OFF | NODE_OPTIONS injection (e.g. --require) is a RunAsNode sibling; closed together |
 * | EnableNodeCliInspectArguments     | ON    | MUST STAY ON: Playwright `_electron.launch` injects `--inspect=0` to establish its CDP/debugger connection (todo12 source-level conclusion, R9). Compensating controls: asar integrity + argv validation (see docs/SECURITY.md). |
 * | OnlyLoadAppFromAsar               | ON    | prod only: app loads from resources/app.asar exclusively (no app/folder/unpacked fallback). e2e never launches the fused exe (see TEST lane above), so the argv-app-path conflict cannot occur. |
 * | EnableEmbeddedAsarIntegrityValidation | ON | app.asar header must match the digest embedded in the EXE; tampered asar aborts at boot (archive_win.cc PLOG(FATAL) — fuse ON with no embedded resource is ALSO a boot abort, never a silent skip). electron-builder v26 embeds that resource natively before afterPack runs ("updating asar integrity executable resource" build step, addWinAsarIntegrity via resedit), so the fuse is backed by real data — confirmed by the packed-exe launch proof. |
 * | EnableCookieEncryption            | OFF   | win32-only effect. Electron keeps Chromium's DPAPI OSCrypt backend: the cookie key is DPAPI-encrypted in <userData>/Local State and is stable across launches (no silent rotation). We keep it OFF because it buys nothing in our threat model — the app persists no Chromium cookies (secrets go through safeStorage, see docs/SECURITY.md) — and it is a one-way transition (a later fuse flip corrupts existing stores; un-flip corrupts encrypted ones). Revisit only if the renderer ever gains a cookie-backed session. |
 * | resetAdHocDarwinSignature         | n/a   | Apple Silicon ad-hoc signature reset — this repo's fuses run only for win32 targets. |
 * | (V8 snapshot / file-privileges / WasmTrapHandlers) | untouched | plan guardrail: "不开实验位" — leave at Electron defaults. |
 *
 * INTEGRITY NOTE (task-31 evidence): electron-builder v26 embeds the Windows
 * INTEGRITY/ELECTRONASAR PE resource itself during the electron-framework copy
 * stage — BEFORE this afterPack hook flips the wire (see the "updating asar
 * integrity executable resource" line in the pack log). The validation fuse
 * therefore has real data behind it; the packed-exe spawn proof (process alive
 * + main-process logs, zero FATAL) confirms launch under ON+ON.
 *
 * Why a custom hook instead of electron-builder's built-in `electronFuses`
 * option: this module is the single reasoned source of the matrix (every fuse
 * carries its why) AND `--verify` reads the finished binary back — the built-in
 * option can do neither, and a mis-set fuse must fail a gate, not a user.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { flipFuses, getCurrentFuseWire, FuseState, FuseVersion, FuseV1Options } from '@electron/fuses'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** name -> desired boolean state (single source of truth for flip + verify). */
export const FUSE_MATRIX = /** @type {const} */ ({
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
})

/** FuseV1Options member names present in the matrix (the rest stay untouched). */
const MATRIX_KEYS = Object.keys(FUSE_MATRIX)

function toConfig() {
  const cfg = { version: FuseVersion.V1 }
  for (const key of MATRIX_KEYS) {
    cfg[FuseV1Options[key]] = FUSE_MATRIX[key]
  }
  return cfg
}

/** Locate the packaged Electron EXE (top-level *.exe) inside an app dir. */
export function findAppExe(appDir) {
  if (!fs.existsSync(appDir)) {
    throw new Error(`fuses: app dir not found: ${appDir} (run 'pnpm pack:local' first)`)
  }
  const exes = fs
    .readdirSync(appDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe'))
    .map((e) => e.name)
  if (exes.length === 0) throw new Error(`fuses: no top-level *.exe inside ${appDir} — nothing to fuse`)
  if (exes.length > 1) throw new Error(`fuses: ambiguous multiple EXEs in ${appDir}: ${exes.join(', ')}`)
  return path.join(appDir, exes[0])
}

/** Flip the matrix onto the given Electron binary (idempotent by construction). */
export async function applyFuses(electronExe) {
  return flipFuses(electronExe, toConfig())
}

/**
 * Read the binary's fuse wire and compare against FUSE_MATRIX.
 * @returns {Promise<{ok: boolean, checked: Record<string,boolean>, mismatches: string[]}>}
 */
export async function verifyFuses(electronExe) {
  const wire = await getCurrentFuseWire(electronExe)
  const checked = {}
  const mismatches = []
  for (const key of MATRIX_KEYS) {
    const want = FUSE_MATRIX[key]
    // @electron/fuses v2 returns { version, 0: byte, 1: byte, ... } keyed by wire index.
    const state = wire[FuseV1Options[key]]
    const got = state === FuseState.ENABLE ? true : state === FuseState.DISABLE ? false : null
    checked[key] = got === null ? `unset(${String(state)})` : got
    if (got !== want) {
      mismatches.push(`${key}: want ${String(want)}, wire says ${String(got ?? state)} (${state === FuseState.REMOVED ? 'REMOVED' : state === FuseState.INHERIT ? 'INHERIT' : String(state)})`)
    }
  }
  return { ok: mismatches.length === 0, checked, mismatches }
}

// ---------------------------------------------------------------------------
// electron-builder hook (afterPack) — see electron-builder.yml `afterPack:`
// ---------------------------------------------------------------------------

/** @param {import('app-builder-lib/out/packagerApi').AfterPackContext} context */
export async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') {
    console.log(`[fuses] skipped for ${context.electronPlatformName} (todo31 hardens win32 only)`)
    return
  }
  const exe = findAppExe(context.appOutDir)
  await applyFuses(exe)
  const { ok, mismatches } = await verifyFuses(exe)
  if (!ok) throw new Error(`[fuses] post-flip verify failed for ${exe}:\n  ${mismatches.join('\n  ')}`)
  console.log(`[fuses] applied + verified matrix on ${path.basename(exe)}`)
}

export default afterPack

// ---------------------------------------------------------------------------
// CLI: `node scripts/fuses.mjs --verify [path/to/exe|dir]`
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--verify')) {
    const pos = args.find((a) => !a.startsWith('--'))
    let target
    try {
      if (pos) {
        const abs = path.resolve(ROOT, pos)
        target = fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : findAppExe(abs)
      } else {
        target = findAppExe(path.join(ROOT, 'release', 'win-unpacked'))
      }
    } catch (err) {
      console.error(`[fuses] --verify: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
      return
    }
    const { ok, checked, mismatches } = await verifyFuses(target)
    console.log(`[fuses] read-back of ${path.relative(ROOT, target)}:`)
    for (const [k, v] of Object.entries(checked)) {
      const mark = v === FUSE_MATRIX[k] ? '✓' : '✗'
      console.log(`  ${mark} ${k.padEnd(38)} = ${String(v)} (want ${String(FUSE_MATRIX[k])})`)
    }
    if (!ok) {
      console.error(`[fuses] FAILED:\n  ${mismatches.join('\n  ')}`)
      process.exitCode = 1
      return
    }
    console.log('[fuses] OK — wire matches the todo31 prod matrix')
    return
  }
  // no flags: invoked as a bare script (not via the builder hook loader)
  console.log('usage: node scripts/fuses.mjs --verify [exe-or-app-dir]')
}

if (invokedDirectly) void main()
