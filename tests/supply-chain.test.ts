/**
 * todo34 供应链门禁的本地锁 —— 三块：
 *  1. gen-engine-manifest 离线模式（fixture 字节，无网络）产物必须是
 *     src/engines/manifest.ts validator 接受的 EngineManifest v1，且
 *     CLI（pnpm gen:manifest 的调用形态）exit 0；
 *  2. resolver（lane30 消费方）对生成产物做 bundled-tier 命中 + 篡改拒绝
 *     （plan QA "引擎包被替换→运行时拒启" 的共享接缝回归）；
 *  3. security.yml 契约：yaml 可解析、四步骤关键字齐、第三方 action 全
 *     40 位 SHA 钉死（Appendix C）、release.yml 未被本 lane 触碰。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { validateEngineManifest, type EngineManifest } from '../src/engines/manifest';
import { createResolver, type ResolverDeps } from '../src/engines/resolver';
import { PINS, generate } from '../scripts/gen-engine-manifest.mjs';

const require = createRequire(import.meta.url);
const yaml = require(path.join(
  fileURLToPath(new URL('..', import.meta.url)),
  'node_modules', '.pnpm', 'js-yaml@4.3.1', 'node_modules', 'js-yaml',
));

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha256hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

let fixtureDir: string;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'las-t34-fix-'));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** llama + sd fixture 齐、whisper 缺席 → 离线模式应告警跳过而非失败 */
const seedFixtures = (outDir: string): void => {
  for (const e of ['llama', 'sd']) {
    fs.mkdirSync(path.join(outDir, e), { recursive: true });
    const pin = PINS.find((p: { engine: string }) => p.engine === e)!;
    fs.writeFileSync(path.join(outDir, e, pin.file), `fixture-${e}-bytes`);
  }
};

