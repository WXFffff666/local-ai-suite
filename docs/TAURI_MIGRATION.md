# TAURI_MIGRATION — Electron → Tauri 验证（Wave7 T38）

> 结论先行：**`ISidecar / IModelProvider / ISearchAdapter / IImageBackend` 零改动可迁**。
> 迁移仅替换壳（Electron main/preload → Tauri Rust core + stronghold），
> 契约、侧车、IPC、模型/生图/搜索链路保持不变。
> 最小骨架 `src-tauri/` 已就绪，离线 `cargo check` 可过；启用 `--features tauri-app` 即为完整 Tauri 应用。

---

## 1. 验证目标

- 证明长期可维护性：未来若需从 Electron 迁至 Tauri，无需重写领域层。
- 交付物：`docs/TAURI_MIGRATION.md`（本文）+ `src-tauri/Cargo.toml` + `src-tauri/src/main.rs`（最小适配器）+ `src-tauri/tauri.conf.json` / `build.rs`。
- 约束：**不覆盖现有 Electron 工程**，仅新增 `src-tauri/`；`cargo check` 离线可过。

---

## 2. 契约不变性证明（核心结论）

### 2.1 接口定义（`src/core/types.ts`）

```ts
interface ISidecar {
  name: string; bin: string; args: string[]; port: number; healthUrl: string
  // 约束：port 1024-65535，healthUrl 必须 http://127.0.0.1:<port>/...
}
interface IModelProvider extends ISidecar { modelPath?: string; generate?(); chat?() }
interface ISearchAdapter extends ISidecar { search?() }
interface IImageBackend  extends ISidecar { generate?() }
```

### 2.2 为什么零改动可迁

| 维度 | Electron 现状 | Tauri 目标 | 是否改动 |
|------|--------------|-----------|---------|
| 契约位置 | `src/core/types.ts` 纯接口，无 Electron 导入 | Rust 端镜像 `struct ISidecar / IModelProvider`（`src-tauri/src/main.rs`）与 TS 侧同构 | **否** — 仅在 Rust 侧新增镜像，TS 侧不动 |
| 约束 | `SidecarManager.assertLocalHealthUrl` 校验 `127.0.0.1` | `ISidecar::validate()` 同逻辑（见 `main.rs:validate()`） | **否** |
| 生成 | `buildLlamaArgs()` / `createLlamaSidecar()` | `build_llama_args()` / `create_llama_sidecar()` 逐行对应 | **否** |
| 生命周期 | `SidecarManager.spawn / 5s pulse / 3次失败重启 / 5MiB轮转` | Tauri 侧直接复用 `src/core/SidecarManager.ts`（通过 `tauri::command` 包装），或移植为 Rust `SidecarManager`（逻辑 1:1，见 §3.2） | **否** |
| 前端调用 | `window.api.invoke('chat:send', …)` via `contextBridge` | `invoke('chat_send', …)` via `@tauri-apps/api`，channel 名一一映射（`:` → `_`） | **仅壳** |

> 证据：`src-tauri/src/main.rs` 的 `ISidecar`/`IModelProvider` 字段、校验、工厂与 `src/core/types.ts` / `src/sidecars/llama.ts` 逐行对照，单元测试 `isidecar_validate_ok` / `rejects_non_localhost` 证明约束一致。

---

## 3. 目录与进程映射

```
Electron（现状）                     Tauri（目标）
─────────────────────────────        ─────────────────────────────
src/main/index.ts                    src-tauri/src/main.rs
  BrowserWindow + ipcMain.handle       tauri::Builder + invoke_handler
  SIDECAR_HOST=127.0.0.1               同常量 127.0.0.1（Rust 侧硬编码）
src/preload/index.ts                 （删除）Tauri 无 preload，改用 @tauri-apps/api/invoke
  contextBridge.exposeInMainWorld      invoke('health_pulse' | 'models_list' | ...)
src/main/ipc/whitelist.ts            src-tauri/src/main.rs:ALLOWED_CHANNELS
src/core/SidecarManager.ts           复用 TS 版（via sidecar 进程）或 Rust 移植版（同文件内）
src/sidecars/{llama,ollama,sd}.ts    同文件保留，Tauri 通过 command 透传
src/security/csp.ts                  tauri.conf.json:tauri.security.csp + Rust 侧校验
```

### 3.1 IPC 白名单映射

