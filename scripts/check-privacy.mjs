#!/usr/bin/env node
/**
 * check-privacy.mjs — Wave7 T40 隐私与安全门禁
 * - 本地优先 / 零联网可聊 / 仅落 userData
 * - 禁止 0.0.0.0 对外暴露
 * - 禁止遥测域名与追踪 SDK
 * - 校验 PRIVACY.md / SECURITY.md 存在且包含关键声明
 * - 校验 .gitignore 覆盖 userData/、models/、.env
 * - 校验密钥加密（enc: 前缀 / safeStorage / maskSecret）
 *
 * Usage: node scripts/check-privacy.mjs
 * Exit 1 on violation (CI fail).
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let failed = false
const violations = []
const passes = []

function pass(msg) {
  passes.push(msg)
  console.log(`  ✓ ${msg}`)
}

function fail(msg) {
  failed = true
  violations.push(msg)
  console.error(`  ✗ ${msg}`)
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`)
}

console.log('[check-privacy] Local-first / Offline / userData gate\n')

// 1) Required docs exist
for (const rel of ['PRIVACY.md', 'SECURITY.md']) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) {
    fail(`缺失 ${rel}（应置于仓库根）`)
  } else {
    const content = fs.readFileSync(p, 'utf-8')
    pass(`${rel} 存在 (${(content.length / 1024).toFixed(1)} KB)`)
    // keyword checks
    const checks = []
    if (rel === 'PRIVACY.md') {
      checks.push(
        ['本地优先', /本地优先/],
        ['零联网可聊', /零联网|离线可用|Offline/i],
        ['仅落 userData', /userData/],
        ['127.0.0.1', /127\.0\.0\.1/],
        ['禁止 0.0.0.0 声明或无遥测声明', /0\.0\.0\.0|无遥测|无追踪|无埋点|遥测/],
      )
    } else {
      checks.push(
        ['漏洞上报', /漏洞上报|Reporting a Vulnerability/i],
        ['Report a vulnerability', /Report a vulnerability|Advisories/i],
        ['响应时限', /48 小时|响应|SLA/i],
        ['safeStorage / 加密', /safeStorage|enc:v1/],
        ['CI 门禁', /check-licenses|check-privacy|CI/],
      )
    }
    for (const [label, re] of checks) {
      if (re.test(content)) pass(`${rel} 包含：${label}`)
      else fail(`${rel} 缺少关键词：${label} (${re})`)
    }
    // AGPL must NOT be introduced as license for main project
    if (/AGPL.*MIT|license.*AGPL/i.test(content) && /主项目.*AGPL/i.test(content)) {
      fail(`${rel} 疑似引入 AGPL 为主许可（主项目必须保持 MIT）`)
    }
  }
}

// 2) .gitignore coverage
const giPath = path.join(ROOT, '.gitignore')
if (!fs.existsSync(giPath)) {
  fail('.gitignore 缺失')
} else {
  const gi = fs.readFileSync(giPath, 'utf-8')
  for (const pat of ['userData/', 'models/', '.env']) {
    if (gi.includes(pat)) pass(`.gitignore 覆盖 ${pat}`)
    else fail(`.gitignore 未覆盖 ${pat}`)
  }
  for (const pat of ['*.gguf', '*.safetensors']) {
    if (gi.includes(pat)) pass(`.gitignore 覆盖权重 ${pat}`)
    else warn(`.gitignore 未显式覆盖 ${pat}（建议添加）`)
  }
}

// 3) 禁止 0.0.0.0 监听（源码扫描）
const SRC_DIRS = ['src', 'electron', 'scripts']
const FORBIDDEN_BIND = /0\.0\.0\.0/g
const TELEMETRY_RE = /(google-analytics|googletagmanager|segment\.io|mixpanel|amplitude|sentry\.io.*tracing|telemetry|tracking-sdk)/i
const ALLOWED_0 = new Set([
  // docs / comments allowed? we strictly forbid code binding, but allow markdown mentions
])

function walkFiles(dir, out = []) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  const stack = [abs]
  while (stack.length) {
    const cur = stack.pop()
    const stat = fs.statSync(cur)
    if (stat.isDirectory()) {
      for (const e of fs.readdirSync(cur)) {
        if (e === 'node_modules' || e === '.git' || e === 'out' || e === 'release' || e === 'dist') continue
        stack.push(path.join(cur, e))
      }
    } else if (/\.(ts|js|mjs|cjs|tsx|jsx|json|yml|yaml)$/.test(cur)) {
      out.push(cur)
    }
  }
  return out
}

let scanned = 0
for (const d of SRC_DIRS) {
  const files = walkFiles(d)
  for (const f of files) {
    const rel = path.relative(ROOT, f)
    let text = ''
    try {
      text = fs.readFileSync(f, 'utf-8')
    } catch { continue }
    scanned++
    // 0.0.0.0 — allow in markdown/docs as mention of forbidden, but not as listen address
    // We check for actual binding patterns: host: "0.0.0.0" or listen("0.0.0.0") or 0.0.0.0:port
    const isTestFile = /\.test\.(ts|js|tsx|mjs)$/.test(f) || rel.includes('__tests__')
    const isSelf = rel.replace(/\\/g, '/') === 'scripts/check-privacy.mjs'
    if (FORBIDDEN_BIND.test(text)) {
      // Look for actual binding patterns: host: "0.0.0.0" or listen("0.0.0.0") or 0.0.0.0:port
      const hasBinding = !isSelf && /(host\s*[:=]\s*["']0\.0\.0\.0["']|listen\s*\(\s*["']0\.0\.0\.0|0\.0\.0\.0["']\s*:\s*\d)/.test(text)
      if (hasBinding) {
        if (isTestFile) {
          warn(`测试文件包含 0.0.0.0 绑定用例（视为防护测试）：${rel}`)
        } else {
          fail(`禁止 0.0.0.0 绑定：${rel}`)
        }
      } else if (!isSelf) {
        // plain mention outside binding — only warn, not fail, unless non-test without explanation
        if (!/禁止|forbid|disallow|127\.0\.0\.1/.test(text)) {
          warn(`发现 0.0.0.0 字面量（非绑定）：${rel} — 请确认仅为文档提及`)
        }
      }
    }
    if (!isSelf && TELEMETRY_RE.test(text)) {
      // allow word telemetry in privacy docs/comments
      const isDocLine = /check-privacy|PRIVACY\.md|无遥测|禁止遥测/.test(text)
      // only fail if actual SDK import, not doc mention
      const hasSdkImport = /(from\s+["'].*(analytics|mixpanel|segment|amplitude)["']|import.*telemetry)/i.test(text)
      if (hasSdkImport || !isDocLine) {
        // re-test with stricter: if hit is just the word telemetry in comment, warn not fail
        const hit = text.match(TELEMETRY_RE)?.[0] || ''
        if (/^(telemetry)$/i.test(hit) && /禁止|无遥测|门禁/.test(text)) {
          warn(`遥测关键词仅为门禁文档提及：${rel}`)
        } else {
          fail(`疑似遥测/追踪 SDK：${rel} 命中 ${hit}`)
        }
      }
    }
  }
}
pass(`源码扫描完成：${scanned} 文件（${SRC_DIRS.join(', ')})`)

// 4) 校验侧车仅 127.0.0.1（抽样关键文件）
const sidecarCandidates = ['src/sidecars', 'src/main', 'src-tauri']
let has127 = false
for (const d of sidecarCandidates) {
  const files = walkFiles(d)
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, 'utf-8')
      if (/127\.0\.0\.1/.test(t)) has127 = true
    } catch {}
  }
}
if (has127) pass('侧车/主进程存在 127.0.0.1 绑定')
else warn('未在侧车目录检测到 127.0.0.1（可能路径不同，CI 仅警告）')

// 5) 密钥加密约束（抽样）
const settingsCandidates = ['src/settings', 'src/main', 'src']
let hasEnc = false
let hasMask = false
for (const d of settingsCandidates) {
  const files = walkFiles(d)
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, 'utf-8')
      if (/enc:v1|safeStorage/.test(t)) hasEnc = true
      if (/maskSecret/.test(t)) hasMask = true
    } catch {}
  }
}
if (hasEnc) pass('检测到 safeStorage / enc:v1 加密落盘')
else warn('未检测到 enc:v1/safeStorage（可能命名不同，确认 docs/SECURITY.md 即可）')
if (hasMask) pass('检测到 maskSecret 脱敏')
else warn('未检测到 maskSecret（建议展示层脱敏）')

// 6) License gate reminder (delegate to check-licenses)
pass('许可门禁由 scripts/check-licenses.mjs 负责（主进程禁 AGPL/GPL）')

// Summary
console.log('')
if (failed) {
  console.error(`[check-privacy] FAILED — ${violations.length} 项违规：`)
  for (const v of violations) console.error(`  - ${v}`)
  console.error('\n  修复：移除 0.0.0.0 / 遥测域，补齐 PRIVACY.md/SECURITY.md 与 .gitignore，详见对应文档。\n')
  process.exit(1)
} else {
  console.log(`[check-privacy] OK — ${passes.length} 项通过，扫描 ${scanned} 文件\n`)
}
