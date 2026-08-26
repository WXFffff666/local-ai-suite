# SECURITY — 安全策略

> 本项目 **MIT** 开源，本地优先。安全目标：密钥不出本机、端口仅 `127.0.0.1`、AGPL 仅侧车隔离、漏洞快速闭环。

---

## 1. 支持的版本

| 版本 | 是否支持安全更新 |
|------|------------------|
| `0.1.x`（`main`） | ✅ 支持 |
| `< 0.1.0` | ❌ 请升级至最新 `main` / 最新 Release |

> 建议始终跟踪最新 Release；安全修复会以 `patch` 优先发布。

---

## 2. 漏洞上报（Reporting a Vulnerability）

**请勿直接公开提 Issue 披露可被利用的细节。**

### 2.1 首选渠道

- **GitHub Private Advisory**：仓库 `Security → Advisories → Report a vulnerability`（推荐，可私密协作）。
- **邮件**：`205728233+WXFffff666@users.noreply.github.com`，标题前缀 `[SECURITY] local-ai-suite`。

### 2.2 报告请包含

- 影响范围（版本 / 平台 / 组件：如 `safeStorage` / `SidecarManager` / `search/cloud.ts`）
- 复现步骤 / PoC（无需真实密钥）
- 预期影响（密钥泄露 / 本地提权 / 端口暴露 / 依赖投毒等）
- 是否已公开、是否在野利用

### 2.3 响应承诺

| 阶段 | 时限 |
|------|------|
| 确认收到 | 48 小时内 |
| 初步评估与分级 | 7 天内 |
| 修复与发布（高危） | 14 天内发布 patch / 缓解措施 |
| 披露协调 | 修复发布后与报告者协商公开时间，致谢（若同意） |

> 我们遵循 **Coordinated Disclosure**：在修复发布前请勿公开细节；我们会在 Advisory / Release Notes 中致谢报告者（可匿名）。

---

## 3. 安全边界

### 3.1 密钥存储

- 密钥（`hfToken`、`tavilyApiKey` / `exaApiKey` / `braveApiKey`）仅以 `enc:v1:<base64>` 落盘至 `userData/settings.json`，由 `Electron safeStorage`（Windows DPAPI / macOS Keychain / Linux libsecret）加密。
- `isEncryptionAvailable() === false` 时降级为 `enc:fallback:v1:<base64>` 并启动警告；生产机应配置钥匙串。
- 展示与日志一律 `maskSecret()` 脱敏，IPC 禁止透传明文；历史明文自动迁移重加密。
- 轮转与应急见 `docs/SECURITY.md`（90 天建议轮转、泄露后立即吊销与 `clearSecret` 重写）。

### 3.2 网络与进程

- 所有侧车强制 `127.0.0.1:11434-11437`，禁止 `0.0.0.0`；CI 扫描阻断 `0.0.0.0` 监听与新增遥测域名。
- 云搜索仅在用户填入 Key 且主动搜索时经 HTTPS 出站；未配置时仅走本地 SearXNG。
- 主进程 `sandbox + contextIsolation + nodeIntegration:false`，IPC 仅 `AllowedChannel` 白名单。

### 3.3 供应链

- 主进程仅链 `MIT / Apache-2.0 / BSD / ISC / 0BSD` 等宽松许可；`AGPL/GPL` 仅在 `sidecars/` 独立进程经 `127.0.0.1` 通信，不链接进主进程。
- 门禁 `node scripts/check-licenses.mjs` 阻断违规依赖；`--sbom` 生成 `sbom.json`（CycloneDX-lite）。
- 体积预算 `node scripts/check-pack-size.mjs`（<150 MB 不含模型）防止依赖膨胀。

### 3.4 隐私

- 本地优先、零联网可聊、数据仅落 `userData`，详见 `PRIVACY.md`；无遥测、无埋点。

---

## 4. CI 安全门禁

CI 在 `push` / `pull_request` 至 `main`/`master` 时执行：

```bash
pnpm typecheck
pnpm test
node scripts/check-licenses.mjs   # 许可白名单 + AGPL 隔离
node scripts/check-privacy.mjs    # 0.0.0.0 / 遥测 / userData 边界（见下文）
node scripts/check-pack-size.mjs  # 体积预算
```

任一失败阻断合并/发布。工作流见 `.github/workflows/ci.yml`。

---

## 5. 加固建议（用户侧）

- 及时更新至最新 Release；开启系统钥匙串（Windows Hello / macOS Keychain / Linux libsecret）。
- 定期（90 天）轮转 `hfToken` 与云搜索 Key；疑似泄露时立即在提供商侧吊销并本地 `clearSecret` 重写。
- 切勿将 `userData/` / `models/` / `.env` 提交至 git（已在 `.gitignore`）。
- 仅从本仓库 Release 安装可执行包，校验 `SHA256`（如提供）。

---

## 6. 致谢

感谢所有负责任披露的研究者。修复发布后，我们将在 Advisory 与 Release Notes 中致谢（可匿名/化名）。

---

*最后更新：2026-08-22 · 维护者：WXFffff666*
