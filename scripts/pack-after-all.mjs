#!/usr/bin/env node
/**
 * pack-after-all.mjs — electron-builder `afterAllArtifactBuild` hook (todo31).
 *
 * Artifact hygiene inventory, nothing more:
 *  1. lists every produced artifact with its size (the release.yml upload job
 *     and `check-pack-size.mjs` consume these paths);
 *  2. flags the two expected Windows targets (Setup + Portable) when a FULL
 *     win build ran — partial runs (`--dir`, single `--win --x64` filters that
 *     skip a target) only warn, they never fail;
 *  3. reports whether `resources/engines/` exists in win-unpacked. Locally it
 *     is ABSENT by design (the extraResources block in electron-builder.yml is
 *     a commented placeholder until todo34's CI stages the CPU binaries) —
 *     that is a WARN, not an error; the resolver's dev-absent-manifest
 *     warn+pass path (src/engines/manifest.ts) covers runtime.
 *
 * Usable standalone: `node scripts/pack-after-all.mjs` re-scans release/.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE_DIR = path.join(ROOT, 'release')

const MB = 1024 * 1024

function fmt(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`
}

/** @param {string[]} paths */
function inventory(paths) {
  const rows = []
  for (const p of paths) {
    try {
      const st = fs.statSync(p)
      rows.push({ p, size: st.size, dir: st.isDirectory() })
    } catch {
      rows.push({ p, size: -1, dir: false })
    }
  }
  return rows.sort((a, b) => b.size - a.size)
}

/**
 * electron-builder hook: `afterAllArtifactBuild(context)`.
 * context: { packager, artifactPaths, platform, arch }
 */
export default async function afterAllArtifactBuild(context) {
  const artifactPaths = context?.artifactPaths ?? []
  const lines = []
  const warns = []

  const rows = inventory(artifactPaths)
  if (rows.length === 0) {
    lines.push('[pack-after-all] no distributable artifacts (dir build) — skipping inventory')
  }
  for (const r of rows) {
    if (r.size < 0) {
      warns.push(`artifact listed but missing on disk: ${r.p}`)
      continue
    }
    lines.push(`[pack-after-all] ${r.dir ? 'dir ' : 'file'} ${path.relative(ROOT, r.p)}  ${r.dir ? '(unpacked)' : fmt(r.size)}`)
  }

  // Expected win target pair (todo31). Only assert when a full win build ran.
  const names = rows.filter((r) => !r.dir).map((r) => path.basename(r.p))
  const hasSetup = names.some((n) => /-Setup-.*\.exe$/i.test(n))
  const hasPortable = names.some((n) => /-Portable-.*\.exe$/i.test(n))
  const fullWinBuild = names.length > 0
  if (fullWinBuild && !hasSetup) warns.push('NSIS Setup artifact missing — expected <Product>-Setup-<version>-x64.exe')
  if (fullWinBuild && !hasPortable) warns.push('portable artifact missing — expected <Product>-Portable-<version>-x64.exe')

  // Engine staging presence (CI todo34 fills build/engines -> resources/engines).
  const enginesDir = path.join(RELEASE_DIR, 'win-unpacked', 'resources', 'engines')
  if (fs.existsSync(enginesDir)) {
    const files = fs.readdirSync(enginesDir)
    lines.push(`[pack-after-all] resources/engines present: ${files.join(', ') || '(empty!)'}`)
    if (!files.includes('manifest.json')) warns.push('resources/engines lacks manifest.json — resolver will run dev warn+pass, not sha256-verified')
  } else {
    lines.push('[pack-after-all] resources/engines ABSENT (local escape hatch: todo34 CI stages build/engines; resolver dev-absent warn+pass applies)')
  }

  for (const l of lines) console.log(l)
  for (const w of warns) console.warn(`[pack-after-all] WARN: ${w}`)
  // Hygiene is advisory: never fail a pack from here (hard gates live in
  // check-pack-size / fuses --verify / CI).
  return { artifacts: [] }
}

// --- standalone mode: `node scripts/pack-after-all.mjs` ----------------------
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const existing = fs.existsSync(RELEASE_DIR)
    ? fs
        .readdirSync(RELEASE_DIR)
        .filter((f) => /\.(exe|AppImage|deb|dmg)$/i.test(f) || f === 'win-unpacked')
        .map((f) => path.join(RELEASE_DIR, f))
    : []
  void afterAllArtifactBuild({ artifactPaths: existing })
}
