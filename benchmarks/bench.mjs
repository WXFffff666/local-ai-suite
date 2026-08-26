#!/usr/bin/env node
/**
 * bench.mjs — Wave7 T39 benchmark harness
 *  MIT only, no AGPL. Pure Node (fs/path/child_process/fetch).
 *
 * Metrics:
 *   - 首token延迟 (TTFT) ms
 *   - tokens/s (吞吐)
 *   - VRAM total/free/used
 *   - 生图 s/张
 *
 * Usage:
 *   node benchmarks/bench.mjs              # dry-run (mock if sidecars absent)
 *   node benchmarks/bench.mjs --live       # hit 127.0.0.1:11434 / 11436
 *   BENCH_MODEL=qwen3-4b-instruct node benchmarks/bench.mjs --live
 *   pnpm bench
 *
 * Env:
 *   BENCH_MODEL      默认 qwen3-4b-instruct
 *   BENCH_PROMPT     默认 "用一句话介绍自己"
 *   BENCH_LIVE=1     等同 --live
 *   BENCH_OUT        报告路径 默认 benchmarks/report.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const live = args.includes('--live') || process.env.BENCH_LIVE === '1'
const outPath = process.env.BENCH_OUT || path.join(__dirname, 'report.md')
const model = process.env.BENCH_MODEL || 'qwen3-4b-instruct'
const prompt = process.env.BENCH_PROMPT || '用一句话介绍自己'
const chatUrl = process.env.BENCH_CHAT_URL || 'http://127.0.0.1:11434/v1/chat/completions'
const sdUrl = process.env.BENCH_SD_URL || 'http://127.0.0.1:11436/generate'
const gpuHealthUrl = process.env.BENCH_GPU_URL || 'http://127.0.0.1:11435/health'

function fmt(n, digits = 1) {
  if (n == null || !Number.isFinite(n)) return '—'
  return Number(n).toFixed(digits)
}
function now() { return Date.now() }
function isoNow() { return new Date().toISOString() }

// ---------------------------------------------------------------------------
// VRAM probe — same priority as src/health/gpu.ts, but shell-free fallback
// ---------------------------------------------------------------------------
function execP(cmd, psArgs, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, psArgs, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') resolve({ stdout: '', stderr: String(err.message), code: 127 })
      else resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err ? (err.code ?? 1) : 0 })
    })
  })
}

function parseNvidiaCsv(out) {
  const line = out.split('\n').map(s => s.trim()).find(Boolean)
  if (!line) return null
  const p = line.split(',').map(s => s.trim())
  const total = parseInt(p[1], 10)
  const free = p[2] ? parseInt(p[2], 10) : undefined
  if (!Number.isFinite(total) || total <= 0) return null
  return { device: p[0] || 'NVIDIA GPU', totalMB: total, freeMB: Number.isFinite(free) ? free : undefined }
}

async function probeVram() {
  // try nvidia-smi CSV
  try {
    const r = await execP('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], 2500)
    if (r.code === 0 && r.stdout.trim()) {
      const p = parseNvidiaCsv(r.stdout)
      if (p) return { backend: 'cuda', device: p.device, totalMB: p.totalMB, freeMB: p.freeMB, usedMB: p.freeMB != null ? p.totalMB - p.freeMB : undefined, source: 'nvidia-smi' }
    }
  } catch { /* ignore */ }
  // rocm probe (MB numbers)
  try {
    const r = await execP('rocm-smi', ['--showmeminfo', 'vram'], 2500)
    if (r.code === 0 && r.stdout.trim()) {
      const matches = [...r.stdout.matchAll(/(\d{3,6})\s*MB/gi)].map(m => parseInt(m[1], 10))
      const cand = matches.find(n => n >= 512)
      if (cand) return { backend: 'rocm', device: 'AMD GPU', totalMB: cand, source: 'rocm-smi' }
    }
  } catch { /* ignore */ }
  return { backend: 'cpu', device: 'CPU', totalMB: null, freeMB: null, usedMB: null, source: 'none' }
}

