# COPYING — 抄用标注与合规边界

> 本文件是 `THIRD_PARTY_NOTICES.md` 的合规执行版：说明「抄了什么、怎么抄、边界在哪、如何验证」。主项目 **MIT**（见 `LICENSE`），第三方权属以其仓库为准。

---

## 1. 合规总则

| 原则 | 含义 |
|------|------|
| 主进程仅链宽松许可 | `MIT / Apache-2.0 / BSD-3-Clause / ISC / 0BSD` 可静态/动态链接进 Electron 主进程 |
| AGPL/GPL 隔离侧车 | `AGPL-3.0 / GPL-3.0` 仅以 **独立子进程** 运行于 `sidecars/`，经 `127.0.0.1` 通信，不与主进程链接 |
| 权重不入库 | 所有模型权重仅通过下载器落盘至 `models/`（`.gitignore`），永不提交 |
| 门禁可验证 | `node scripts/check-licenses.mjs` 在 CI 阻断违规依赖；`--sbom` 生成 `sbom.json` |

---

## 2. 47 项抄用清单（6 组）

> 每项含 **Repo URL · 版本基线 · 许可 · 用途/抄用边界**。分组与 `THIRD_PARTY_NOTICES.md` 一致，编号连续。

### 2.1 桌面形态参考 — 8 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 抄用边界 |
|---|------|----------|----------|------|----------|
| 1 | Jan | v0.5.x | https://github.com/janhq/jan | Apache-2.0 | 侧车思想与本地 LLM 桌面形态参考，Apache-2.0 标杆 |
| 2 | LM Studio | v0.3.x | https://lmstudio.ai | Proprietary（免费闭源） | GGUF 量化筛选与下载 UX 形态参考；不链接代码 |
| 3 | Cherry Studio | v1.7.x | https://github.com/CherryHQ/cherry-studio | AGPL-3.0 | 多模型聚合与 reasoning 渲染参考；AGPL 仅形态参考 |
| 4 | Open WebUI | v0.6.x | https://github.com/open-webui/open-webui | MIT | 对话/知识库/RAG 形态参考 |
| 5 | AnythingLLM | v1.8.x | https://github.com/Mintplex-Labs/anything-llm | MIT | RAG/向量检索/MCP 基座，MIT 可复用思路 |
| 6 | Chatbox | v0.10.x | https://github.com/Bin-Huang/chatbox | GPL-3.0 | 轻量客户端与托盘/快捷键形态参考；GPL 不链接 |
| 7 | Msty | v1.2.x | https://msty.ai | Proprietary | 多提供方聚合与一键切换形态参考 |
| 8 | Lobe Chat | v1.60.x | https://github.com/lobehub/lobe-chat | MIT | 现代聊天 UI、插件与主题形态参考 |

### 2.2 本地推理 — 8 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 抄用边界 |
|---|------|----------|----------|------|----------|
| 9 | llama.cpp | b4820+ | https://github.com/ggml-org/llama.cpp | MIT | `llama-server` 侧车二进制来源 (`:11435`)，MIT 可直接集成 |
| 10 | whisper.cpp | v1.7.x | https://github.com/ggerganov/whisper.cpp | MIT | 语音转写侧车预留 |
| 11 | llama-cpp-python | v0.3.x | https://github.com/abetlen/llama-cpp-python | MIT | OpenAI 兼容封装思路参考 |
| 12 | Ollama | v0.6.x | https://github.com/ollama/ollama | MIT | `/api/*` 与 `/v1/*` 兼容层、`OLLAMA_MODELS` 定向思路 |
| 13 | LocalAI | v2.24.x | https://github.com/mudler/LocalAI | MIT | 本地 OpenAI 聚合方案参考 |
| 14 | vLLM | v0.8.x | https://github.com/vllm-project/vllm | Apache-2.0 | PagedAttention 思路（云端参考） |
| 15 | KoboldCpp | v1.79.x | https://github.com/LostRuins/koboldcpp | AGPL-3.0 | 角色扮演推理形态参考；仅 `sidecars/koboldcpp` 隔离 |
| 16 | MLX | v0.21.x | https://github.com/ml-explore/mlx | MIT | Apple Silicon 推理形态参考 |

### 2.3 本地生图 — 8 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 抄用边界 |
|---|------|----------|----------|------|----------|
| 17 | stable-diffusion-webui (A1111) | v1.10.x | https://github.com/AUTOMATIC1111/stable-diffusion-webui | AGPL-3.0 | 生图 WebUI 鼻祖形态参考；AGPL 不链接 |
| 18 | ComfyUI | v0.3.x | https://github.com/comfyanonymous/ComfyUI | GPL-3.0 | 节点式编排参考；GPL 不链接 |
| 19 | Fooocus | v2.5.x | https://github.com/lllyasviel/Fooocus | GPL-3.0 | `prompt→image` 零工作流交互参考 |
| 20 | InvokeAI | v5.5.x | https://github.com/invoke-ai/InvokeAI | Apache-2.0 | 队列/画廊/参数复用参考 |
| 21 | stable-diffusion.cpp (sd.cpp) | v0.12.x | https://github.com/leejet/stable-diffusion.cpp | MIT | `sd-cli` 单二进制侧车 (`:11436`)，MIT 可直接集成 |
| 22 | Diffusers | v0.33.x | https://github.com/huggingface/diffusers | Apache-2.0 | 扩散调度器参考 |
| 23 | SD.Next (vladmandic) | v2024.x | https://github.com/vladmandic/automatic | AGPL-3.0 | A1111 分支形态参考；AGPL 隔离 |
| 24 | SwarmUI | v0.9.x | https://github.com/mcmonkeyprojects/SwarmUI | MIT | 生图聚合与队列形态参考 |

