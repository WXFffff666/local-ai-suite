# Benchmark Report — Local AI Suite

> 生成时间: 2026-08-22T13:29:36.785Z  
> 模式: dry-run（侧车未连，mock/占位） · 模型: `qwen3-4b-instruct` · prompt: "用一句话介绍自己"  
> 主机: `DESKTOP-FPDEJMA` · Node `v24.18.0` · 平台 `win32 x64`


> ⚠️ 部分探测未命中侧车，已用占位值填充；加 `--live` 并确保 `127.0.0.1:11434/11436` 可用后重跑以获取真实数据。

## 1. 摘要 (Summary)

| 指标 | 值 | 说明 |
|------|-----|------|
| 首 token 延迟 (TTFT) | — | POST /v1/chat/completions stream 首个 delta |
| 吞吐 tokens/s | — | 生成阶段 tokens/秒 (chars/4 估算) |
| 生成 tokens | — | 本次采样 tokens (估算) |
| 端到端耗时 | — | 首包到 [DONE] |
| 生图 s/张 | — | POST /generate 512×512 steps=12 |
| 生图状态 | ✗ fetch failed (dry-run) | sd-cli :11436 |

## 2. VRAM / GPU

| 后端 | 设备 | 总显存 | 空闲 | 已用 | 来源 |
|------|------|--------|------|------|------|
| cuda | NVIDIA GeForce RTX 5070 Laptop GPU | 8151 MiB (8.0 GiB) | 5373 MiB | 2778 MiB | nvidia-smi |

- 分级阈值: `<4GB low → sd1.5-q4` · `<6GB medium → sdxl 警告` · `6–12GB high → sdxl` · `>12GB ultra → flux 解锁`（见 `src/image/queue.ts`）
- 健康端点: `GET http://127.0.0.1:11435/health/gpu` 或 `src/health/gpu.ts:detectGpu()`

## 3. LLM 性能 (Ollama / llama-server)

| 指标 | 值 |
|------|-----|
| 模型 | `qwen3-4b-instruct` |
| 端点 | `http://127.0.0.1:11434/v1/chat/completions` |
| 首 token 延迟 TTFT | — |
| tokens/s | — |
| tokens (估算) | — |
| 字符数 | — |
| 端到端 | — |
| 状态 | ✗ fetch failed (dry-run, use --live) |

采样请求:
```json
{"model": "qwen3-4b-instruct", "messages": [{"role":"user","content":"用一句话介绍自己"}], "stream": true, "max_tokens": 128}
```

```bash
curl -N http://127.0.0.1:11434/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"qwen3-4b-instruct","messages":[{"role":"user","content":"用一句话介绍自己"}],"stream":true,"max_tokens":128}'
```

## 4. 生图性能 (stable-diffusion.cpp sd-cli)

| 指标 | 值 |
|------|-----|
| 端点 | `http://127.0.0.1:11436/generate` |
| s/张 | — |
| 耗时 | — |
| 参数 | 512×512, steps=12, seed=42 |
| 状态 | ✗ fetch failed (dry-run) |

```bash
curl http://127.0.0.1:11436/generate \
  -H "content-type: application/json" \
  -d '{"prompt":"a cute cat, high quality","width":512,"height":512,"steps":12,"seed":42}'
```

## 5. 环境

| 项 | 值 |
|----|-----|
| 时间 | 2026-08-22T13:29:36.785Z |
| Node | v24.18.0 |
| 平台 | win32 x64 |
| 模型 | qwen3-4b-instruct |
| live | false (dry-run) |
| chatUrl | http://127.0.0.1:11434/v1/chat/completions |
| sdUrl | http://127.0.0.1:11436/generate |

## 6. 复现

```bash
# dry-run (无侧车也可用，生成占位报告)
pnpm bench

# live (需先启动 ollama/llama-server 与 sd-cli)
pnpm bench:live
# 或
node benchmarks/bench.mjs --live
BENCH_MODEL=qwen2.5-7b-instruct node benchmarks/bench.mjs --live
```

> 报告由 `benchmarks/bench.mjs` 生成，MIT，无 AGPL 依赖。阈值与端口约定见 `docs/ARCHITECTURE.md`。
