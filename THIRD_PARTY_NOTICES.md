# Third-Party Notices

本文件汇总 **Local AI Suite** 直接依赖与形态参考的第三方开源组件及其许可。完整许可文本以各组件仓库为准。主项目自身以 **MIT** 开源（见 [LICENSE](LICENSE)），以下清单为合规二次开发证据，覆盖计划 **43 项基线**并细化为 **47 项（6 组）** —— 桌面 8 / 推理 8 / 生图 8 / 搜索 11 / 模型 10 / 打包 2。**每项均含 Repo URL、版本基线、License、用途**。

> 合规原则：主进程仅链接 **MIT / Apache-2.0 / BSD / ISC / 0BSD** 等宽松许可；**AGPL / GPL** 仅允许以独立进程运行于 `sidecars/` 目录，不与主进程静态/动态链接（见 `scripts/check-licenses.mjs` 白名单与侧车豁免逻辑）。

---

## 1) 桌面形态参考 — 8 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 用途/抄用边界 |
|---|---|---|---|---|---|
| 1 | **Jan** | v0.5.x | https://github.com/janhq/jan | Apache-2.0 | 本地 LLM 桌面形态与侧车思想参考；计划基座引用的 Apache-2.0 标杆 |
| 2 | **LM Studio** | v0.3.x | https://lmstudio.ai · https://github.com/lmstudio-ai/lmstudio | Proprietary（免费闭源） | GGUF 模型管理、量化筛选与下载 UX 形态参考；不链接代码 |
| 3 | **Cherry Studio** | v1.7.x | https://github.com/CherryHQ/cherry-studio | AGPL-3.0 | 多模型聚合与 reasoning 渲染参考；AGPL 仅形态参考，不链接进主进程 |
| 4 | **Open WebUI** | v0.6.x | https://github.com/open-webui/open-webui | MIT | 对话/知识库/RAG 形态参考；宽松许可可复用思路 |
| 5 | **AnythingLLM** | v1.8.x | https://github.com/Mintplex-Labs/anything-llm | MIT | RAG / 向量检索 / MCP 基座复用思路；本项目以此为 MIT 基座 |
| 6 | **Chatbox** | v0.10.x | https://github.com/Bin-Huang/chatbox | GPL-3.0 | 轻量 AI 客户端与快捷键/托盘形态参考；GPL 仅形态参考 |
| 7 | **Msty** | v1.2.x | https://msty.ai · https://github.com/msty-ai | Proprietary | 多提供方聚合与模型一键切换形态参考；不链接代码 |
| 8 | **Lobe Chat** | v1.60.x | https://github.com/lobehub/lobe-chat | MIT | 现代聊天 UI、插件与主题形态参考 |

## 2) 本地推理 — 8 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 用途/抄用边界 |
|---|---|---|---|---|---|
| 9 | **llama.cpp** | b4820+ | https://github.com/ggml-org/llama.cpp | MIT | GGUF 推理侧车 `llama-server` 二进制来源；MIT 可直接集成侧车 |
| 10 | **whisper.cpp** | v1.7.x | https://github.com/ggerganov/whisper.cpp | MIT | 语音转写侧车（预留）；MIT |
| 11 | **llama-cpp-python** | v0.3.x | https://github.com/abetlen/llama-cpp-python | MIT | Python 绑定与 OpenAI 兼容封装思路参考 |
| 12 | **Ollama** | v0.6.x | https://github.com/ollama/ollama | MIT | 模型服务、`/api/*` 与 `/v1/*` 兼容层参考；`OLLAMA_MODELS` 定向思路 |
| 13 | **LocalAI** | v2.24.x | https://github.com/mudler/LocalAI | MIT | 本地 OpenAI 兼容聚合方案参考 |
| 14 | **vLLM** | v0.8.x | https://github.com/vllm-project/vllm | Apache-2.0 | 高吞吐推理与 PagedAttention 思路（云端参考） |
| 15 | **KoboldCpp** | v1.79.x | https://github.com/LostRuins/koboldcpp | AGPL-3.0 | 戏仿/角色扮演推理形态参考；AGPL 仅允许 `sidecars/koboldcpp` 独立进程 |
| 16 | **MLX** | v0.21.x | https://github.com/ml-explore/mlx | MIT | Apple Silicon 原生推理框架形态参考 |