// ---------------------------------------------------------------------------
// LLM bench — TTFT + tokens/s via SSE
// ---------------------------------------------------------------------------
async function benchChat({ url, mdl, prmpt }) {
  const body = JSON.stringify({ model: mdl, messages: [{ role: 'user', content: prmpt }], stream: true, max_tokens: 128, temperature: 0.2 })
  const t0 = now()
  let tFirst = null
  let tokens = 0
  let chars = 0
  let done = false
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body, signal: AbortSignal.timeout(20000) })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${txt.slice(0, 200)}`, ttftMs: null, tokensPerSec: null, tokens, chars, elapsedMs: now() - t0 }
    }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, error: 'no body', ttftMs: null, tokensPerSec: null, tokens, chars, elapsedMs: now() - t0 }
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done: d, value } = await reader.read()
      if (d) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (!data || data === '[DONE]') { done = true; continue }
        try {
          const obj = JSON.parse(data)
          // OpenAI shape or Ollama shape
          const delta = obj.choices?.[0]?.delta?.content ?? obj.message?.content ?? obj.content ?? obj.response ?? ''
          const isDone = obj.choices?.[0]?.finish_reason === 'stop' || obj.done === true
          if (delta && typeof delta === 'string' && delta.length) {
            if (tFirst == null) tFirst = now()
            tokens += 1 // chunk ~= token (SSE chunk granularity)
            chars += delta.length
          }
          if (isDone) done = true
        } catch { /* ignore */ }
      }
      if (done) break
    }
    // drain tail
    if (buf.trim().startsWith('data:')) {
      const data = buf.trim().slice(5).trim()
      if (data && data !== '[DONE]') {
        try { const obj = JSON.parse(data); const d = obj.choices?.[0]?.delta?.content ?? ''; if (d) { if (tFirst == null) tFirst = now(); tokens += 1; chars += d.length } } catch { /* ignore */ }
      }
    }
    try { reader.releaseLock() } catch { /* ignore */ }
    const elapsed = now() - t0
    const ttft = tFirst != null ? tFirst - t0 : null
    const genMs = tFirst != null ? elapsed - ttft : elapsed
    const tps = genMs > 0 && tokens > 0 ? (tokens / (genMs / 1000)) : null
    // heuristic: if tokens == chunks, approximate by chars/4
    const estTokens = Math.max(tokens, Math.ceil(chars / 4))
    const estTps = genMs > 0 ? (estTokens / (genMs / 1000)) : null
    return { ok: true, ttftMs: ttft, tokensPerSec: estTps ?? tps, tokens: estTokens, chars, elapsedMs: elapsed }
  } catch (e) {
    return { ok: false, error: String(e.message ?? e), ttftMs: tFirst != null ? tFirst - t0 : null, tokensPerSec: null, tokens, chars, elapsedMs: now() - t0 }
  }
}

// ---------------------------------------------------------------------------
// 生图 bench — POST /generate timing
// ---------------------------------------------------------------------------
async function benchImage({ url }) {
  const payload = { prompt: 'a cute cat, high quality', width: 512, height: 512, steps: 12, seed: 42 }
  const t0 = now()
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) })
    const elapsed = now() - t0
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return { ok: false, error: `HTTP ${res.status} ${txt.slice(0, 300)}`, secPerImage: null, elapsedMs: elapsed }
    }
    // consume
    await res.arrayBuffer().catch(() => null)
    return { ok: true, secPerImage: elapsed / 1000, elapsedMs: elapsed }
  } catch (e) {
    return { ok: false, error: String(e.message ?? e), secPerImage: null, elapsedMs: now() - t0 }
  }
}

// ---------------------------------------------------------------------------
// Report render
// ---------------------------------------------------------------------------
function renderReport({ vram, chat, image, meta }) {
  const vramRow = vram.totalMB != null
    ? `| ${vram.backend} | ${vram.device} | ${vram.totalMB} MiB (${fmt(vram.totalMB / 1024, 1)} GiB) | ${vram.freeMB != null ? `${vram.freeMB} MiB` : '—'} | ${vram.usedMB != null ? `${vram.usedMB} MiB` : '—'} | ${vram.source} |`
    : `| ${vram.backend} | ${vram.device} | — | — | — | ${vram.source} |`

  const chatOk = chat.ok
  const imgOk = image.ok
  const envNote = meta.live ? 'live（已连侧车）' : 'dry-run（侧车未连，mock/占位）'
  const warn = (!chatOk || !imgOk) ? `\n> ⚠️ 部分探测未命中侧车，已用占位值填充；加 \`--live\` 并确保 \`127.0.0.1:11434/11436\` 可用后重跑以获取真实数据。\n` : ''

  return `# Benchmark Report — Local AI Suite

> 生成时间: ${meta.iso}  
> 模式: ${envNote} · 模型: \`${meta.model}\` · prompt: "${meta.prompt}"  
> 主机: \`${meta.host}\` · Node \`${meta.node}\` · 平台 \`${meta.platform}\`

${warn}
## 1. 摘要 (Summary)

| 指标 | 值 | 说明 |
|------|-----|------|
| 首 token 延迟 (TTFT) | ${chat.ttftMs != null ? `${fmt(chat.ttftMs, 0)} ms` : '—'} | POST /v1/chat/completions stream 首个 delta |
| 吞吐 tokens/s | ${chat.tokensPerSec != null ? fmt(chat.tokensPerSec, 1) : '—'} | 生成阶段 tokens/秒 (chars/4 估算) |
| 生成 tokens | ${chat.tokens ?? '—'} | 本次采样 tokens (估算) |
| 端到端耗时 | ${chat.elapsedMs != null ? `${fmt(chat.elapsedMs, 0)} ms` : '—'} | 首包到 [DONE] |
| 生图 s/张 | ${image.secPerImage != null ? fmt(image.secPerImage, 2) : '—'} | POST /generate 512×512 steps=12 |
| 生图状态 | ${imgOk ? '✓' : `✗ ${image.error ?? ''}`} | sd-cli :11436 |

## 2. VRAM / GPU

| 后端 | 设备 | 总显存 | 空闲 | 已用 | 来源 |
|------|------|--------|------|------|------|
${vramRow}

- 分级阈值: \`<4GB low → sd1.5-q4\` · \`<6GB medium → sdxl 警告\` · \`6–12GB high → sdxl\` · \`>12GB ultra → flux 解锁\`（见 \`src/image/queue.ts\`）
- 健康端点: \`GET http://127.0.0.1:11435/health/gpu\` 或 \`src/health/gpu.ts:detectGpu()\`

## 3. LLM 性能 (Ollama / llama-server)

| 指标 | 值 |
|------|-----|
| 模型 | \`${meta.model}\` |
| 端点 | \`${meta.chatUrl}\` |
| 首 token 延迟 TTFT | ${chat.ttftMs != null ? `${fmt(chat.ttftMs, 0)} ms` : '—'} |
| tokens/s | ${chat.tokensPerSec != null ? fmt(chat.tokensPerSec, 1) : '—'} |
| tokens (估算) | ${chat.tokens ?? '—'} |
| 字符数 | ${chat.chars ?? '—'} |
| 端到端 | ${chat.elapsedMs != null ? `${fmt(chat.elapsedMs, 0)} ms` : '—'} |
| 状态 | ${chatOk ? '✓ ok' : `✗ ${chat.error ?? 'failed'}`} |

采样请求:
\`\`\`json
{"model": "${meta.model}", "messages": [{"role":"user","content":"${meta.prompt}"}], "stream": true, "max_tokens": 128}
\`\`\`

\`\`\`bash
curl -N http://127.0.0.1:11434/v1/chat/completions \\
  -H "content-type: application/json" \\
  -d '{"model":"${meta.model}","messages":[{"role":"user","content":"${meta.prompt}"}],"stream":true,"max_tokens":128}'
\`\`\`

## 4. 生图性能 (stable-diffusion.cpp sd-cli)

| 指标 | 值 |
|------|-----|
| 端点 | \`${meta.sdUrl}\` |
| s/张 | ${image.secPerImage != null ? fmt(image.secPerImage, 2) : '—'} |
| 耗时 | ${image.elapsedMs != null ? `${fmt(image.elapsedMs, 0)} ms` : '—'} |
| 参数 | 512×512, steps=12, seed=42 |
| 状态 | ${imgOk ? '✓ ok' : `✗ ${image.error ?? 'failed'}`} |

\`\`\`bash
curl http://127.0.0.1:11436/generate \\
  -H "content-type: application/json" \\
  -d '{"prompt":"a cute cat, high quality","width":512,"height":512,"steps":12,"seed":42}'
\`\`\`

## 5. 环境

| 项 | 值 |
|----|-----|
| 时间 | ${meta.iso} |
| Node | ${meta.node} |
| 平台 | ${meta.platform} |
| 模型 | ${meta.model} |
| live | ${meta.live ? 'true (--live)' : 'false (dry-run)'} |
| chatUrl | ${meta.chatUrl} |
| sdUrl | ${meta.sdUrl} |

## 6. 复现

\`\`\`bash
# dry-run (无侧车也可用，生成占位报告)
pnpm bench

# live (需先启动 ollama/llama-server 与 sd-cli)
pnpm bench:live
# 或
node benchmarks/bench.mjs --live
BENCH_MODEL=qwen2.5-7b-instruct node benchmarks/bench.mjs --live
\`\`\`

> 报告由 \`benchmarks/bench.mjs\` 生成，MIT，无 AGPL 依赖。阈值与端口约定见 \`docs/ARCHITECTURE.md\`。
`
}

