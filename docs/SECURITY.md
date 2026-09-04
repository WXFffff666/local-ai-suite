# SECURITY

## 威胁模型总览（todo35）

| 面 | 控制 | 实现 |
|---|---|---|
| 打包 EXE 被当通用 Node 滥用 / asar 篡改 | fuse 矩阵（下表） | `scripts/fuses.mjs` |
| 更新通道投毒 | GitHub 源 + 签名校验失败降级"仅提示" | `src/main/updater.ts` |
| 引擎二进制替换（LLM03 供应链） | sha256 逐层校验 + minVersion 下限（TALOS GGUF 攻击面 r1 修复） | `src/engines/resolver.ts`、`src/engines/gpuPack.ts`、`scripts/gen-engine-manifest.mjs` |
| LLM 过度代理（LLM01/06 致命三要素） | 默认 ask、无 YOLO 开关、审计不可删改 | `src/agent/policy/engine.ts` |
| 失控子进程 | Job Object + tree-kill 双退路（**非容器级隔离**，见下） | `src/agent/jail/` |
| 密钥落盘 | safeStorage/DPAPI（**same-user 威胁边界**，见下） | `src/settings/settings.tsx` |
| 本地 API 暴露（CVE-2024-28224/37032 教训） | 127.0.0.1 绑定 + Host/Origin 白名单 | `src/main/apiServer.ts` |

## 生产包 Electron fuses 完整矩阵（todo31）

打包产物（`release/win-unpacked`、NSIS、portable）经 `scripts/fuses.mjs`（afterPack）加固；`node scripts/fuses.mjs --verify` 读回校验。矩阵单源于该文件的 `FUSE_MATRIX`，翻转与校验共用同一对象，不可能漂移。开发/e2e 路径（Playwright `_electron.launch` 直启 `out/` + node_modules 的 Electron）**不经过 fuses**，属双构建设计的预期差异。

| fuse | 实际值 | 理由 |
|---|---|---|
| `RunAsNode` | **OFF** | `ELECTRON_RUN_AS_NODE` 关闭：安装包 EXE 不能当作通用 Node 跑任意 JS |
| `EnableNodeOptionsEnvironmentVariable` | **OFF** | `NODE_OPTIONS` 注入（如 `--require`）是 RunAsNode 的姊妹通道，一并关闭 |
| `EnableNodeCliInspectArguments` | **ON（唯一保持 ON 的例外）** | e2e 的 `_electron.launch` 依赖 `--inspect=0` 建立调试通道（R9 源码级结论），关闭即静默砖掉测试门禁。补偿控制见下两行；inspect 仅在显式传 `--inspect` 时监听 |
| `OnlyLoadAppFromAsar` | **ON** | 生产包应用只能从 `resources/app.asar` 加载（无 app/folder/unpacked 回退）；argv 传目录路径一律拒绝 |
| `EnableEmbeddedAsarIntegrityValidation` | **ON** | app.asar 头必须匹配 EXE 内嵌摘要，篡改即启动 abort；electron-builder v26 在 afterPack 之前原生嵌入该资源（有真实数据，非空开关） |
| `EnableCookieEncryption` | **OFF** | Windows 专属：本应用不落 Chromium cookie（密钥走 safeStorage），关闭无代价；且该 fuse 为不可逆迁移（后开/回退都会废既有 cookie 库）。渲染层若引入 cookie 会话再连同密钥持久化策略重评 |
| `resetAdHocDarwinSignature` | n/a | win32-only 钩子，darwin 不适用 |
| V8 snapshot / file-privileges / WasmTrapHandlers | 未触碰 | 计划护栏"不开实验位"，保持 Electron 默认 |

## 密钥存储

- 所有密钥（`hfToken`、`search.tavilyApiKey` / `exaApiKey` / `braveApiKey`）**永不以明文落盘**。
- 主进程通过 `Electron safeStorage`（OS 钥匙串：Windows DPAPI / macOS Keychain / Linux libsecret）加密：
  - `encryptString(plain) -> Buffer` 封存为 `enc:v1:<base64>` 写入 `userData/settings.json`。
  - 读取时 `decryptString(Buffer) -> plain`，仅驻留内存。