### 2.4 搜索与编排 — 11 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 抄用边界 |
|---|------|----------|----------|------|----------|
| 25 | SearXNG | 2025.x | https://github.com/searxng/searxng | AGPL-3.0 | 本地搜索侧车 `sidecars/searxng`；AGPL 豁免仅该目录 |
| 26 | Tavily | v0.5.x | https://github.com/tavily-ai/tavily-python | MIT | 云搜索适配器 (`TAVILY_API_KEY`) |
| 27 | Exa | v1.6.x | https://github.com/exa-labs/exa-js | MIT | 云搜索适配器 (`EXA_API_KEY`) |
| 28 | Brave Search API | 2026-08 | https://brave.com/search/api/ | Proprietary API（客户端 MIT） | 云搜索适配器；$5/1k |
| 29 | Serper | 2026-08 | https://serper.dev | Proprietary API | 云搜索适配器；$0.008/credit |
| 30 | Bing Search API | 2026-08 | https://www.microsoft.com/en-us/bing/apis/bing-web-search-api | Proprietary API | 云搜索适配器；$7/1k |
| 31 | LangChain | v0.3.x | https://github.com/langchain-ai/langchain | MIT | `search→rerank→cite` 编排思路 |
| 32 | LlamaIndex | v0.12.x | https://github.com/run-llama/llama_index | MIT | RAG `as_query_engine` 思路 |
| 33 | AutoGen | v0.4.x | https://github.com/microsoft/autogen | MIT | 多智能体编排参考 |
| 34 | CrewAI | v0.100.x | https://github.com/crewAIInc/crewAI | MIT | 多智能体协作参考 |
| 35 | opencode | v0.5.x | https://github.com/sst/opencode | MIT | 编程助手集成验证 (`baseURL=http://127.0.0.1:11434/v1`) |

### 2.5 精选模型权重 — 10 项（仅下载器拉取，不入库）

> 权重通过首启向导 / HF 浏览器下载至 `models/`；仓库仅提供下载器与文档，不分发权重。

| # | 模型 | 版本基线 | HF Repo URL | 权重许可 | 用途 |
|---|------|----------|-------------|----------|------|
| 36 | Dolphin-Mistral-24B-Venice-Edition | 2025-05 | https://huggingface.co/cognitivecomputations/dolphin-24b-venice-edition | Apache-2.0 | 创意写作演示，Q4_K_M GGUF |
| 37 | Mistral-Nemo-Instruct-2407 | 2407 | https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407 | Apache-2.0 | 通用指令微调 |
| 38 | WizardLM-2-8x22B | 2024-04 | https://huggingface.co/alpindale/WizardLM-2-8x22B | Apache-2.0 | 高质量推理 |
| 39 | Nous-Hermes-2-Mistral-7B-DPO | 2024-02 | https://huggingface.co/NousResearch/Nous-Hermes-2-Mistral-7B-DPO | Apache-2.0 | DPO 助手微调 |
| 40 | MythoMax-L2-13B | v1.0 | https://huggingface.co/Gryphe/MythoMax-L2-13B | MIT（衍生） | 角色扮演 |
| 41 | OpenHermes-2.5-Mistral-7B | 2024-01 | https://huggingface.co/teknium/OpenHermes-2.5-Mistral-7B | Apache-2.0 | 开放指令微调 |
| 42 | Gemma-2-9B-It-Abliterated | 2024-09 | https://huggingface.co/mlabonne/gemma-2-9b-it-abliterated | Gemma License | 去审查分支 |
| 43 | DeepSeek-R1-Distill-Qwen-7B | 2025-01 | https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B | MIT | reasoning_content 透传 |
| 44 | Qwen2.5-7B-Instruct-Abliterated | 2024-11 | https://huggingface.co/mlabonne/Qwen2.5-7B-Instruct-abliterated | Qwen License / Apache-2.0 兼容 | 中文去审查 |
| 45 | Lexi-Uncensored-V2 | 2024-06 | https://huggingface.co/Orenguteng/Lexi-Uncensored-V2 | MIT | 无审查对话 |

### 2.6 打包与发布 — 2 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 用途 |
|---|------|----------|----------|------|------|
| 46 | electron-builder | 26.x | https://github.com/electron-userland/electron-builder | MIT | 安装包构建 `--publish always` 发 draft Release |
| 47 | tauri-action | v1.x | https://github.com/tauri-apps/tauri-action | MIT | Tauri 迁移验证 CI 形态参考；`ISidecar` 已预留无改动可迁 |

