#!/usr/bin/env node
/**
 * gen-engine-manifest.mjs — todo34 供应链：引擎二进制暂存 + SHA256 清单生成。
 *
 * 一条命令完成两件事（plan row 34：「在 build 步骤生成引擎 SHA256 清单打进
 * extraResources」，格式 = todo30 src/engines/manifest.ts 的 EngineManifest v1）：
 *
 *   1. stage   —— 下载 PINS 钉死的上游 win-x64 CPU release（llama.cpp /
 *      stable-diffusion.cpp / whisper.cpp 三件套），zip 落盘前先校验钉住的
 *      sha256（下载被投毒/中间人 ⇒ 立即红），再用 bsdtar(`tar`) 只抽取
 *      「目标 exe + 其导入 DLL 最小集」到 build/engines/<engine>/。
 *   2. manifest —— 对每个落盘 exe 计算 sha256，写 build/engines/manifest.json
 *      （electron-builder.yml extraResources `from: build/engines` 原样拷进
 *      <resourcesPath>/engines/，resolver 在 spawn 前逐字节 hash 校验 ——
 *      替换引擎包 ⇒ sha256 不符 ⇒ resolver 拒绝启动该引擎）。
 *
 * 分包目录（非平面）原因：三个上游 zip 各自带不同版本的 ggml.dll 等同名 DLL，
 * 平铺会互相覆盖 —— 每个引擎独立子目录，Windows DLL 加载搜索序含 exe 自身目录，
 * resolver 的 cpu.file 允许相对子路径（`join(resourcesPath,'engines',file)`）。
 *
 * 运行环境：
 *   - CI: .github/workflows/security.yml `stage-engines` job (windows-2022,
 *     自带 bsdtar + 可达 github.com)。FINAL dist 前同样先 `pnpm gen:manifest`。
 *   - 本地门禁 / 离线: ENGINES_OFFLINE=1 —— 跳过下载/解压，直接对
 *     <out>/<engine>/<file> 已存在的文件算 hash（vitest 用临时 fixture 驱动，
 *     ENGINES_OUT_DIR 指到 fixture 目录）。离线缺文件 ⇒ 跳过该引擎并告警；
 *     在线缺文件/钉不住 ⇒ 硬失败。
 *   - 本网络环境 github.com 不可达时自动回退 api.github.com asset 端点
 *     （Accept: application/octet-stream，同样先钉 zip sha256）。
 *
 * Deviations / 边界：
 *   - release.yml 归 lane33，不改；本脚本由 security.yml 与人工 `pnpm gen:manifest`
 *     调用（见 security.yml 头部 OPERATOR NOTES）。
 *   - cosign keyless 签名在 security.yml sign-engines job（ubuntu）对本脚本
 *     产出的 manifest.json 做 sign-blob —— 运行时校验仍归 resolver sha256
 *     （lane30），cosign 提供的是 CI 抓取环节的公开可验证出处。
 *
 * Exit codes: 0 ok | 1 校验/生成失败 | 2 用法错误
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Pinned upstream win-x64 CPU releases. 钉版本 = 钉 zip sha256（本地实测下载
 * 计算，2026-09-03）。升版流程：改 tag/asset → 删缓存 zip → 重跑本脚本 →
 * 人工核对新 digest 与上游发布页一致 → 连同本文件一起提交。
 *
 * minVersion 下限（Appendix R3 §C / TALOS-2024-1912/13/14/16 =
 * CVE-2024-21825/23496/21802/23605 恶意 GGUF 堆溢出，上游修复于 2024-03～05
 * 的 b2970..b3200 区间）：
 *   - llama  floor b4500 —— 远高于修复线且留出 backport 噪声余量；pin b10786。
 *     实测注意：llama.cpp v0.3.x 的 `--version` 首现为 semver（'0.3.0-dev
 *     (build 10786)'），resolver.parseVersionOutput 取到 "0.3.0" 与 b4500 比较
 *     ⇒ 系统 PATH 档会被保守拒绝并落到 bundled 档（fail-closed，方向安全；
 *     bundled 档由 sha256 钉死，不受 floor 影响）。若日后要让 PATH 档命中，
 *     floor 需改 semver 形态 —— 属 lane30 resolver 语义，此处只登记不擅改。
 *   - sd     floor 841   —— sd.cpp 无 TALOS 类历史，plan 裁定 floor = 钉住版本
 *     （master-841-6b3edaa 的 CI 计数段；实测 `sd-cli --version` 报 "unknown,
 *     commit 6b3edaa" 不可解析 ⇒ PATH 档同 fail-closed，bundled 不受影响）。
 *   - whisper floor b4938 —— 同 sd 裁定：floor = pin（todo36 消费，可选档；
 *     实测 whisper-server 无 --version 旗标，PATH 探针同样 fail-closed）。
 */
