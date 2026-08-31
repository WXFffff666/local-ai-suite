# PRIVACY — 隐私声明

> **一句话承诺：本地优先，零联网可聊，数据仅落 `userData`。** 本应用无遥测、无追踪、无埋点。

---

## 1. 本地优先（Local-First）

| 原则 | 说明 |
|------|------|
| 推理本地闭环 | LLM / Embedding / 生图推理均在 `127.0.0.1` 侧车完成（`llama-server :11435` / `sd-cli :11436` / Ollama 兼容层 `:11434`），不向任何远端发送 prompt、上下文或图像 |
| 存储本地 | 聊天记录、画廊、索引、向量均落于 `app.getPath('userData')` 本地 SQLite (`better-sqlite3` + `sqlite-vec`)，不在云端存储 |
| 侧车隔离 | 所有侧车仅绑定 `127.0.0.1`，禁止 `0.0.0.0` 对外暴露；主进程通过 `127.0.0.1` HTTP 与侧车通信 |
| 禁止遥测 | 不集成任何 analytics / tracking SDK；不发送行为埋点、崩溃上报或设备指纹至第三方 |

---

## 2. 零联网可聊（Offline Capable）

- **运行时零公网依赖**：已安装模型后，聊天、改写、嵌入、生图、本地搜索（SearXNG 默认 `:7788`，可在设置覆盖）与画廊全功能可离线使用。
- **联网仅在以下显式场景**（均可关闭/拒绝）：

| 场景 | 是否必需 | 可关闭 |
|------|----------|--------|
| `pnpm install` 安装依赖 | 首次安装 | — |
| 模型下载（Hugging Face / 直链 → `models/`） | 按需 | 可离线导入本地 `.gguf` / `.safetensors` |
| 云搜索（Tavily / Exa / Brave） | 可选 | 未填 `API Key` 时自动隐藏，默认走本地 SearXNG |
| 更新检查（`https://api.github.com/repos/.../releases`） | 可选 | 设置页可关闭，仅 HTTPS `GET`，不携带私密数据 |

> 离线自检：断网后执行 `curl http://127.0.0.1:11434/v1/chat/completions` 与本地生图、本地 SearXNG 搜索，功能正常即代表零联网可聊。

---

## 3. 数据仅落 `userData`

### 3.1 落盘位置

| 数据 | 路径 | 说明 |
|------|------|------|
| 配置与密钥 | `userData/settings.json` | 密钥段 `enc:v1:<base64>` 经 `safeStorage` 加密（见下文），其余为明文配置 |
| 会话与历史 | `userData/app.db` / `vectors.db` | `better-sqlite3` 本地库 |
| 模型索引 | `models/models.json`（`*.tmp → rename` 原子写） | `.gitignore` 已忽略，不入库 |
| 模型权重 | `models/llm/` / `models/diffusion/` / `models/embedding/` | 仅下载器写入，不入库 |
| 画廊 | `userData/gallery/<id>/{original.png,thumb.png,meta.json}` | 五动词 `save/list/copy/insert/reuse` |
| 日志 | `userData/logs/`（5 MiB 轮转） | 侧车 stdout/stderr，不含密钥明文 |

> 除 `models/` 独立可配置外，其余均在 Electron `userData` 目录（Windows `%APPDATA%/local-ai-suite`，macOS `~/Library/Application Support/local-ai-suite`，Linux `~/.config/local-ai-suite`）。

### 3.2 密钥加密

- 密钥字段（`hfToken`、`search.tavilyApiKey` / `exaApiKey` / `braveApiKey`）**永不以明文落盘**。
- 主进程 `Electron safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret）：`encryptString(plain) → Buffer` 封存为 `enc:v1:<base64>`；读取时 `decryptString(Buffer) → plain` 仅驻留内存。
- `isEncryptionAvailable() === false` 时降级为 `enc:fallback:v1:<base64>` 并启动警告；生产机应配置系统钥匙串。
- 内存外展示一律 `maskSecret()` 脱敏（`ab****yz`），日志与 IPC 禁止打印明文。
- 详见 `docs/SECURITY.md` 的轮转与应急流程。

### 3.3 不收集什么

- 不收集姓名、邮箱、IP 轨迹、位置、通讯录。
- 不读取 `userData` / `models/` 之外的用户文件。
- 不将 prompt、文档片段、图像上传至任何服务器（云搜索 `snippet` 仅在用户主动发起且已配置 Key 时经 HTTPS 发出，且可随时关闭）。

---

## 4. 网络与端口

| 端口 | 服务 | 绑定 | 说明 |
|------|------|------|------|
| `11434` | Ollama / OpenAI 兼容层 | `127.0.0.1` | `apiKey` 约定 `ollama`，零鉴权，仅本机 |
| `11435` | `llama-server` | `127.0.0.1` | `/completion` SSE |
| `11436` | `sd-cli` | `127.0.0.1` | `/generate` |
| `7788` | SearXNG | `127.0.0.1` | 本地搜索，AGPL 隔离侧车（默认端口，可在设置覆盖） |

> 门禁：CI 扫描禁止 `0.0.0.0` 监听、禁止新增遥测域名；发布前 `scripts/check-privacy.mjs` 校验。

---

## 5. 用户控制

- **导出**：设置页可导出 `settings.json`（脱敏）与 `app.db`；画廊支持按 `id` 导出原图。
- **删除**：删除会话/画廊条目即从 `userData` 物理删除；卸载应用时 `userData` 可由用户手动清除。
- **关闭联网**：设置页关闭「云搜索」与「更新检查」后，运行时无任何出站 HTTPS。
- **迁移**：`modelsDir` 可指向任意盘符；`userData` 随系统用户目录迁移。

---

## 6. 第三方与合规

- 主进程仅链 `MIT / Apache-2.0 / BSD / ISC / 0BSD` 等宽松许可；`AGPL/GPL` 仅以独立进程运行于 `sidecars/`（见 `scripts/check-licenses.mjs` 门禁），不与隐私声明冲突。
- 10 项模型权重通过下载器按需拉取，不随仓库分发，受各自权重许可约束。
- 完整抄用清单与许可索引见 `THIRD_PARTY_NOTICES.md` 与 `docs/COPYING.md`；SBOM 见 `sbom.json`。

---

## 7. 联系与更新

- 本文件与 `SECURITY.md` 随版本更新；重大变更将在 Release Notes 中标注。
- 隐私相关问题请通过 `SECURITY.md` 中的安全联系方式提交（标明 `[Privacy]` 前缀）。
- 生效版本：`v0.1.0` · 最后更新：2026-08-22

---

*本声明不构成法律意见；如需合规审计，请以 `scripts/check-privacy.mjs` 与 `scripts/check-licenses.mjs` 的 CI 产出为准。*
