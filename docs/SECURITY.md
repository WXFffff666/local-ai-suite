# SECURITY

## 密钥存储

- 所有密钥（`hfToken`、`search.tavilyApiKey` / `exaApiKey` / `braveApiKey`）**永不以明文落盘**。
- 主进程通过 `Electron safeStorage`（OS 钥匙串：Windows DPAPI / macOS Keychain / Linux libsecret）加密：
  - `encryptString(plain) -> Buffer` 封存为 `enc:v1:<base64>` 写入 `userData/settings.json`。
  - 读取时 `decryptString(Buffer) -> plain`，仅驻留内存。
- `safeStorage.isEncryptionAvailable() === false` 环境（CI / 未配置钥匙串的 Linux）降级为 `enc:fallback:v1:<base64>`（仍非明文，启动时警告；生产机应配置钥匙串）。
- 内存外展示一律 `maskSecret()` 脱敏（`ab****yz`），日志与 IPC 禁止打印明文。
- `settings.json` 中密钥字段若不以 `enc:` 前缀开头视为历史明文，读时兼容但立即重存以完成迁移。

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