export const PINS = [
  {
    engine: 'llama',
    repo: 'ggml-org/llama.cpp',
    tag: 'b10786',
    asset: 'llama-b10786-bin-win-cpu-x64.zip',
    zipSha256: '4bd5eef83548aa73f712c74406640df294bcb98d916c4eef21f7bd41c2232a6e',
    file: 'llama-server.exe',
    minVersion: 'b4500',
    stripComponents: 0,
    extract: [
      'llama-server.exe', 'llama-server-impl.dll', 'llama.dll', 'llama-common.dll',
      'mtmd.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu-alderlake.dll',
      'ggml-cpu-cannonlake.dll', 'ggml-cpu-cascadelake.dll', 'ggml-cpu-cooperlake.dll',
      'ggml-cpu-haswell.dll', 'ggml-cpu-icelake.dll', 'ggml-cpu-ivybridge.dll',
      'ggml-cpu-piledriver.dll', 'ggml-cpu-sandybridge.dll', 'ggml-cpu-sapphirerapids.dll',
      'ggml-cpu-skylakex.dll', 'ggml-cpu-sse42.dll', 'ggml-cpu-x64.dll',
      'ggml-cpu-zen4.dll', 'libomp.dll', 'LICENSE-LLVM-OpenMP',
    ],
  },
  {
    engine: 'sd',
    repo: 'leejet/stable-diffusion.cpp',
    tag: 'master-841-6b3edaa',
    asset: 'sd-master-6b3edaa-bin-win-cpu-x64.zip',
    zipSha256: 'a36edb067de09fc9f70fcd193e519ff62592f860744558d7918762c7c3401050',
    file: 'sd-cli.exe',
    minVersion: '841',
    stripComponents: 0,
    extract: [
      'sd-cli.exe', 'stable-diffusion.dll', 'ggml.dll', 'ggml-base.dll',
      'ggml-cpu-alderlake.dll', 'ggml-cpu-cannonlake.dll', 'ggml-cpu-cascadelake.dll',
      'ggml-cpu-haswell.dll', 'ggml-cpu-icelake.dll', 'ggml-cpu-sandybridge.dll',
      'ggml-cpu-skylakex.dll', 'ggml-cpu-sse42.dll', 'ggml-cpu-x64.dll',
      'libwebp.dll', 'libwebpmux.dll', 'libsharpyuv.dll', 'webm.dll',
    ],
  },
  {
    engine: 'whisper',
    repo: 'ggml-org/whisper.cpp',
    tag: 'b4938',
    asset: 'whisper-bin-x64.zip',
    zipSha256: 'c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d',
    file: 'whisper-server.exe',
    minVersion: 'b4938',
    stripComponents: 1, // zip 内为 Release/ 子目录
    extract: [
      'Release/whisper-server.exe', 'Release/whisper.dll', 'Release/llama.dll',
      'Release/ggml.dll', 'Release/ggml-base.dll', 'Release/ggml-cpu-alderlake.dll',
      'Release/ggml-cpu-cannonlake.dll', 'Release/ggml-cpu-cascadelake.dll',
      'Release/ggml-cpu-haswell.dll', 'Release/ggml-cpu-icelake.dll',
      'Release/ggml-cpu-sandybridge.dll', 'Release/ggml-cpu-skylakex.dll',
      'Release/ggml-cpu-sse42.dll', 'Release/ggml-cpu-x64.dll',
    ],
  },
];

