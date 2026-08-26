# OpenCode / Continue 联调 — Local AI Suite

> 目标：通过本机 Ollama 兼容接口 `http://127.0.0.1:11434/v1`（OpenAI 兼容）让 OpenCode 与 Continue 直连 Local AI Suite 侧车，无需公网。
> 安全约束：所有示例仅使用 `127.0.0.1`，**禁止** `0.0.0.0` 对外暴露。

## 前置条件

1. Local AI Suite 已启动，侧车监听 `127.0.0.1:11434`。
2. 已在「模型管理」下载至少一个 chat 模型（如 `qwen3-4b-instruct`），侧车健康检查通过：

```bash
curl http://127.0.0.1:11434/v1/models
# 预期返回 { "data": [{ "id": "qwen3-4b-instruct", ... }] }
```

3. 已安装 OpenCode CLI / Continue 插件（VS Code / JetBrains）。

---

## 1. OpenCode — `opencode.json` 示例

在项目根创建 `opencode.json`（或 `~/.config/opencode/opencode.json` 全局生效）：

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
      "options": {
        "temperature": 0.2,
        "maxTokens": 4096
      }
    }
  }
}
```

### 字段说明

| 字段 | 说明 |
|------|------|
| `provider.openai.baseURL` | 固定 `http://127.0.0.1:11434/v1`，指向本机侧车 |
| `provider.openai.apiKey` | 本地无需鉴权，填任意非空字符串如 `ollama` |
| `model` | 默认模型，需与侧车已下载模型 id 一致 |
| `models.*.options` | 温度/最大 token 等推理参数 |

> 完整可复制示例见 [`examples/opencode.json`](./examples/opencode.json)。

### 启动验证

```bash
opencode run --model qwen3-4b-instruct "用一句话介绍 Local AI Suite"
# 预期：流式返回中文回答，无网络错误
```

排错：

- `ECONNREFUSED 127.0.0.1:11434` → 检查 Local AI Suite 是否已启动、端口是否被占用。
- `model not found` → `curl http://127.0.0.1:11434/v1/models` 确认模型 id 拼写。
- 超时 → 适当增大 `timeout` 或降低 `maxTokens`。

---

## 2. Continue — `config.yaml` 示例

Continue 配置路径：`~/.continue/config.yaml`（新版）或 `.continue/config.yaml`（项目级）。以下为最小可联调配置：

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
    roles:
      - chat
      - edit
      - apply
    defaultRole: chat
    capabilities:
      - tool_use
    requestOptions:
      timeout: 60000
      extraBodyProperties:
        temperature: 0.2
        max_tokens: 4096

  # 可选：本地 embedding（用于 @codebase 上下文）
  - name: Local Embed — BGE-M3
    provider: openai
    model: bge-m3
    apiBase: http://127.0.0.1:11434/v1
    apiKey: ollama
    roles:
      - embed

tabAutocompleteModel:
  provider: openai
  model: qwen3-4b-instruct
  apiBase: http://127.0.0.1:11434/v1
  apiKey: ollama

contextProviders:
  - name: code
  - name: docs
  - name: diff
  - name: open
```

> 完整可复制示例见 [`examples/continue-config.yaml`](./examples/continue-config.yaml)。

### 字段说明

| 字段 | 说明 |
|------|------|
| `apiBase` | Continue 侧字段名，等价 `baseURL`，固定 `http://127.0.0.1:11434/v1` |
| `apiKey` | 同 OpenCode，本地填 `ollama` 占位 |
| `roles` | 声明模型用途：`chat`/`edit`/`apply`/`embed` |
| `tabAutocompleteModel` | Tab 补全模型，可与 chat 共用一模型 |

### 启动验证

1. VS Code 重载窗口后打开 Continue 侧边栏。
2. 选中 `Local Chat — Qwen3 4B`，输入 `你好`，应收到本地模型回复。
3. 测试 Edit：`Ctrl+I` / `Cmd+I` 输入 `把当前函数加上中文注释`。
4. 查看 Continue 日志无 `fetch failed` 即可确认联调成功。

---

## 3. 联调自检清单

```bash
# 1. 侧车存活
curl -s http://127.0.0.1:11434/v1/models | head -c 500

# 2. Chat 冒烟
curl -s http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-4b-instruct","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'

# 3. Embedding 冒烟（若已下载 bge-m3）
curl -s http://127.0.0.1:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"bge-m3","input":"hello"}'
```

全部返回 `200` 即代表 OpenCode / Continue 均可直连。

---

## 4. 常见问题

**Q: 为什么不用 `0.0.0.0`？**
A: `0.0.0.0` 会把侧车暴露到局域网/公网，违背本套件“仅 `127.0.0.1` 闭环”安全约束。所有文档与示例均已禁用。

**Q: 需要真实的 OpenAI Key 吗？**
A: 不需要。本地侧车不校验 `Authorization`，任意非空字符串即可，约定填 `ollama`。

**Q: 多模型如何配置？**
A: 在 `opencode.json` 的 `models` 或 `config.yaml` 的 `models` 数组中追加条目，`model` 字段与 `GET /v1/models` 返回的 `id` 一致即可。

## 5. 相关文件

- OpenCode 示例：[`examples/opencode.json`](./examples/opencode.json)
- Continue 示例：[`examples/continue-config.yaml`](./examples/continue-config.yaml)
- 安全约束说明：[`../SECURITY.md`](../SECURITY.md)