### 直接 npm 依赖许可（`check-licenses.mjs` 扫描）

| 组件 | 版本基线 | 许可 | 备注 |
|------|----------|------|------|
| Electron | 43.x | MIT | 桌面运行时 |
| electron-vite | 5.x | MIT | 构建 |
| React / React DOM | 19.x | MIT | 渲染层 |
| Zustand | 5.x | MIT | 状态 |
| Vite | 8.x | MIT | 打包器 |
| TypeScript | 5.9.x | Apache-2.0 | 类型 |
| better-sqlite3 | 9.x | BSD-3-Clause | 白名单特例（原生） |
| sqlite-vec | 0.1.x | MIT | 白名单特例（原生） |
| sharp | 0.34.x | Apache-2.0 | 白名单特例（原生） |

> 白名单特例在 `scripts/check-licenses.mjs` 显式声明。

---

## 3. 抄用方式标注

| 方式 | 含义 | 本项目示例 |
|------|------|------------|
| **形态参考** | 仅参考交互/架构形态，未复制代码 | LM Studio / Cherry Studio / Fooocus / ComfyUI |
| **思路复用** | 复用设计思路，自写实现 | AnythingLLM RAG / LangChain rerank / Ollama 兼容层 |
| **侧车集成** | 以独立二进制子进程集成，MIT 可链 | `llama-server` (`:11435`) / `sd-cli` (`:11436`) |
| **隔离侧车** | AGPL 仅以独立进程运行于 `sidecars/` | `SearXNG` (`:7788`) |
| **权重引用** | 仅文档与下载器引用，不分发 | 10 项模型权重 |

### 代码级标注

- 所有侧车文件头含许可与隔离声明，例如 `src/sidecars/llama.ts` / `sd.ts` 头注 `MIT — No AGPL linking`。
- AGPL 组件永不被 `import` 进主进程；`search/searxng.ts` 仅经 `http://127.0.0.1` 调用，不 `import` 其源码。

---

## 4. AGPL 隔离边界

```
src/
  core/          MIT  — ISidecar 抽象，纯接口
  sidecars/      MIT  — llama.ts / sd.ts / ollama.ts（MIT 二进制）
  search/
    cloud.ts     MIT  — 远程 HTTPS，無本地进程
    orchestrator.ts MIT — 本地 rerank/cite
    searxng.ts   边界层 — 仅 HTTP 调用，不链 AGPL 源码
sidecars/
  searxng/       AGPL-3.0 豁免区 — 独立 Python 进程，仅 127.0.0.1
```

**禁止**：

- 在 `src/` 任何文件 `import` AGPL 源码。
- 将 AGPL 二进制打包进 `app.asar` 与主进程同进程加载。
- 侧车监听 `0.0.0.0` 对外暴露。

**门禁**：`node scripts/check-licenses.mjs` 扫描 `package.json` 依赖树，命中非白名单 `AGPL/GPL` 且不在 `sidecars/` 豁免路径时 `exit 1`。

---

## 5. 新增依赖合规流程

1. **查许可**：`npm view <pkg> license` / GitHub 仓库 License 栏确认。
2. **分类**：
   - 宽松（MIT/Apache/BSD/ISC/0BSD）→ 可直接 `pnpm add`。
   - AGPL/GPL → 必须置于 `sidecars/<name>/` 隔离进程，经 `127.0.0.1` 通信，并在 `THIRD_PARTY_NOTICES.md` + 本文件追记。
   - 闭源/Proprietary → 仅形态参考或 API 调用，不链代码。
3. **跑门禁**：
   ```bash
   node scripts/check-licenses.mjs          # 阻断检查
   node scripts/check-licenses.mjs --sbom   # 生成 sbom.json
   ```
4. **更新清单**：在 `THIRD_PARTY_NOTICES.md` 按分组追加一行，在本文件同步追记，并注明 Repo URL / 版本基线 / 许可 / 用途。

---

## 6. SBOM 与验证

```bash
# 生成 CycloneDX 风格 SBOM（默认 sbom.json）
node scripts/check-licenses.mjs --sbom
node scripts/check-licenses.mjs --sbom=sbom.json

# 仅检查（CI 门禁）
node scripts/check-licenses.mjs

# 体积预算（CI 门禁 <150 MB 不含模型）
node scripts/check-pack-size.mjs
```

CI 在 `pull_request` 与 `push tag v*` 时执行上述两项；任一失败阻断合并/发布。

---

## 7. 权重许可说明

- 10 项权重许可各异（Apache-2.0 / MIT / Gemma / Qwen），均 **不随仓库分发**，用户下载即视为接受对应权重许可。
- 商用前请核对 `HF Repo → Files → License`，特别是 `Gemma License` 与 `Qwen License` 的商用与再分发条款。

---

## 8. 许可文本索引

- MIT: https://opensource.org/licenses/MIT
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- BSD-3-Clause: https://opensource.org/licenses/BSD-3-Clause
- ISC: https://opensource.org/licenses/ISC
- 0BSD: https://opensource.org/licenses/0BSD
- AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.html
- GPL-3.0: https://www.gnu.org/licenses/gpl-3.0.html
