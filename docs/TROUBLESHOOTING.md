# TROUBLESHOOTING — 常见故障与用户指引（todo35）

> 原则：本文只解释**应用自己会显示的状态与错误串**（可在源码中 grep 到），不承诺任何源码之外的行为。安全语义详见 `docs/SECURITY.md`，网络边界详见 `PRIVACY.md`。

---

## 1. Windows SmartScreen「未知发布者」首启拦截

**现象**：双击 `Local AI Suite-Setup-x64`（或 portable exe）时蓝底弹窗"Windows 已保护你的电脑 / 已阻止启动此未识别的应用"。

**原因（诚实说明）**：v1 安装包**没有代码签名**。签名证书的现实约束：Azure Trusted Signing 个人档仅开放美/加，本账号区域不适用（结论与路线见 `docs/SECURITY.md` 更新机制节与计划 Appendix C）。SmartScreen 对新发布、无下载声誉的 exe 一律弹此警告——**与是否含恶意无关，属默认拦截**。

**怎么办**：
1. 在警告弹窗点 **「更多信息」→「仍要运行」**（每个新构建首次安装时各出现一次）。
2. 请始终从 GitHub Releases 官方页下载，并核对随包校验信息；若中途文件被改动，asar 完整性校验会让应用**启动即退出**（fuse `EnableEmbeddedAsarIntegrityValidation`，见 `scripts/fuses.mjs`），此时应重新下载。
3. **误报申诉（开发者通道）**：欢迎把安装包提交给 Microsoft 做反恶意软件误报审核——
   https://www.microsoft.com/wdsi/filesubmission （提交时选 *Software developer*，附下载直链与本仓库地址）。随着下载/使用声誉积累，后续版本警告自然减少。

**红线：绝不自动添加 Windows Defender 排除项。** 本应用不会（也永远不会）替你写入排除路径、修改实时防护或调用任何 `Add-MpPreference`。如果你因第三方杀软的拦截决定手工加排除，那是你对自己主机的选择——请只排除**安装目录**，不要排除整个磁盘或"下载"文件夹，也不要关闭实时防护。

---

## 2. GPU 引擎包被杀软隔离 / 自动降回 CPU

**现象**：设置页引擎状态显示 CPU 来源，或在下载 GPU 加速包（llama.cpp / sd-cli 的 CUDA/Vulkan 变体）后提示「引擎包损坏，已隔离」；有时杀软报"已删除文件"。

**两层机制要分清**：

1. **应用内隔离（设计行为）**：GPU 包下载后先做 sha256 校验，失配整包移入 `<userData>/engines/.quarantine/`，**永不激活也永不静默删除**（`src/engines/gpuPack.ts`）；随后 `src/engines/resolver.ts` 的级联自然回落到安装包自带 CPU 版——功能不丢，只是慢。看到"已隔离/降级 CPU"首先意味着**完整性校验替你挡住了坏字节**。
2. **第三方杀软误报（外部行为）**：未签名的 llama.cpp/sd-cli 构建（尤其带 CUDA 加载器的变体）常被启发式引擎误杀，文件会在你不知情时从磁盘消失。此时 resolver 报 `missing` 类理由（如 `active gpu pack 'cuda' missing (no meta.json)` / `binary missing`），同样安全回落到 CPU。

**怎么办**：在杀软 quarantine/恢复区找回并**选择信任的只有你**——若坚持要用 GPU 包，可在其设置里为你自己下载、且 sha256 与应用内 `meta.json` 摘要吻合的目录做**手工、逐个**的排除；应用不代劳（理由同第 1 节红线）。之后到 设置 → 引擎 重新下载，校验通过即自动激活（`src/main/handlers/enginesIpc.ts` 的下载流程）。GPU→CPU 降级本身无需处理：应用已在正确的一侧。

---

## 3. 端口 11434 冲突（OpenAI 兼容层）

**背景**：应用对 OpenAI 兼容端口的**固定承诺**是 `127.0.0.1:11434`（OpenCode/Continue 等集成配置以此为准，"端口保持固定承诺、绝不换口"——`src/main/apiServer.ts`）。启动时按三种结局仲裁：

| 状态 | 含义 | 你需要做什么 |
|---|---|---|
| `embedded` | 端口空闲，应用自建兼容层 | 无 |
| `external-takeover` | 探测到**兼容服务已在服务**（典型：系统安装的 Ollama），应用**不换口、不双起**，直接接管复用其 `/v1` | 一般无。若状态标记 `degraded`（对端版本低于安全下限 `0.1.13`），托盘会有告警：升级外部 Ollama 后重启应用 |
| `conflict` | 端口被**非兼容进程**占用 | 见下 |

**冲突时的应用内指引**：持久 toast（代码 `api-port-conflict`）原文——「本地 API 端口 11434 被占用 …… 请关闭占用进程（可运行 `netstat -ano | findstr :11434` 定位 PID）后重启应用」。拿着 PID 在任务管理器"详细信息"页查凶手（常见：另一个版本的 Ollama、开发时残留的 llama-server、其它占 11434 的工具），结束该进程后重启本应用即可。设置页与托盘始终显示当前仲裁状态（`src/renderer/src/pages/SettingsPage.tsx`）。

---

## 4. 卸载 / 重装：你的数据去哪了

- **卸载器不碰用户数据**：NSIS 配置未开启 `deleteAppDataOnUninstall`（`electron-builder.yml`），卸载后 `%APPDATA%\local-ai-suite`（`settings.json`、`app.db`、`vectors.db`、`gallery/`、`logs/`、已下载的 `engines/`）与你自己设置的 `modelsDir` **全部原样保留**。
- **重装即续用**：装回同一路径时自动读取旧 `userData`，历史会话、画廊、引擎与模型都在。
- **想彻底清除**：手动删除 `%APPDATA%\local-ai-suite`（及自定义 `modelsDir`）。**不可逆**，先走 设置 → 导出。
- **一个 DPAPI 边界**：`settings.json` 里的密钥密文由 Windows DPAPI 绑定**当前 Windows 账户**加密（威胁模型详见 `docs/SECURITY.md` 密钥存储节）——换机或换 Windows 用户后密文无法解密属预期行为，请重新填密钥，或在原账户用 `rotateSecrets()` 重封（见 `docs/SECURITY.md` {#rotation}）。

---

## 5. 日志在哪里

主进程与侧车日志在 `userData/logs/`（5 MiB 轮转，不含密钥明文）；也可经托盘菜单 **「打开日志目录」**（`shell.openPath`，见 `src/main/tray.ts`）直达。提 issue / 向 Microsoft 提交误报时请附上复现时段的日志。
