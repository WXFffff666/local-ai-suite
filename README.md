# Local AI Suite

本地模型一键安装与离线工作流套件 — Electron 桌面壳，模型与工作流均在 `127.0.0.1` 本地闭环。

> 基座：Electron 43 + electron-vite 5 + React 19 + TypeScript 5.9 · MIT 开源 · 详见 `docs/ARCHITECTURE.md` 与 `docs/COPYING.md`

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript)](https://www.typescriptlang.org/)

---

## 功能全景

| 功能 | 说明 | 模块 |
|------|------|------|
| 流式聊天 | SSE 全链路、多会话持久化（SQLite）、Markdown/代码高亮 | `src/chat/` |
| 视觉对话 | 图片消息 → VLM（`--mmproj` 通路），截图问答 | `src/chat/` · `src/main/overlay/` |
| 语音输入 | whisper.cpp 侧车，按住说话 → 转写入输入框 | `src/speech/whisper.ts` |
| 本地 OCR | PaddleOCR-json 子进程，图片提取文字（Chat 右键 / 画廊按钮） | `src/ocr/` |
| Agent 工具执行 | 权限引擎默认 ask（无 YOLO）、审计 append-only、Job Object/树杀 jail | `src/agent/` |
| 引擎管理 | llama.cpp/Ollama/sd-cli 检测优先解析，sha256 校验 + GPU 包下载/隔离 | `src/engines/` |
| 模型市场 | Hugging Face 浏览与下载（token 经 safeStorage 加密） | `src/market/hf.ts` |
| 混合 RAG | 每库独立 FTS + sqlite-vec 命名空间，引用可点 | `src/rag/` |
| MCP 集成 | stdio 本地子进程服务器，工具调用先过权限门 | `src/mcp/` |
| 快捷提问 | 全局热键呼出迷你窗，剪贴板预填（永不离机） | `src/main/quickask/` |
| 截图问屏 | 全局热键 → 遮罩选区 → VLM 三选快捷 chip | `src/main/overlay/` |
| 导出 | 会话/画廊导出与缓存清理 | `src/main/export/` |
| 系统集成 | `las://` 深链、开始菜单 Jump List、可选开机自启（默认关） | `src/main/export/jumplist.ts` · `src/renderer/src/pages/SettingsPage.tsx` |
| OpenAI 兼容层 | `127.0.0.1:11434`，OpenCode/Continue 直连；外部 Ollama 自动接管仲裁 | `src/main/apiServer.ts` |

> 安全/隐私/故障排查三册：`docs/SECURITY.md` · `PRIVACY.md` · `docs/TROUBLESHOOTING.md`（SmartScreen 首启、杀软隔离、端口冲突、卸载数据去向）。

---

## 5 分钟跑通

> 环境：Node.js 18+ · pnpm 9+ · Windows 10/11（macOS/Linux 同理，图标与签名见 `electron-builder.yml`）

```bash
# 1. 克隆
git clone https://github.com/WXFffff666/local-ai-suite.git
cd local-ai-suite

# 2. 安装依赖（仅此步需联网）
pnpm install

# 3. 启动开发窗口（热更新）
pnpm dev
# → Electron 窗口自动弹出，渲染层 http://127.0.0.1:5173 由 electron-vite 代理

# 4. 类型检查（双 tsconfig）
pnpm typecheck
# tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json

# 5. 构建产物（out/ + 可选安装包）
pnpm build        # 仅 electron-vite build → out/
pnpm pack         # 本机可安装目录（不发版）
pnpm dist:win     # Windows nsis x64 安装包 → release/
```

**验证清单**（任选其一即代表跑通）：

```bash
pnpm test         # Vitest 单元（registry / sidecars / queue / orchestrator）
pnpm test:e2e     # Playwright 端到端
curl http://127.0.0.1:11434/v1/models          # 侧车存活后（见下文集成）
```

> 离线说明：运行时零公网依赖；联网仅用于 `pnpm install`、模型下载与可选的云搜索/更新检查。`models/` 已被 `.gitignore` 忽略，绝不入库。

---

## 模型文件夹

本地模型统一落在项目根 `models/`（已被 `.gitignore` 忽略，可改 `settings → modelsDir` 指向任意盘符）。

```
models/
  models.json                         # ModelRegistry 原子写入的索引（.tmp→rename）
  llm/qwen3-4b-instruct-Q4_K_M.gguf   # GGUF
  llm/qwen2.5-7b-instruct-abliterated/
  embedding/bge-m3/
  diffusion/sd1.5-Q4_0.gguf            # 生图量化权重
  diffusion/sdxl-base-1.0.safetensors
```

| 能力 | 说明 |
|------|------|
| 热加载 | `src/models/registry.ts` 的 `ModelRegistry` 用 `chokidar` 深度监听 `models/`，`add/change/unlink` → 120 ms debounce 增量 `scan()` → `models.json.tmp → models.json` 原子写 → `onUpdate` 推送 UI |
| 识别 | `detectQuant()` 匹配 `Q4_K_M/Q8_0/F16/BF16/...`，`detectArch()` 匹配 `qwen3/llama/mistral/...`，`detectFormat()` 按扩展名分 `gguf/safetensors/onnx/bin` |
| 校验 | `<1 KB` 文件探针 4 字节 `GGUF` magic，损坏文件隔离不崩主进程 |
| 大文件 | 通过 Git LFS 或直链/HF 下载器拉取，不进 git 历史 |
| 编程入口 | `new ModelRegistry('./models').startWatch()` / `reloadModels(dir)` / `getModels()` / `readPersisted()` |

---

## 生图

本地生图由 `stable-diffusion.cpp` 单二进制 `sd-cli` 侧车驱动（MIT，无 AGPL 链接）。

### 侧车

- 二进制：`sd-cli`（`SD_BIN` 环境变量可覆盖）· 端口 `11436` · `http://127.0.0.1:11436/health` + `POST /generate`
- 参数：`buildSdArgs({ modelPath, quantization, cpuFallback, device, threads })` 拼 `--weight-type q4_0/q8_0/f16` / `--cpu` / `--device cuda|vulkan`
- 队列：`SdQueue` 串行化 `POST /generate`，避免并发压爆显存
- 回退：`generateWithCpuFallback()` 首试 GPU，命中 `cuda/vulkan/oom/out of memory/ggml.*failed` 自动用 CPU 重试一次

### 显存分级

`src/image/queue.ts` 的 `ImageQueue`（`concurrency=1`）在入队时自动分级：

| 显存 | 分级 | 策略 |
|------|------|------|
| `<4 GB` | `low` | 强制 `sd1.5-q4` (`q4_0`) |
| `<6 GB` | `medium` | `SDXL` 警告，建议 `512×512 / steps≤20` |
| `6–12 GB` | `high` | `SDXL` 正常 |
| `>12 GB` | `ultra` | 解锁 `FLUX` |

```ts
import { gradeModelRequest } from './src/image/queue'
gradeModelRequest(vramMB, 'sdxl') // → { allowed, downgraded, effectiveModel, warning }
```

### 队列与 SSE

- `POST /api/image/generate` 或 `POST /v1/images/generations` → `202 {jobId, warning, effectiveModel}`
- 进度：`GET /api/image/queue/:id/stream` 与 `GET /api/image/queue/stream` 为 `text/event-stream`（心跳 15 s），事件 `queued/progress/retry/done/failed/cancelled`
- 重试：默认 2 次，指数退避 `400ms·2^attempt`，仅对可重试错误（`429/5xx/超时/网络/OOM`），`toSseResponse()` / `sseForJob(id)` 直接返回 `Response`

### 画廊

`src/gallery/gallery.ts` 五动词，落盘 `gallery/<id>/{original.png, thumb.png, meta.json}`：

| 动词 | 调用 | 产物 |
|------|------|------|
| `save` | `save({b64, prompt, width, height, steps, seed, model, extra, baseDir?, id?})` | 三文件落盘 |
| `list` | `list({baseDir})` | 按 `createdAt` 倒序 `GalleryItem[]` |
| `copy` | `copy(id)` | `CopyPayload {path, b64, mime}` + 尽力写 `electron.clipboard` |
| `insert` | `insert(id, onInsert?)` | `InsertPayload {text, imagePath, b64, prompt}` 插入聊天 |
| `reuse` | `reuse(id)` | `ReuseParams` 直接喂回 `/generate` |

---

## 搜索

统一 `ISearchAdapter`，上层 `SearchOrchestrator` 实现 `search → rerank → cite` 全链路。

### 适配器

| 适配器 | 端口/协议 | 鉴权 | 费率提示 |
|--------|-----------|------|----------|
| **SearXNG**（本地，AGPL 隔离） | `127.0.0.1:7788`（默认端口，可在设置覆盖） `GET /search?q=` | 无 | 免费，离线可用 |
| **Tavily** | `POST https://api.tavily.com/search` | `TAVILY_API_KEY` | $0.008/次 |
| **Exa** | `POST https://api.exa.ai/search` | `x-api-key: EXA_API_KEY` | $0.005/次 |
| **Brave Search** | `GET https://api.search.brave.com/res/v1/web/search` | `X-Subscription-Token: BRAVE_API_KEY` | $0.003/次 |

云适配器未填隐藏：`createCloudAdapters({hideUnconfigured:true})` 仅返回已配置 key 的提供方，设置页由 `getCloudProviderMetas()` / `CLOUD_COST_HINTS` 渲染。SearXNG 为离线默认。

### Orchestrator

`src/search/orchestrator.ts`：

```ts
import { SearchOrchestrator } from './src/search/orchestrator'
const orch = new SearchOrchestrator(adapter, { count: 10, rerankTopK: 5 })
const { raw, deduped, ranked, cards, markdown } = await orch.search('Qwen3 本地部署')
const finalAnswer = orch.appendToAnswer(llmAnswer, cards)
// markdown 为：
// ---
// **来源**
// [1] [Title](url) — snippet
```

- 去重：`deduplicateByUrl()` 按 `url` 归一
- 重排：`scoreItem()` 本地确定性打分（`title 2.5× + snippet 1.0× + 覆盖度 1.5 + 全串匹配`），可注入 `reranker` 覆盖
- 引用：`toSourceCards()` → `SourceCard {id, title, url, snippet}` → `formatSourcesMarkdown()` → `appendSourcesToAnswer()`

---

## 集成 — OpenCode / Continue 联调

本地 OpenAI 兼容层 `http://127.0.0.1:11434/v1`（Ollama 或 `llama-server` 的 `/v1` 兼容封装），`apiKey` 任意非空（约定 `ollama`），零鉴权，**禁止 `0.0.0.0` 对外暴露**。

### OpenCode — `opencode.json`

```json
{
  "$schema": "https://opencode.ai/schema.json",
  "model": "qwen3-4b-instruct",
  "provider": {
    "openai": {
      "baseURL": "http://127.0.0.1:11434/v1",
      "apiKey": "ollama"
    }
  },
  "models": {
    "qwen3-4b-instruct": {
      "provider": "openai",
      "model": "qwen3-4b-instruct",
      "options": { "temperature": 0.2, "maxTokens": 4096 }
    }
  }
}
```

```bash
curl http://127.0.0.1:11434/v1/models
opencode run --model qwen3-4b-instruct "用一句话介绍 Local AI Suite"
```

### Continue — `~/.continue/config.yaml`

```yaml
name: Local AI Suite
version: 1.0.0
schema: v1
models:
  - name: Local Chat — Qwen3 4B
    provider: openai
    model: qwen3-4b-instruct
    apiBase: http://127.0.0.1:11434/v1
    apiKey: ollama
    roles: [chat, edit, apply]
    defaultRole: chat
    requestOptions: { timeout: 60000 }
  - name: Local Embed — BGE-M3
    provider: openai
    model: bge-m3
    apiBase: http://127.0.0.1:11434/v1
    apiKey: ollama
    roles: [embed]
tabAutocompleteModel:
  provider: openai
  model: qwen3-4b-instruct
  apiBase: http://127.0.0.1:11434/v1
  apiKey: ollama
```

> 完整可复制示例与自检清单见 [`docs/integrations/opencode.md`](docs/integrations/opencode.md) 与 [`docs/integrations/examples/`](docs/integrations/examples/)。

冒烟：

```bash
curl -s http://127.0.0.1:11434/v1/models | head -c 500
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-4b-instruct","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
curl -s http://127.0.0.1:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3","input":"hello"}'
```

---

## 架构

侧车全绑定 `127.0.0.1`，主进程仅链宽松许可，AGPL 仅以独立进程运行。`SidecarManager` 统一 `spawn / 5s健康脉冲 / 3次失败重启 / 5 MiB日志轮转`。

```
Renderer (React 19 + Zustand 5)
   │  contextBridge / AllowedChannel
   ▼
Main (BrowserWindow + IPC白名单) ──► SidecarManager ─┬─ llama-server  :11435  /completion SSE
                                      │              ├─ ollama        :11434  /v1/* (OpenAI兼容)
                                      │              ├─ sd-cli        :11436  /generate
                                      │              └─ SearXNG       :7788   /search 〔AGPL隔离〕
                                      │              └─ Cloud Adapters (Tavily/Exa/Brave) HTTPS
   ┌──────────────────────────────────┘
   ▼
ModelRegistry (chokidar热加载)   ImageQueue (显存分级+SSE+重试2)   Gallery (五动词)   SearchOrchestrator (search→rerank→cite)
```

> 完整 Mermaid 图、端口表、状态机与模块边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Electron 43（`sandbox + contextIsolation + nodeIntegration:false`） |
| 渲染层 | React 19 + TypeScript 5.9 + Vite 8（electron-vite 5） |
| 状态 | Zustand 5 |
| 持久化 | better-sqlite3 + sqlite-vec（向量检索） |
| 推理侧车 | llama.cpp `llama-server` + Ollama 兼容层 |
| 生图侧车 | stable-diffusion.cpp `sd-cli` |
| 搜索 | SearXNG（本地）+ Tavily/Exa/Brave（云，HTTPS） |
| 打包 | electron-builder 26（`asar + files白名单 + nsis/dmg/AppImage`） |

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 开发窗口（热更新） |
| `pnpm build` | `electron-vite build` → `out/` |
| `pnpm typecheck` | 双 `tsconfig` 类型检查 |
| `pnpm test` | Vitest 单元 |
| `pnpm test:e2e` | Playwright 端到端 |
| `pnpm pack` | 本机可安装目录 |
| `pnpm dist:win` | Windows `nsis x64` 安装包 |
| `node scripts/check-licenses.mjs` | 许可白名单门禁 |
| `node scripts/check-licenses.mjs --sbom` | 生成 `sbom.json` |
| `node scripts/check-pack-size.mjs` | 体积预算门禁（<150 MB 不含模型） |

---

## 许可与抄用

- 主项目 **MIT** — 见 [LICENSE](LICENSE)
- 47 项第三方抄用清单（6 组：桌面 8 / 推理 8 / 生图 8 / 搜索 11 / 模型 10 / 打包 2）与形态/思路/侧车/权重四类抄用方式见 [docs/COPYING.md](docs/COPYING.md)
- 完整合规清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，SBOM 见 `sbom.json`
- 安全：密钥经 `safeStorage` (DPAPI/Keychain/libsecret) 加密为 `enc:v1:<base64>`，详见 [docs/SECURITY.md](docs/SECURITY.md)

> 合规红线：主进程仅链 `MIT/Apache-2.0/BSD/ISC/0BSD`；`AGPL/GPL` 仅允许 `sidecars/` 独立进程（见 `scripts/check-licenses.mjs` 豁免）。