describe('gen-engine-manifest offline mode', () => {
  it('produces a validator-clean EngineManifest from local fixtures', async () => {
    const out = path.join(fixtureDir, 'direct');
    seedFixtures(out);
    await generate({ outDir: out, offline: true });

    const checked = validateEngineManifest(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf-8')));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const m = checked.manifest as EngineManifest;
    expect(m.version).toBe(1);
    // whisper 缺席 = 告警跳过；llama/sd 在场
    expect(Object.keys(m.engines).sort()).toStrictEqual(['llama', 'sd']);

    for (const key of ['llama', 'sd'] as const) {
      const pin = PINS.find((p: { engine: string }) => p.engine === key)!;
      const cpu = m.engines[key]!.cpu;
      expect(cpu.file).toBe(`${key}/${pin.file}`);
      expect(cpu.platform).toBe('win32-x64');
      expect(cpu.minVersion).toBe(pin.minVersion);
      const expectHash = sha256hex(fs.readFileSync(path.join(out, key, pin.file)));
      expect(cpu.sha256).toBe(expectHash);
    }
  });

  it('CLI via ENGINES_OFFLINE/ENGINES_OUT_DIR env exits 0 (pnpm gen:manifest shape)', () => {
    const out = path.join(fixtureDir, 'cli');
    seedFixtures(out);
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'gen-engine-manifest.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, ENGINES_OFFLINE: '1', ENGINES_OUT_DIR: out, ENGINES_CACHE_DIR: path.join(fixtureDir, 'unused-cache') },
      encoding: 'utf-8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(true);
  });

  it('rejects an empty staging (no engine at all) instead of shipping a vacuous manifest', async () => {
    const empty = path.join(fixtureDir, 'empty');
    await expect(generate({ outDir: empty, offline: true })).rejects.toThrow(/manifest 为空/);
  });
});

describe('resolver (lane30) consumes todo34 artifacts', () => {
  const writeManifestAndBin = (): { resourcesPath: string; manifest: EngineManifest } => {
    const root = path.join(fixtureDir, 'bundled');
    const res = path.join(root, 'resources');
    const engDir = path.join(res, 'engines');
    fs.mkdirSync(path.join(engDir, 'llama'), { recursive: true });
    const bin = Buffer.from('good-llama-binary');
    fs.writeFileSync(path.join(engDir, 'llama', 'llama-server.exe'), bin);
    const manifest: EngineManifest = {
      version: 1,
      generated_at: new Date().toISOString(),
      baseUrlTemplate: 'https://example.invalid/{engine}/{variant}/{file}',
      engines: {
        llama: { cpu: { file: 'llama/llama-server.exe', sha256: sha256hex(bin), minVersion: 'b4500', platform: 'win32-x64' } },
      },
    };
    return { resourcesPath: res, manifest };
  };

  it('bundled tier HITS when on-disk sha256 matches the generated manifest', async () => {
    const { resourcesPath, manifest } = writeManifestAndBin();
    const resolver = createResolver({
      manifest, manifestStatus: 'ok', resourcesPath,
      userDataDir: path.join(fixtureDir, 'unused-userdata'),
      platform: 'win32',
      fileExists: (p) => fs.existsSync(p),
      shaFile: async (p) => sha256hex(fs.readFileSync(p)),
    } as ResolverDeps);
    const hit = await resolver.resolve('llama', { prefer: 'bundled-cpu' });
    expect(hit.source).toBe('bundled-cpu');
    expect(hit.skipped).toHaveLength(0);
  });

  it('bundled tier REJECTS a swapped binary (plan QA: 引擎包被替换→运行时拒启)', async () => {
    const { resourcesPath, manifest } = writeManifestAndBin();
    // 篡改：manifest 保持原 digest，盘上 exe 被换
    fs.writeFileSync(path.join(resourcesPath, 'engines', 'llama', 'llama-server.exe'), 'evil-payload');
    const resolver = createResolver({
      manifest, manifestStatus: 'ok', resourcesPath,
      userDataDir: path.join(fixtureDir, 'unused-userdata2'),
      platform: 'win32',
      fileExists: (p) => fs.existsSync(p),
      shaFile: async (p) => sha256hex(fs.readFileSync(p)),
    } as ResolverDeps);
    const miss = await resolver.resolve('llama', { prefer: 'bundled-cpu' });
    expect(miss.source).toBe('none');
    expect(miss.skipped.some((s) => /sha256 mismatch/.test(s.reason))).toBe(true);
  });
});

describe('security.yml supply-chain contract', () => {
  const wfPath = path.join(repoRoot, '.github', 'workflows', 'security.yml');
  const raw = fs.readFileSync(wfPath, 'utf-8');
  const doc = yaml.load(raw);

  it('UTF-8 hygiene (no BOM / no mojibake)', () => {
    const bytes = fs.readFileSync(wfPath);
    expect(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf).toBe(false);
    expect(raw).not.toContain('\uFFFD');
  });

  it('contains the four gate keywords (osv / sbom / attest / cosign)', () => {
    expect(raw).toContain('osv-scanner');
    expect(raw).toContain('check:sbom');
    expect(raw).toContain('attest-build-provenance');
    expect(raw).toContain('cosign sign-blob');
  });

  it('every third-party action is pinned to a full 40-hex commit SHA', () => {
    // 契约形态：`uses: <org>/<repo>@<40hex> # <version-tag>` —— 未钉 SHA 即违规
    const usesLines = [...raw.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)(.*)$/gm)];
    expect(usesLines.length).toBeGreaterThanOrEqual(9);
    const badlyPinned = usesLines.filter(([, ref]) => !/^[^\s@]+@[0-9a-f]{40}$/.test(ref));
    expect(badlyPinned, `badly pinned uses: ${badlyPinned.map((m) => m[1]).join(' | ')}`).toHaveLength(0);
    const refs = usesLines.map((m) => m[1].split('@')[0]);
    expect(refs).toContain('google/osv-scanner-action/osv-scanner-action');
    expect(refs).toContain('actions/attest-build-provenance');
    // cosign 是 CLI（非 action）：v3.1.3 版本钉 + checksum 自校验在 bash 步骤内
    expect(raw).toContain('COSIGN_VERSION=v3.1.3');
    expect(raw).toContain('sha256sum --check');
  });

  it('workflow parses and exposes the job roster', () => {
    expect(Object.keys(doc.jobs).sort()).toStrictEqual(
      ['attest', 'contracts', 'osv', 'sbom', 'sign-engines', 'stage-engines'].sort(),
    );
    // 顶层默认只读（job 级 id-token 提权已在各 job 声明，Appendix C 最小权限）
    expect(doc.permissions).toStrictEqual({ 'contents': 'read' });
    const elevatedJobs = Object.entries(doc.jobs)
      .filter(([, j]) => j?.permissions?.['id-token'] === 'write')
      .map(([n]) => n);
    expect(elevatedJobs.sort()).toStrictEqual(['attest', 'sign-engines']);
  });

  it('release.yml (lane33 ownership) stays untouched by this todo', () => {
    // 本测试即守卫：若 release.yml 出现 engines staging 步骤 = 越界改动信号
    const release = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf-8');
    expect(release).not.toContain('gen:manifest');
    expect(release).not.toContain('gen-engine-manifest');
  });
});