- `safeStorage.isEncryptionAvailable() === false` 环境（CI / 未配置钥匙串的 Linux）降级为 `enc:fallback:v1:<base64>`（仍非明文，启动时警告；生产机应配置钥匙串）。
- 内存外展示一律 `maskSecret()` 脱敏（`ab****yz`），日志与 IPC 禁止打印明文。
- `settings.json` 中密钥字段若不以 `enc:` 前缀开头视为历史明文，读时兼容但立即重存以完成迁移。
- **DPAPI 威胁边界（诚实声明）**：Windows DPAPI 密钥绑定**当前登录用户**——同一用户账户下运行的恶意程序同样能调用解密 API 读取 `enc:v1:` 密文并还原明文。DPAPI 防的是**离线取证**（磁盘镜像、其他账户），**不防 same-user 进程**。若主机可能被同账户软件侵扰，应使用独立低权限账户或全盘加密 + 及时轮换（见下 {#rotation}）。

## 轮转 (Rotation) {#rotation}

> 建议定期（90 天）或在以下事件后立即轮转：成员变动、密钥泄露告警、系统重装/钥匙串迁移。

### 何时轮转

- 提供商侧密钥泄露 / 轮换提醒
- 运维交接、设备更换
- 自动化扫描命中 `settings.json` 明文历史版本

### 步骤

1. **在提供商处重新生成密钥**
   - Hugging Face: https://huggingface.co/settings/tokens → Create new token → 复制 `hf_...`
   - Tavily / Exa / Brave: 各自 Dashboard → Regenerate API Key
2. **在应用内更新（自动重加密）**
   - 打开「设置」页 → 对应 `MaskedInput` 点「编辑」→ 粘贴新密钥 → 失焦即 `saveSettings()` 自动 `encryptSecret()` 落盘。
   - 或调用主进程 API：`saveSettings({ hfToken: 'hf_...' })` / `saveSettings({ search: { tavilyApiKey: 'tvly-...' } })`
3. **或一键重加密（钥匙串更换场景）**
   ```ts
   import { rotateSecrets, getSettings } from './src/settings/settings'
   const { rotated, path } = rotateSecrets() // 用当前 OS 钥匙串重封全部密钥
   console.log(`rotated ${rotated} at ${path}`, getSettings().meta)
   ```
   - 适用：OS 重装后 DPAPI/Keychain 变更，需用新钥匙串重封现有密钥。
4. **验证**
   - 检查 `userData/settings.json` 中对应字段为 `enc:v1:...` 且 **不含明文**：`grep -v "hf_" settings.json`
   - 重启应用，设置页显示 `ab****yz` 脱敏，功能（搜索/HF 下载）正常。
5. **吊销旧密钥**
   - 在提供商侧删除/吊销旧 token，确认旧 token 调用返回 401。
6. **审计**
   - `settings.json` 的 `meta.updatedAt` 记录轮转时间；建议将轮转事件写入本地日志（不含明文，仅 `masked`）。

### 应急 — 疑似泄露

1. 立即在提供商侧吊销旧密钥。
2. 本地执行 `clearSecret('hfToken' | 'tavilyApiKey' | ...)` 清空落盘密文。
3. 按上文步骤 1-2 写入新密钥。
4. 检查 git 历史是否误提交过 `settings.json` / `userData/`：若有，`git filter-repo` 清理并轮转所有相关密钥。

### 约束

- `settings.json` 已加入 `.gitignore` 的 `userData/` 忽略，切勿手动移至仓库内。
- 端口/更新开关等非密钥字段为明文，仅密钥字段加密。
- 所有侧车仅 `127.0.0.1`，密钥不出本机网络。

## 更新机制：分阶段与签名语义（todo32）

单点实现 `src/main/updater.ts`（渲染层只见 `src/main/ipc/whitelist.ts` 的封闭 `UpdateStateEvent` 联合类型，不直接接触 electron-updater）。

**分阶段通道（staged）**：`electron-builder.yml` publish 块 = GitHub provider + `releaseType: draft` + `publishAutoUpdate: true`。放量由**人工 promote 节奏**控制（先 10% 关注度=不发、确认无报告后再全文发布，机器永不 promote）；`stagingPercentage` 客户端灰度键在 electron-builder 26 的 publish schema 中不存在（scheme.json 0 命中，强行写入会让整个构建校验失败，release-run 33830264348 教训后已移除，见 `electron-builder.yml` 注释与 c18578a）。发布通道事实：构建成功后由 electron-builder 的 GitHubPublisher 直接上传 Setup/Portable exe + `latest.yml` 到 tag 对应 draft Release（本地 `--publish always` 实测通过，release-run 33832401173 曾因 `scripts/pack-after-all.mjs` 返回旧版对象形状污染 asArray 上传队列而崩，已由返回 `string[]` 的契约测试钉死）。

**策略不变量**（计划强制，`src/main/updater.ts`）：
- `autoDownload=false` — 字节只在用户显式手势后移动；
- `autoInstallOnAppQuit=true` — 已下载更新在下次退出落地；
- `allowDowngrade=false` — 频道切换永不回退版本（channel 赋值后重新断言，防 electron-updater setter 翻转）；
- 永不强更：`quitAndInstall` 仅从横幅按钮（phase `downloaded`）触发；
- 启动后延迟 5 s 检查（`UPDATE_CHECK_INITIAL_DELAY_MS`），失败静默为 error 状态，更新永远是 best-effort UX 而非关键路径。

**未签名构建的 graceful 模式（"仅提示新版本"）**：v1 无代码签名（Azure Trusted Signing 个人档仅美/加，本账号区域不适用）。electron-updater 验签失败（`not signed by the application owner` / `Sign verification failed` / `publisherNames` / `certificate` 族字符串，v6.8.9 源实测）时置 `signatureUnavailable`，横幅改供手动 release 页链接而非安装按钮；`app-update.yml` ENOENT 属开发路径非签名问题，保持纯 error 不加横幅。SmartScreen 首启指引见 `docs/TROUBLESHOOTING.md`。

**离线/测试 kill-switch**：`LAS_DISABLE_UPDATE_CHECK=1`（`src/main/testSupport.ts` 解析，`src/main/index.ts` 生效）整体跳过延迟自动检查；e2e 与离线 CI 必带。

**SPIKE-PENDING-FINAL（draft 可见性）**：electron-updater × GitHub **draft release 客户端可见性未证实**（R3b UNKNOWN），须在 `v0.1.0` 发布时断言：① draft 不可见 → `releaseType` 改 prerelease + `LAS_UPDATE_CHANNEL=beta` 频道覆盖出货；② ~~yml 缺 stagingPercentage~~ 已定案：eb-26 schema 拒绝该键，灰度改为纯人工 promote 节奏（c18578a，无代码变更）。
> **tag v0.1.0 测试结果：服务端半边已验——GitHubPublisher 成功创建 draft Release 并上传 Setup/Portable exe + `latest.yml`（release-run 修复后 + 本地 `--publish always` 双确认）；draft 客户端可见性 = 待真机装有 0.0.x/无版本更新器探测（用户 QA 项，不可见则执行预案①）**

## 引擎供应链：spawn 前 sha256 校验链（todo30/34，LLM03）

分发清单 `scripts/gen-engine-manifest.mjs` → 随包 manifest；运行期 `src/engines/manifest.ts` 加载，`src/main/services.ts` 容器惰性构建 `src/engines/resolver.ts` 并只把**校验通过的 bin 路径**交给侧车 spawn。检测优先级联（`prefer` 可指定起点，仍向前穿透）：

1. **① 系统 PATH**：`llama-server`/`sd-cli`/`ollama` 以 `--version` 探针比对 manifest `minVersion` 下限（TALOS-2024-1912/13/14/16 恶意 GGUF 与 Probllama 教训的 r1 修复）；清单在位而二进制拒不报版本 → **拒绝**；低于下限 → 拒绝并记 `skipped` 诊断。11434 占用仲裁不在此层（由 `src/main/apiServer.ts` external-takeover 负责，见 `docs/ARCHITECTURE.md`）。
2. **② bundled-cpu**：`<resourcesPath>/engines/` 文件逐个 sha256 对比清单，失配 → 拒 spawn 并落 `skipped` 理由。
3. **③ gpu-pack**：`<userData>/engines/` 活动包（`src/engines/gpuPack.ts`）spawn 前校验——清单可读时清单钉值优先，否则安装期 `meta.json` 摘要兜底；下载校验失败整包移入 `.quarantine/`（永不静默删除、永不激活），resolver 级联自然退回 CPU 层（用户可感知的 GPU→CPU 降级，见 `docs/TROUBLESHOOTING.md`）。

**诚实边界**：开发环境清单缺失 = warn+pass（仅手搓包可达，下载器产物必带摘要）；清单**非法** = 拒绝一切不可校验二进制。CI 侧另有三道闸（todo34）：osv-scanner、SBOM diff、provenance，见 `.github/workflows/`。

## Agent 权限引擎与进程 jail（todo23-28，LLM01/05/06「致命三要素」优先）

**PermissionEngine**（`src/agent/policy/engine.ts`，纯模块）：
- **默认 ask、无 YOLO**：任何未列动作 `evaluate` 返回 `'ask'`（源码注释 verbatim："Unlisted actions default to 'ask' - never silent allow"）；全库不存在"跳过确认/全放行"开关——这是计划 Must-NOT，不是尚未实现。
- 优先级 `deny > ask > allow`，同类最长字面前缀胜出；`scope: session` 授权仅存内存、`destroy()` 即弃，永不落盘。
- **审计不可删改**：`audit_log` 由 `src/main/storage/migrations/002-permissions.sql` 的 `audit_log_no_update` / `audit_log_no_delete` 触发器 `RAISE(ABORT, 'audit_log is append-only')` 在 SQL 层强制 append-only——绕过应用直接改库也会被拒。
- 无界消耗闸：agent 循环 `MAX_ITERATIONS=25` 为硬上限（`src/agent/runner/agentLoop.ts`，调用方只可下调）。

**Job Object jail ≠ 容器级隔离（明示）**：`src/agent/jail/win32.ts` 把每个 agent 子进程整树纳入 Job（breakaway 永不授予：`BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK` 旗标从不设置），提供的是**进程树杀断与父死回收**，**没有任何 fs/net 限制**。安全边界在权限引擎与路径围栏（`src/agent/tools/fs/`），不在 jail。

- **Kaspersky 实测发现**（`src/agent/jail/native.ts` 头注）：开发机上 Kaspersky 注入钩子对 `SetInformationJobObject` **所有信息类**返回 `ERROR_BAD_LENGTH(24)`（以 .NET P/Invoke 已知 144 字节布局独立复核，非 koffi 布局错误），而 Create/Assign/Terminate/Close 正常。因此限额应用为 **best-effort**：失败降级为 `limits` 警告 + `limitsApplied=false`，`KILL_ON_JOB_CLOSE` 的"父进程崩溃 OS 自动收树"在受扰机上不成立。
- **双退路（诚实声明）**：显式杀死始终可用（`TerminateJobObject` 收整树）；原生层整体不可用时 `createJailWithFallback()`（`src/agent/jail/index.ts`）降级为 `taskkill /T /F` 树杀看门狗（`src/agent/jail/watchdog.ts`）——保证更弱（父进程先死则无人收树），降级**必发警告、绝不静默**。