## 3) 本地生图 — 8 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 用途/抄用边界 |
|---|---|---|---|---|---|
| 17 | **stable-diffusion-webui (A1111)** | v1.10.x | https://github.com/AUTOMATIC1111/stable-diffusion-webui | AGPL-3.0 | 生图 WebUI 鼻祖形态参考；AGPL 不链接 |
| 18 | **ComfyUI** | v0.3.x | https://github.com/comfyanonymous/ComfyUI | GPL-3.0 | 节点式工作流编排参考；GPL 仅形态参考 |
| 19 | **Fooocus** | v2.5.x | https://github.com/lllyasviel/Fooocus | GPL-3.0 | 零工作流 `prompt→image` 简化交互参考 |
| 20 | **InvokeAI** | v5.5.x | https://github.com/invoke-ai/InvokeAI | Apache-2.0 | 生图队列、画廊与参数复用参考 |
| 21 | **stable-diffusion.cpp (sd.cpp)** | v0.12.x | https://github.com/leejet/stable-diffusion.cpp | MIT | 本项目生图侧车 `sd-cli` 单二进制来源；MIT 可直接侧车集成 |
| 22 | **Diffusers** | v0.33.x | https://github.com/huggingface/diffusers | Apache-2.0 | 扩散模型库与调度器参考 |
| 23 | **SD.Next (vladmandic)** | v2024.x | https://github.com/vladmandic/automatic | AGPL-3.0 | A1111 分支形态参考；AGPL 隔离 |
| 24 | **SwarmUI** | v0.9.x | https://github.com/mcmonkeyprojects/SwarmUI | MIT | 生图前端聚合与队列形态参考 |

## 4) 搜索与编排 — 11 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 用途/抄用边界 |
|---|---|---|---|---|---|
| 25 | **SearXNG** | 2025.x | https://github.com/searxng/searxng | AGPL-3.0 | 本地搜索侧车 `sidecars/searxng`；AGPL 豁免仅限该目录独立进程 |
| 26 | **Tavily** | v0.5.x | https://github.com/tavily-ai/tavily-python | MIT | 云搜索 API 适配器（`TAVILY_API_KEY`） |
| 27 | **Exa** | v1.6.x | https://github.com/exa-labs/exa-js | MIT | 云搜索 API 适配器（`EXA_API_KEY`） |
| 28 | **Brave Search API** | 2026-08 | https://brave.com/search/api/ | Proprietary API（客户端 MIT） | 云搜索适配器；费率 $5/1k 请求 |
| 29 | **Serper** | 2026-08 | https://serper.dev | Proprietary API | 云搜索适配器；费率 $0.008 / credit |
| 30 | **Bing Search API** | 2026-08 | https://www.microsoft.com/en-us/bing/apis/bing-web-search-api | Proprietary API | 云搜索适配器；费率 $7/1k 请求 |
| 31 | **LangChain** | v0.3.x | https://github.com/langchain-ai/langchain | MIT | `search→rerank→cite` 编排与重排思路 |
| 32 | **LlamaIndex** | v0.12.x | https://github.com/run-llama/llama_index | MIT | RAG 检索与 `as_query_engine` 思路 |
| 33 | **AutoGen** | v0.4.x | https://github.com/microsoft/autogen | MIT | 多智能体编排参考 |
| 34 | **CrewAI** | v0.100.x | https://github.com/crewAIInc/crewAI | MIT | 多智能体协作编排参考 |
| 35 | **opencode** | v0.5.x | https://github.com/sst/opencode | MIT | AI 编程助手集成验证（`baseURL=http://127.0.0.1:11434/v1`） |

## 5) 精选模型权重 — 10 项（仅下载器拉取，不入库）

> 权重通过首启向导 / HF 浏览器按需下载至 `models/`（已被 `.gitignore` 忽略）；仓库不分发权重，仅提供下载器与文档。

