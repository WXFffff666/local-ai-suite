#!/usr/bin/env node
/**
 * check-licenses.mjs — MIT 合规门禁
 * - 扫描 node_modules 下所有 package.json 的 license
 * - 白名单：MIT | Apache-2.0 | BSD* | ISC | 0BSD | CC0-1.0 | Unlicense
 * - AGPL / GPL 仅在 sidecars/ 目录下豁免，主进程出现则 exit 1
 * - 显式白名单：better-sqlite3 / sqlite-vec / sharp（含原生二进制，许可已确认）
 * - 支持 --sbom 输出 JSON：--sbom / --sbom=path / --sbom path
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 显式白名单（原生模块，许可已核验）
// better-sqlite3: BSD-3-Clause, sqlite-vec: MIT, sharp: Apache-2.0
const PACKAGE_ALLOWLIST = new Set([
  'better-sqlite3',
  'sqlite-vec',
  'sharp',
  // pnpm/electron 工具链常见子依赖豁免（如子依赖无 license 字段但为 MIT 上游）
  'electron',
  'electron-builder',
]);

// 允许的宽松许可（SPDX 标识，大小写不敏感，前缀匹配）
// 涵盖 MIT / Apache-2.0 / BSD* / ISC / 0BSD / CC0 / Unlicense
const ALLOWED_LICENSE_PATTERNS = [
  /^MIT$/i,
  /^MIT\*?$/i,
  /^Apache-2\.0$/i,
  /^(MIT OR Apache-2\.0)$/i, // sqlite-vec-* 平台二进制包
  /^Apache-2\.0 WITH LLVM-exception$/i, // 部分 Rust 相关
  /^BSD$/i,
  /^BSD-2-Clause$/i,
  /^BSD-3-Clause$/i,
  /^0BSD$/i,
  /^ISC$/i,
  /^CC0-1\.0$/i,
  /^Unlicense$/i,
  /^Python-2\.0$/i, // 极少数工具链
];

// 判定为 copyleft 的许可（需隔离到 sidecars/）
const COPYLEFT_RE = /AGPL|GPL/i;

// sidecar 豁免路径片段
const SIDECAR_SEGMENTS = ['sidecars', 'sidecar', 'sidecars/'];

function isSidecarPath(p) {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return SIDECAR_SEGMENTS.some((s) => norm.includes(s));
}

function normalizeLicenseField(pkg) {
  // package.json license 可能是 string | {type: string} | licenses: Array
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type.trim();
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type || '')).filter(Boolean).join(' OR ');
  }
  if (Array.isArray(pkg.license) && pkg.license.length) {
    return pkg.license.map((l) => (typeof l === 'string' ? l : l.type || '')).filter(Boolean).join(' OR ');
  }
  // 有些包仅在侧边注明，如 "licence"
  if (typeof pkg.licence === 'string' && pkg.licence.trim()) return pkg.licence.trim();
  return 'UNKNOWN';
}

/**
 * 将 SPDX 复合表达式拆为 token 列表
 * e.g. "(MIT OR Apache-2.0)" -> ["MIT", "Apache-2.0"]
 *      "MIT AND CC0-1.0" -> ["MIT", "CC0-1.0"]
 */
function tokenizeLicenseExpression(expr) {
  // 移除括号，按 OR / AND / / / , 分割
  return expr
    .replace(/[()]/g, ' ')
    .split(/\s*(?:OR|\|\||AND|&&|\/|,)\s*/i)
    .map((s) => s.trim().replace(/^\(+|\)+$/g, '').trim())
    .filter(Boolean);
}

function isAllowedLicense(licenseExpr, filePath, pkgName) {
  // 显式包白名单优先
  if (PACKAGE_ALLOWLIST.has(pkgName)) return { allowed: true, reason: 'package-allowlist' };

  const tokens = tokenizeLicenseExpression(licenseExpr);

  // UNKNOWN 视为不允许（除非在 allowlist）
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === 'UNKNOWN')) {
    return { allowed: false, reason: 'UNKNOWN license' };
  }

  // 若任一 token 是 copyleft
  const hasCopyleft = tokens.some((t) => COPYLEFT_RE.test(t));
  if (hasCopyleft) {
    if (isSidecarPath(filePath)) {
      return { allowed: true, reason: 'copyleft-exempt(sidecars/)' };
    }
    return { allowed: false, reason: 'copyleft (AGPL/GPL) outside sidecars/' };
  }

  // 检查是否全部 token 都在宽松白名单
  const allAllowed = tokens.every((tok) =>
    ALLOWED_LICENSE_PATTERNS.some((re) => re.test(tok.trim())),
  );
  if (allAllowed) return { allowed: true, reason: 'permissive' };

  // 兼容 "SEE LICENSE IN ..." 等特殊声明，视为需人工确认 -> 视为不通过但提示
  if (/SEE LICENSE/i.test(licenseExpr)) {
    // 若包在 allowlist 已处理；否则视为未知需审查
    return { allowed: false, reason: 'SEE LICENSE - manual review required' };
  }

  return { allowed: false, reason: `not in allowlist: ${licenseExpr}` };
}

