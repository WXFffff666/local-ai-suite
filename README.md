# Local AI Suite

本地模型一键安装与离线工作流套件 — Electron 桌面壳，模型与工作流均在本地闭环运行。

> 基座：Electron 43 + electron-vite 5 + React 19 + TypeScript 5.9 · MIT 开源

## 一键安装

```bash
# 克隆
git clone https://github.com/WXFffff666/local-ai-suite.git
cd local-ai-suite

# 安装依赖（需要联网，仅安装期）
pnpm install

# 启动开发窗口（热更新）
pnpm dev

# 类型检查
pnpm typecheck

# 构建产物
pnpm build
```

环境要求：Node.js 18+，pnpm 9+，Windows 10/11。

## 模型文件夹

> 占位说明（T2 落地）：

- 本地模型统一落在项目根 `models/` 目录（已被 `.gitignore` 忽略，绝不入库）。
- 支持 GGUF / safetensors / ONNX 等格式，按 `models/<provider>/<model-name>/` 分层存放。
- 首次启动自动创建 `models/`，未下载模型时界面提示一键拉取；已下载模型显示本地校验与版本。
- 大文件通过 Git LFS 或直链下载，不进 git 历史。

```
models/
  ├─ llm/
  │   └─ qwen3-4b-instruct/
  └─ embedding/
      └─ bge-m3/
```

## 工作流说明

> 占位说明（后续迭代）：

- 工作流 = 模型 + 提示词模板 + 后处理链的本地编排，全部在 `127.0.0.1` 侧车内执行，不出本机。
- 内置工作流注册在 `src/shared/workflows/`（占位），用户自定义工作流落在 `userData/workflows/`。
- 每个工作流声明输入/输出类型与所需模型，缺模型时一键补齐，未就绪工作流置灰不可执行。
- 运行时零公网依赖；联网仅用于模型下载与更新检查，且可完全离线使用。

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Electron 43（sandbox + contextIsolation） |
| 渲染层 | React 19 + TypeScript 5.9 + Vite 8（electron-vite 5） |
| 状态 | Zustand 5 |
| 打包 | electron-builder 26 |

## 许可

MIT — 见 [LICENSE](LICENSE)。第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