async function main() {
  console.log(`[bench] model=${model} live=${live} prompt="${prompt}"`)
  const vram = await probeVram()
  console.log(`[bench] vram: ${vram.backend} ${vram.device} ${vram.totalMB ?? '—'} MiB via ${vram.source}`)

  let chat, image
  if (live) {
    chat = await benchChat({ url: chatUrl, mdl: model, prmpt: prompt })
    console.log(`[bench] chat: ttft=${chat.ttftMs}ms tps=${chat.tokensPerSec} ok=${chat.ok} ${chat.error ?? ''}`)
    image = await benchImage({ url: sdUrl })
    console.log(`[bench] image: s/img=${image.secPerImage} ok=${image.ok} ${image.error ?? ''}`)
  } else {
    // dry-run: try live once with short timeout; fallback to placeholder
    const tryChat = await benchChat({ url: chatUrl, mdl: model, prmpt: prompt })
    if (tryChat.ok) {
      chat = tryChat
      console.log(`[bench] chat (probe): ttft=${chat.ttftMs}ms tps=${chat.tokensPerSec}`)
    } else {
      console.log(`[bench] chat probe failed (${tryChat.error}) — using placeholder`)
      chat = { ok: false, error: tryChat.error + ' (dry-run, use --live)', ttftMs: null, tokensPerSec: null, tokens: null, chars: null, elapsedMs: null }
    }
    const tryImg = await benchImage({ url: sdUrl })
    if (tryImg.ok) {
      image = tryImg
      console.log(`[bench] image (probe): s/img=${tryImg.secPerImage}`)
    } else {
      console.log(`[bench] image probe failed (${tryImg.error}) — placeholder`)
      image = { ok: false, error: tryImg.error + ' (dry-run)', secPerImage: null, elapsedMs: null }
    }
  }

  const meta = {
    iso: isoNow(),
    model,
    prompt,
    live,
    chatUrl,
    sdUrl,
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'localhost',
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  }

  const md = renderReport({ vram, chat, image, meta })
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, md, 'utf-8')
  console.log(`[bench] report -> ${path.relative(ROOT, outPath)}`)
}

main().catch((e) => { console.error('[bench] fatal', e); process.exit(1) })