function collectPackages(root) {
  const nm = path.join(root, 'node_modules');
  const results = [];
  const seen = new Set();

  if (!fs.existsSync(nm)) {
    return results;
  }

  // Walk top-level + nested (pnpm store 结构通过 symlink 解析)
  // 策略：递归扫描 node_modules 下所有 package.json，最多 3 层，避免误入 .bin
  function walk(dir, depth) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.bin' || e.name === '.pnpm' || e.name.startsWith('.')) {
        // .pnpm store 内部也可能有包，但 pnpm 顶层已 symlink；跳过深层 store 避免重复
        if (e.name === '.pnpm' && depth === 1) {
          // 不深入 .pnpm 内部，依赖通过顶层 symlink 已覆盖
          continue;
        }
        if (e.name.startsWith('.')) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        try {
          const real = fs.realpathSync(full);
          const stat = fs.statSync(real);
          if (stat.isDirectory()) {
            // symlink 到目录：检查是否为包
            const pkgJson = path.join(real, 'package.json');
            if (fs.existsSync(pkgJson)) {
              if (!seen.has(real)) {
                seen.add(real);
                results.push({ pkgPath: pkgJson, dir: real });
              }
            }
            // 递归其 node_modules
            const nested = path.join(real, 'node_modules');
            if (fs.existsSync(nested)) walk(nested, depth + 1);
            continue;
          }
        } catch {
          continue;
        }
      }
      if (e.isDirectory()) {
        // 作用域包 @xxx/yyy
        if (e.name.startsWith('@')) {
          walk(full, depth);
          continue;
        }
        const pkgJson = path.join(full, 'package.json');
        if (fs.existsSync(pkgJson) && depth <= 3) {
          if (!seen.has(full)) {
            seen.add(full);
            results.push({ pkgPath: pkgJson, dir: full });
          }
        }
        const nested = path.join(full, 'node_modules');
        if (fs.existsSync(nested)) walk(nested, depth + 1);
        // 也检查包内的 node_modules 已处理；无需对非包目录深入
        // 但顶层 node_modules 下的每个目录都是潜在包，已处理
      }
    }
  }

  walk(nm, 1);

  // 额外扫描 sidecars/ 下的独立进程包（AGPL 豁免区），同样纳入 SBOM 但标记豁免
  const sidecarsDir = path.join(root, 'sidecars');
  if (fs.existsSync(sidecarsDir)) {
    function walkSidecars(dir) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          const pkgJson = path.join(full, 'package.json');
          if (fs.existsSync(pkgJson) && !seen.has(full)) {
            seen.add(full);
            results.push({ pkgPath: pkgJson, dir: full });
          }
          // 递归子目录（如 sidecars/searxng/app）
          walkSidecars(full);
          const nested = path.join(full, 'node_modules');
          if (fs.existsSync(nested)) walk(nested, 1);
        }
      }
    }
    walkSidecars(sidecarsDir);
    // 单层 package.json 直放 sidecars/xxx
    // 顶层无包名时，也尝试 sidecars 本身
    const topPkg = path.join(sidecarsDir, 'package.json');
    if (fs.existsSync(topPkg) && !seen.has(sidecarsDir)) {
      seen.add(sidecarsDir);
      results.push({ pkgPath: topPkg, dir: sidecarsDir });
    }
  }

  // 按 package.json 读取详情
  const pkgs = [];
  for (const { pkgPath, dir } of results) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      const name = pkg.name || path.basename(dir);
      const version = pkg.version || '0.0.0';
      const license = normalizeLicenseField(pkg);
      pkgs.push({ name, version, license, dir, pkgPath });
    } catch {
      // 忽略损坏的 package.json
    }
  }
  // 去重按 name@version
  const uniq = new Map();
  for (const p of pkgs) {
    const key = `${p.name}@${p.version}`;
    if (!uniq.has(key)) uniq.set(key, p);
  }
  return [...uniq.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function parseArgs(argv) {
  const args = { sbom: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--sbom') {
      // --sbom 或 --sbom path
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.sbom = next;
        i++;
      } else {
        args.sbom = 'sbom.json';
      }
    } else if (a.startsWith('--sbom=')) {
      args.sbom = a.slice('--sbom='.length) || 'sbom.json';
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/check-licenses.mjs [--sbom[=path]]

  扫描 node_modules 中所有依赖的 license：
    - 白名单：MIT | Apache-2.0 | BSD* | ISC | 0BSD | CC0-1.0 | Unlicense
    - 显式白名单：better-sqlite3, sqlite-vec, sharp
    - AGPL/GPL 仅在 sidecars/ 目录下豁免，主进程出现则 exit 1
    - --sbom[=path] 输出 SPDX 简化 SBOM JSON（默认 sbom.json）

Examples:
  node scripts/check-licenses.mjs
  node scripts/check-licenses.mjs --sbom
  node scripts/check-licenses.mjs --sbom=sbom.json
  node scripts/check-licenses.mjs --sbom ./out/sbom.json
`);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const pkgs = collectPackages(ROOT);

  if (pkgs.length === 0) {
    console.warn('[check-licenses] 未发现 node_modules 依赖，跳过扫描（可能尚未 pnpm install）');
    // 无依赖时视为通过，但若有 --sbom 仍生成空 SBOM
    if (args.sbom) {
      const outPath = path.isAbsolute(args.sbom) ? args.sbom : path.join(ROOT, args.sbom);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const sbom = {
        bomFormat: 'CycloneDX-lite',
        specVersion: '1.4',
        generatedAt: new Date().toISOString(),
        project: { name: 'local-ai-suite', license: 'MIT' },
        components: [],
      };
      fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2), 'utf-8');
      console.log(`[check-licenses] SBOM 已生成：${path.relative(ROOT, outPath)} (0 components)`);
    }
    process.exit(0);
  }

  const rows = [];
  const violations = [];

  for (const p of pkgs) {
    const { allowed, reason } = isAllowedLicense(p.license, p.dir, p.name);
    const rel = path.relative(ROOT, p.dir).replace(/\\/g, '/');
    rows.push({ ...p, rel, allowed, reason });
    if (!allowed) violations.push({ ...p, rel, reason });
  }

  // 打印清单
  console.log(`\n[check-licenses] 扫描到 ${rows.length} 个包，根目录：${ROOT}`);
  console.log(`  白名单：MIT | Apache-2.0 | BSD* | ISC (+ 0BSD/CC0/Unlicense) | 显式: ${[...PACKAGE_ALLOWLIST].join(', ')}`);
  console.log(`  豁免：AGPL/GPL 仅 sidecars/ 目录\n`);
  // 表格
  const COL_W = { name: 32, version: 14, license: 22, status: 10 };
  function pad(s, w) {
    const str = String(s);
    if (str.length >= w) return str.slice(0, w - 1) + '·';
    return str + ' '.repeat(w - str.length);
  }
  console.log(`${pad('Package', COL_W.name)} ${pad('Version', COL_W.version)} ${pad('License', COL_W.license)} ${pad('Status', COL_W.status)} Path`);
  console.log('-'.repeat(110));
  for (const r of rows) {
    const status = r.allowed ? 'OK' : 'FAIL';
    console.log(`${pad(r.name, COL_W.name)} ${pad(r.version, COL_W.version)} ${pad(r.license, COL_W.license)} ${pad(status, COL_W.status)} ${r.rel}`);
  }
  console.log('');

  if (violations.length) {
    console.error(`[check-licenses] 发现 ${violations.length} 个不合规许可（主进程禁止 AGPL/GPL）：`);
    for (const v of violations) {
      console.error(`  - ${v.name}@${v.version}  license=${v.license}  reason=${v.reason}  path=${v.rel}`);
    }
    console.error(`\n  修复：移除或替换该依赖，或将其隔离至 sidecars/ 独立进程（通过 127.0.0.1 通信，不链接进主进程）。`);
    console.error(`  详见 THIRD_PARTY_NOTICES.md 合规说明。\n`);
  } else {
    console.log('[check-licenses] 全部合规 ✓\n');
  }

  // --sbom 输出
  if (args.sbom) {
    const outPath = path.isAbsolute(args.sbom) ? args.sbom : path.join(ROOT, args.sbom);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const sbom = {
      bomFormat: 'CycloneDX-lite',
      specVersion: '1.4',
      generatedAt: new Date().toISOString(),
      project: { name: 'local-ai-suite', license: 'MIT', version: getProjectVersion() },
      summary: {
        totalComponents: rows.length,
        violations: violations.length,
        allowlist: [...PACKAGE_ALLOWLIST],
        allowedLicenses: ['MIT', 'Apache-2.0', 'BSD*', 'ISC', '0BSD', 'CC0-1.0', 'Unlicense'],
      },
      components: rows.map((r) => ({
        name: r.name,
        version: r.version,
        license: r.license,
        allowed: r.allowed,
        reason: r.reason,
        path: r.rel,
        purl: `pkg:npm/${r.name}@${r.version}`,
      })),
      violations: violations.map((v) => ({
        name: v.name,
        version: v.version,
        license: v.license,
        reason: v.reason,
        path: v.rel,
      })),
    };
    fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2), 'utf-8');
    console.log(`[check-licenses] SBOM 已生成：${path.relative(ROOT, outPath)} (${rows.length} components, ${violations.length} violations)`);
  }

  process.exit(violations.length ? 1 : 0);
}

function getProjectVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

main();