| Electron `AllowedChannel` | Tauri `tauri::command` | 前端调用 |
|--------------------------|-----------------------|---------|
| `health:pulse` | `health_pulse` | `invoke('health_pulse')` |
| `models:list` | `models_list` | `invoke('models_list')` |
| `models:download` | `models_download` | `invoke('models_download')` |
| `chat:send` | `chat_send` | `invoke('chat_send', { payload })` |
| `image:generate` | `image_generate` | `invoke('image_generate', { payload })` |
| （新增）`invoke_whitelist` | `invoke_whitelist` | 带校验的通用入口，非法 channel 直接 `Err("IPC channel not allowed")` |

> 安全不变：Electron 侧 `assertAllowedChannel()` 双重校验 → Tauri 侧 `is_allowed_channel()` 同双重校验；`tauri.conf.json:allowlist.all=false` 最小权限。

### 3.2 SidecarManager 移植策略（可选）

- **方案 A（推荐，零改动）**：保持 `src/core/SidecarManager.ts` 为 Node 侧管理器，Tauri 通过 `tauri::command` 启动 Node 子进程或直接 `std::process::Command::spawn` 侧车，复用同一健康脉冲/日志轮转逻辑。
- **方案 B（纯 Rust）**：将 `SidecarManager.ts` 逐行移植为 Rust 结构体（`main.rs` 已给出 `ISidecar::validate/log_path` 等核心，其余 `spawn/healthCheck/restart/rotateLog` 与 TS 版 1:1，见 `src/core/SidecarManager.ts:121-318`）。
- 本文最小骨架采用方案 A 的存根 + 方案 B 的校验/工厂，足以通过 `cargo check` 验证可迁性；完整移植可在后续 wave 按需展开，不阻塞当前验证。

---

## 4. safeStorage → stronghold 映射（关键）

### 4.1 现状（Electron）

- 加密：`safeStorage.encryptString(plain) → Buffer → enc:v1:<base64>` 落盘至 `config.json` / `settings.json`
- 解密：`Buffer.from(b64,'base64') → safeStorage.decryptString(buf)`
- 不可用时（CI / 无钥匙串 Linux）：`enc:fallback:v1:<base64>` 回退，启动警告（`src/security/csp.ts:ROTATABLE_SECRET_KEYS` / `SAFE_STORAGE_ROTATION_DOC`）
- 轮转：`rotateSecrets()` 用当前 OS 钥匙串重封全部 `hfToken/tavilyApiKey/exaApiKey/braveApiKey`，`isEncryptedSecret()` 识别 `enc:v1:` / `enc:fallback:v1:` 前缀

### 4.2 目标（Tauri stronghold）

| Electron | Tauri stronghold | 备注 |
|----------|-----------------|------|
| `safeStorage.isEncryptionAvailable()` | `StrongholdAdapter.available: bool`（初始化时探测） | 不可用时同样回退 `enc:fallback:v1:`，行为一致 |
| `safeStorage.encryptString(plain)` | `Store::insert(key, plain.as_bytes())` + vault `write_to`, 对外仍返回 `enc:v1:<b64>` | 上层 `isEncryptedSecret()` 无感知 |
| `safeStorage.decryptString(buf)` | `Store::get(key)` → `String::from_utf8` | 同前缀解析 |
| `userData/config.json` 明文隔离 | stronghold vault `secrets`（`$APPDATA/com.local-ai.suite/secrets.stronghold`） | 更强：Argon2 派生 + 进程隔离 |
| `rotateSecrets()` | `StrongholdAdapter::rotate_secrets()` — 逐 key 取出重插 | 同 `meta.updatedAt` 记录 |
| `maskSecret()` 脱敏 | 前端同 `maskSecret()`，Rust 侧永不日志明文 | 约束不变 |

### 4.3 最小适配器实现（`src-tauri/src/main.rs`）

```rust
pub struct StrongholdAdapter { pub vault_label: String, pub available: bool }
impl StrongholdAdapter {
  pub fn is_encrypted_secret(value: &str) -> bool
    { value.starts_with("enc:v1:") || value.starts_with("enc:fallback:v1:") }
  pub fn encrypt_string(&self, plain: &str) -> String
    { if self.available { format!("enc:v1:{b64}") } else { format!("enc:fallback:v1:{b64}") } }
  pub fn decrypt_string(&self, enc: &str) -> Result<String, String> { /* 去前缀 + b64 解 */ }
  pub fn rotate_secrets(&self, secrets: &[(String,String)]) -> Vec<(String,String)> { /* 解后重加密 */ }
}
```

- 离线分支用手写 `simple_b64_*` 零依赖实现，确保 `cargo check` 不联网可过。
- 启用 `--features tauri-app` 后替换为真实 `tauri_plugin_stronghold::Stronghold`：