/** GPU-pack 下载模板占位（variant 目前无产物：R4 #7781 —— pack 由发布方上传，FINAL lane 落地；resolver 仅在有 active pack 时消费）。 */
const BASE_URL_TEMPLATE =
  'https://github.com/WXFffff666/local-ai-suite/releases/download/engine-packs-{engine}/{file}';

const SHA256_RE = /^[0-9a-f]{64}$/;
// 与 src/engines/manifest.ts VERSION_RE 对齐的自证（生成器不 import TS，见 assertManifest）
const VERSION_RE = /^[A-Za-z]{0,2}\d+(\.\d+)*([A-Za-z0-9.+-]*)?$/;

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('error', reject);
    h.once('error', reject);
    s.pipe(h);
    h.on('finish', () => resolve(h.read().toString('hex')));
  });
}

function httpsGet(url, { headers = {}, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'local-ai-suite-engines-stage', ...headers } }, (res) => {
      const { statusCode, headers: h } = res;
      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && h.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`));
        return resolve(httpsGet(new URL(h.location, url).toString(), { headers, redirects: redirects - 1 }));
      }
      resolve({ statusCode, res });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

async function fetchText(url, headers) {
  const { statusCode, res } = await httpsGet(url, { headers: { Accept: 'application/vnd.github+json', ...headers } });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  if (statusCode !== 200) throw new Error(`HTTP ${statusCode}: ${url} :: ${Buffer.concat(chunks).subarray(0, 200).toString()}`);
  return Buffer.concat(chunks).toString('utf-8');
}

async function downloadTo(url, dest, extraHeaders = {}) {
  const { statusCode, res } = await httpsGet(url, { headers: extraHeaders });
  if (statusCode !== 200) {
    res.resume();
    throw new Error(`HTTP ${statusCode} downloading ${url}`);
  }
  const tmp = `${dest}.part`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  fs.renameSync(tmp, dest);
}

/** 主链 github.com release URL；本环境 github.com 不可达时回退 api.github.com asset 端点。 */
async function stagePin(pin, cacheDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(cacheDir, pin.asset);
  if (!(fs.existsSync(zipPath) && (await sha256File(zipPath)) === pin.zipSha256)) {
    const browserUrl = `https://github.com/${pin.repo}/releases/download/${pin.tag}/${pin.asset}`;
    try {
      await downloadTo(browserUrl, zipPath);
    } catch (err) {
      console.warn(`[gen-manifest] ${pin.engine}: ${browserUrl} 失败 (${err.message})，回退 api.github.com asset 端点`);
      const rel = JSON.parse(await fetchText(`https://api.github.com/repos/${pin.repo}/releases/tags/${pin.tag}`));
      const asset = (rel.assets ?? []).find((a) => a.name === pin.asset);
      if (!asset) throw new Error(`${pin.engine}: asset ${pin.asset} 不在 ${pin.repo}@${pin.tag} 发布清单中`);
      await downloadTo(asset.url, zipPath, { Accept: 'application/octet-stream' });
    }
  }
  const got = await sha256File(zipPath);
  if (got !== pin.zipSha256) {
    fs.rmSync(zipPath, { force: true });
    throw new Error(`${pin.engine}: zip sha256 钉校验失败\n  want ${pin.zipSha256}\n  got  ${got} —— 上游被换包或下载损坏，已删缓存`);
  }
  const tarArgs = ['-xf', zipPath, '-C', outDir];
  if (pin.stripComponents > 0) tarArgs.push(`--strip-components=${pin.stripComponents}`);
  tarArgs.push(...pin.extract);
  const r = spawnSync('tar', tarArgs, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${pin.engine}: tar 解压失败 (exit ${r.status}) —— 需要 bsdtar（Windows 自带 tar.exe / macOS 系统 tar / ubuntu apt libarchive-tools），GNU tar 不认 zip`);
  for (const member of pin.extract) {
    const relPath = pin.stripComponents > 0 ? member.split('/').slice(pin.stripComponents).join(path.sep) : member.replace(/\//g, path.sep);
    if (!fs.existsSync(path.join(outDir, relPath))) throw new Error(`${pin.engine}: 解压后缺少 ${relPath}`);
  }
}

/** 生成器内自证 —— 与 src/engines/manifest.ts validateEngineManifest 的判定等价的最小子集（vitest 全量对照在 tests/engine-manifest.test.ts）。 */
function assertManifest(m) {
  const problems = [];
  if (m.version !== 1) problems.push('version != 1');
  if (typeof m.generated_at !== 'string' || !m.generated_at) problems.push('generated_at empty');
  if (typeof m.baseUrlTemplate !== 'string' || !m.baseUrlTemplate) problems.push('baseUrlTemplate empty');
  for (const [key, spec] of Object.entries(m.engines)) {
    if (!['llama', 'sd', 'whisper'].includes(key)) problems.push(`unknown engine ${key}`);
    const c = spec?.cpu;
    if (!c?.file) problems.push(`${key}.cpu.file missing`);
    if (!c?.sha256 || !SHA256_RE.test(c.sha256)) problems.push(`${key}.cpu.sha256 not 64-hex`);
    if (!c?.minVersion || !VERSION_RE.test(c.minVersion)) problems.push(`${key}.cpu.minVersion invalid: ${c?.minVersion}`);
    if (!c?.platform) problems.push(`${key}.cpu.platform missing`);
  }
  if (problems.length) throw new Error(`自证失败 (manifest.ts validator 会拒绝):\n  ${problems.join('\n  ')}`);
}

export async function generate({
  outDir = process.env.ENGINES_OUT_DIR || path.join(ROOT, 'build', 'engines'),
  cacheDir = process.env.ENGINES_CACHE_DIR || path.join(ROOT, 'build', 'engines-cache'),
  offline = process.env.ENGINES_OFFLINE === '1',
} = {}) {
  const engines = {};
  const warnings = [];
  for (const pin of PINS) {
    const engineDir = path.join(outDir, pin.engine);
    if (!offline) {
      fs.mkdirSync(cacheDir, { recursive: true });
      await stagePin(pin, cacheDir, engineDir);
    }
    const binPath = path.join(engineDir, pin.file);
    if (!fs.existsSync(binPath)) {
      const msg = `${pin.engine}: ${path.relative(outDir, binPath)} 缺失${offline ? '（离线模式：跳过该引擎）' : ''}`;
      if (!offline) throw new Error(msg);
      warnings.push(msg);
      continue;
    }
    engines[pin.engine] = {
      cpu: {
        file: `${pin.engine}/${pin.file}`,
        sha256: await sha256File(binPath),
        minVersion: pin.minVersion,
        platform: 'win32-x64',
      },
    };
  }
  if (Object.keys(engines).length === 0) throw new Error('manifest 为空：没有任何引擎二进制可哈希 —— 拒绝产出');
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    baseUrlTemplate: BASE_URL_TEMPLATE,
    engines,
  };
  assertManifest(manifest);
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  for (const w of warnings) console.warn(`[gen-manifest] WARN ${w}`);
  console.log(`[gen-manifest] ${path.relative(ROOT, manifestPath)} 写入完成：engines=[${Object.keys(engines).join(', ')}]${offline ? ' (offline)' : ''}`);
  return { manifest, manifestPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generate().catch((err) => {
    console.error(`[gen-manifest] FAIL ${err.message}`);
    process.exitCode = 1;
  });
}
