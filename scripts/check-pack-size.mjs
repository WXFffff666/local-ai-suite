#!/usr/bin/env node
/**
 * check-pack-size.mjs — Wave7 T33 pack size gate
 * - Enforces Win installer < 150 MB (without models)
 * - Checks asar + unpacked native modules
 * - No AGPL deps, pure Node fs
 *
 * Usage:
 *   node scripts/check-pack-size.mjs              # check release/ if exists
 *   node scripts/check-pack-size.mjs --strict     # fail if no artifact found
 *   node scripts/check-pack-size.mjs --dir out    # check out/ size
 *   node scripts/check-pack-size.mjs --allow-missing-engines  # ack absent engine staging
 *   LIMIT_MB=150 node scripts/check-pack-size.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const RELEASE_DIR = path.join(ROOT, 'release')
const OUT_DIR = path.join(ROOT, 'out')

const LIMIT_MB = Number(process.env.LIMIT_MB || 150)
const LIMIT_BYTES = LIMIT_MB * 1024 * 1024

const args = process.argv.slice(2)
const strict = args.includes('--strict')
// todo31: local builds have NO staged engine binaries (electron-builder.yml
// extraResources is a commented placeholder until todo34's CI stages
// build/engines). The <150 MB budget therefore covers app+Electron ONLY
// locally; once engines ship inside resources/engines, todo34 updates this
// baseline. Pass --allow-missing-engines to acknowledge the gap explicitly
// (e.g. in pre-todo34 CI verify jobs) instead of getting the warning.
const allowMissingEngines = args.includes('--allow-missing-engines')
const dirArgIdx = args.indexOf('--dir')
const checkDir = dirArgIdx !== -1 && args[dirArgIdx + 1] ? path.resolve(ROOT, args[dirArgIdx + 1]) : null

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function walkSize(dir) {
  let total = 0
  if (!fs.existsSync(dir)) return { total: 0, exists: false, files: [] }
  const stack = [dir]
  const files = []
  while (stack.length) {
    const cur = stack.pop()
    const stat = fs.statSync(cur)
    if (stat.isDirectory()) {
      for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e))
    } else {
      total += stat.size
      files.push({ file: path.relative(ROOT, cur), size: stat.size })
    }
  }
  files.sort((a, b) => b.size - a.size)
  return { total, exists: true, files }
}

function findReleaseArtifacts() {
  if (!fs.existsSync(RELEASE_DIR)) return []
  const entries = fs.readdirSync(RELEASE_DIR)
  return entries
    .filter((f) => /\.(exe|nsis|msi|dmg|AppImage|deb|zip|blockmap)$/i.test(f) || f.endsWith('.asar'))
    .map((f) => {
      const p = path.join(RELEASE_DIR, f)
      const s = fs.statSync(p)
      return { file: path.relative(ROOT, p), size: s.size, isDir: s.isDirectory() }
    })
    .sort((a, b) => b.size - a.size)
}

let failed = false

// 1) out/ size (renderer + main) — quick feedback without full build
if (checkDir) {
  const r = walkSize(checkDir)
  console.log(`[check-pack-size] ${path.relative(ROOT, checkDir)}/ : ${formatBytes(r.total)} / limit ${LIMIT_MB} MB`)
  if (r.total > LIMIT_BYTES) {
    console.error(`  ✗ out dir exceeds ${LIMIT_MB} MB — check bundling / externalizeDepsPlugin`)
    failed = true
  } else {
    console.log(`  ✓ within budget`)
  }
  if (r.files.length) {
    console.log('  top 5 largest:')
    for (const f of r.files.slice(0, 5)) console.log(`    ${formatBytes(f.size).padStart(10)}  ${f.file}`)
  }
} else if (fs.existsSync(OUT_DIR)) {
  const r = walkSize(OUT_DIR)
  console.log(`[check-pack-size] out/ : ${formatBytes(r.total)} (unpacked, asar not yet)`)
  if (r.total > LIMIT_BYTES) {
    console.warn(`  ⚠ out/ alone > ${LIMIT_MB} MB — will likely exceed packed limit`)
  }
  console.log('  top 5 largest in out/:')
  for (const f of r.files.slice(0, 5)) console.log(`    ${formatBytes(f.size).padStart(10)}  ${f.file}`)
}

// 2) release artifacts
const artifacts = findReleaseArtifacts()
if (artifacts.length === 0) {
  console.log(`[check-pack-size] no artifacts in release/ yet (run pnpm build first)`)
  if (strict) {
    console.error('  ✗ --strict: expected at least one installer in release/')
    failed = true
  }
} else {
  console.log(`[check-pack-size] release artifacts (limit ${LIMIT_MB} MB each, models excluded):`)
  for (const a of artifacts) {
    const ok = a.size <= LIMIT_BYTES
    const mark = ok ? '✓' : '✗'
    console.log(`  ${mark} ${formatBytes(a.size).padStart(10)}  ${a.file}${ok ? '' : `  EXCEEDS ${LIMIT_MB} MB`}`)
    // only enforce for Win installers; dmg/AppImage may differ but warn
    const isWin = /\.exe$/i.test(a.file)
    if (!ok && isWin) failed = true
    if (!ok && !isWin) console.warn(`  ⚠ non-Win artifact over budget — review`)
  }
  // summary: largest Win installer must be <150 MB
  const winArtifacts = artifacts.filter((a) => /\.exe$/i.test(a.file))
  if (winArtifacts.length) {
    const largestWin = winArtifacts[0]
    if (largestWin.size > LIMIT_BYTES) {
      console.error(`\n✗ FAIL: Win installer ${largestWin.file} is ${formatBytes(largestWin.size)} > ${LIMIT_MB} MB`)
      failed = true
    } else {
      console.log(`\n✓ PASS: Win installer ${formatBytes(largestWin.size)} < ${LIMIT_MB} MB`)
    }
  }
}

// 3) asar note
const asarPath = path.join(RELEASE_DIR, 'win-unpacked', 'resources', 'app.asar')
if (fs.existsSync(asarPath)) {
  const s = fs.statSync(asarPath)
  console.log(`[check-pack-size] app.asar: ${formatBytes(s.size)}`)
  if (s.size > LIMIT_BYTES) {
    console.error(`  ✗ app.asar exceeds ${LIMIT_MB} MB`)
    failed = true
  }
}

// 4) engine-binary accounting (todo31 note, todo34 baseline)
const enginesDir = path.join(RELEASE_DIR, 'win-unpacked', 'resources', 'engines')
if (fs.existsSync(enginesDir)) {
  const r = walkSize(enginesDir)
  console.log(`[check-pack-size] resources/engines staged: ${formatBytes(r.total)} (${r.files.length} files) — counted in the artifact sizes above`)
} else if (fs.existsSync(path.join(RELEASE_DIR, 'win-unpacked'))) {
  const msg = 'win-unpacked has NO resources/engines — size measured EXCLUDES engine binaries (todo34 CI staging pending)'
  if (allowMissingEngines) console.log(`[check-pack-size] note: ${msg} (--allow-missing-engines acknowledged)`)
  else console.warn(`[check-pack-size] WARN: ${msg}. Pass --allow-missing-engines to acknowledge.`)
}

if (failed) {
  console.error(`\n[check-pack-size] FAILED — reduce bundle (check files whitelist, asar, native rebuild)`)
  process.exit(1)
} else {
  console.log(`\n[check-pack-size] OK`)
}