| # | 模型 | 版本基线 | HF Repo URL | 权重许可 | 用途 |
|---|---|---|---|---|---|
| 36 | **Dolphin-Mistral-24B-Venice-Edition** | 2025-05 | https://huggingface.co/cognitivecomputations/dolphin-24b-venice-edition | Apache-2.0（Dolphin 定制） | 越狱/创意写作演示权重；Q4_K_M GGUF |
| 37 | **Mistral-Nemo-Instruct-2407** | 2407 | https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407 | Apache-2.0 | 通用指令微调，平衡质量与速度 |
| 38 | **WizardLM-2-8x22B** | 2024-04 | https://huggingface.co/alpindale/WizardLM-2-8x22B | Apache-2.0 | 高质量指令与推理 |
| 39 | **Nous-Hermes-2-Mistral-7B-DPO** | 2024-02 | https://huggingface.co/NousResearch/Nous-Hermes-2-Mistral-7B-DPO | Apache-2.0 | 助手微调，DPO 优化 |
| 40 | **MythoMax-L2-13B** | v1.0 | https://huggingface.co/Gryphe/MythoMax-L2-13B | MIT（衍生） | 角色扮演/创意 |
| 41 | **OpenHermes-2.5-Mistral-7B** | 2024-01 | https://huggingface.co/teknium/OpenHermes-2.5-Mistral-7B | Apache-2.0 | 开放指令微调 |
| 42 | **Gemma-2-9B-It-Abliterated** | 2024-09 | https://huggingface.co/mlabonne/gemma-2-9b-it-abliterated | Gemma License（商用允许） | Gemma 去审查分支 |
| 43 | **DeepSeek-R1-Distill-Qwen-7B** | 2025-01 | https://huggingface.co/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B | MIT | 思考链（reasoning_content）透传验证 |
| 44 | **Qwen2.5-7B-Instruct-Abliterated** | 2024-11 | https://huggingface.co/mlabonne/Qwen2.5-7B-Instruct-abliterated | Qwen License / Apache-2.0 兼容 | 中文指令去审查分支 |
| 45 | **Lexi-Uncensored-V2** | 2024-06 | https://huggingface.co/Orenguteng/Lexi-Uncensored-V2 | MIT | 无审查对话预设 |

## 6) 打包与发布 — 2 项

| # | 组件 | 版本基线 | Repo URL | 许可 | 用途 |
|---|---|---|---|---|---|
| 46 | **electron-builder** | 26.x | https://github.com/electron-userland/electron-builder | MIT | 安装包构建（`--publish always` 发 draft Release）；本项目直接依赖 26.15.3 |
| 47 | **tauri-action** | v1.x | https://github.com/tauri-apps/tauri-action | MIT | Tauri 迁移验证 CI 形态参考；抽象层已预留 `ISidecar` 无改动可迁 |

---

## 附：直接 npm 依赖许可（由 `scripts/check-licenses.mjs` 扫描验证）

| 组件 | 版本基线 | 许可 | 说明 |
|---|---|---|---|
| Electron | 43.x | MIT | 桌面运行时 |
| electron-vite | 5.x | MIT | 构建工具 |
| React | 19.x | MIT | 渲染层 |
| React DOM | 19.x | MIT | 渲染层 |
| Zustand | 5.x | MIT | 状态管理 |
| Vite | 8.x | MIT | 打包器 |
| TypeScript | 5.9.x | Apache-2.0 | 类型系统 |
| better-sqlite3 | 9.x | BSD-3-Clause | 本地持久化（白名单特例） |
| sqlite-vec | 0.1.x | MIT | 向量检索（白名单特例） |
| sharp | 0.34.x | Apache-2.0 | 图像缩略（白名单特例） |

> 白名单特例：`better-sqlite3` / `sqlite-vec` / `sharp` 含原生二进制，许可分别为 BSD-3-Clause / MIT / Apache-2.0，已在 `scripts/check-licenses.mjs` 显式白名单中。

## 合规使用说明

1. **禁止**将 AGPL/GPL 组件静态或动态链接进 Electron 主进程；仅允许 `sidecars/` 下以独立子进程运行，通过 `127.0.0.1` 本地回环通信。
2. 新增依赖前执行 `node scripts/check-licenses.mjs`；CI 门禁在 AGPL 落于 `sidecars/` 外时以 `exit 1` 阻断。
3. 生成 SBOM：`node scripts/check-licenses.mjs --sbom`（默认 `sbom.json`）或 `node scripts/check-licenses.mjs --sbom=sbom.json`。
4. 本清单随依赖变更追加记录；权重仅作下载器引用，不随仓库分发。

## 许可文本索引

- MIT: https://opensource.org/licenses/MIT
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- BSD-3-Clause: https://opensource.org/licenses/BSD-3-Clause
- ISC: https://opensource.org/licenses/ISC
- AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.html
- GPL-3.0: https://www.gnu.org/licenses/gpl-3.0.html