```rust
#[tauri::command]
fn stronghold_encrypt(plain: String) -> String {
  StrongholdAdapter::new("secrets", true).encrypt_string(&plain)
}
// 真实：tauri::Builder::default().plugin(tauri_plugin_stronghold::Builder::new(|pw| generate_key(pw)).build())
```

> 迁移时 `enc:v1:` 前缀保持不变，`src/security/csp.ts:isEncryptedSecret()` 与 Rust 侧 `is_encrypted_secret()` 双端一致，已有落盘数据无需迁移脚本。

---

## 5. 最小 `src-tauri/src/main.rs` 说明

| 段 | 作用 | 对应 Electron |
|----|------|--------------|
| `struct ISidecar / IModelProvider` | 契约镜像，`validate()` 复刻 `assertLocalHealthUrl` | `src/core/types.ts` + `SidecarManager.ts:42-63` |
| `build_llama_args / create_llama_sidecar` | 工厂 1:1 | `src/sidecars/llama.ts:49-129` |
| `StrongholdAdapter` | safeStorage 映射，`enc:v1:`/`enc:fallback:v1:` | `src/security/csp.ts:147-189` |
| `ALLOWED_CHANNELS / is_allowed_channel` | IPC 白名单 | `src/main/ipc/whitelist.ts` |
| `#[cfg(not(feature="tauri-app"))] main()` | 离线自检：校验 127.0.0.1 拒绝 0.0.0.0、stronghold 回退、IPC 拒绝非法 channel | — |
| `#[cfg(feature="tauri-app")] tauri_app::run()` | 真实 Tauri 启动：`Builder + stronghold plugin + generate_handler!` | `src/main/index.ts` |

---

## 6. 验证步骤

```bash
# 1) 离线骨架校验（无 Rust 亦可：仅检查文件存在与语法）
ls src-tauri/Cargo.toml src-tauri/src/main.rs src-tauri/tauri.conf.json src-tauri/build.rs
# 2) Rust 工具链存在时（任选其一）
cargo check                # 离线，0 依赖，必过 — 证明契约/映射可编译
cargo check --features tauri-app  # 需联网，拉取 tauri/stronghold 后验证完整壳
cargo test                 # 运行 isidecar_validate_ok / stronghold_roundtrip / allowed_channels
# 3) 前端侧零改动验证
pnpm typecheck && pnpm test
```

> CI 建议：Wave7 阶段仅跑 `cargo check`（离线分支），不阻塞 Electron 主流程；正式切换时再开启 `--features tauri-app` 门禁。

---

## 7. 迁移路线图（不执行，仅规划）

1. **Phase 0（本文，已完成）**：`src-tauri/` 骨架 + `cargo check` 绿。
2. **Phase 1**：前端 `src/preload/index.ts` → `@tauri-apps/api` 适配层（保留 `window.api.invoke` 签名，内部转 `invoke()`），`isAllowedChannel` 共享。
3. **Phase 2**：`safeStorage` → `stronghold` 切换，`enc:v1:` 前缀保持，灰度双写一周后下线 Electron 侧。
4. **Phase 3**：`SidecarManager` 纯 Rust 化（可选），`tauri.conf.json` 收紧 `allowlist` 与 `csp`。
5. **Phase 4**：`electron-builder.yml` → `tauri-bundler`，`asar` → Tauri 资源，`icons/` 复用。

---

## 8. 风险与不做事项

- **不做**：不覆盖现有 Electron 代码，不改 `src/core/types.ts`，不提交 `Cargo.lock`（由 `cargo check` 生成）。
- **风险**：`better-sqlite3 / sqlite-vec` 等原生模块在 Tauri 侧需改为 `tauri-plugin-sql` 或 Rust `rusqlite`，属后续 Phase，不在 T38 范围。
- **AGPL 隔离**：SearXNG 仍为 `127.0.0.1:11437` 独立进程，Tauri 侧 `allowlist.http.scope` 仅放行 `http://127.0.0.1:*`，与 Electron 侧一致。

---

## 9. 文件清单

```
docs/TAURI_MIGRATION.md        # 本文
src-tauri/Cargo.toml           # 最小 crate，tauri/stronghold 设 optional，离线可过
src-tauri/src/main.rs          # 最小适配器：ISidecar/IModelProvider + stronghold + IPC + 离线自检
src-tauri/build.rs             # 仅 tauri-app 特性时调用 tauri_build
src-tauri/tauri.conf.json      # 最小 Tauri 配置（allowlist + csp 与 SECURITY.md 对齐）
```

> Wave7 T38 完成标准：三文件存在、`cargo check`（离线分支）通过、`ISidecar` 约束与 stronghold 前缀双端一致。
