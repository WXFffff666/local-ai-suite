/**
 * GPU health — CUDA / Metal / Vulkan / ROCm 探测
 * MIT, 无 AGPL 依赖. 仅使用 Node 内置 child_process.
 *
 * GET /health/gpu -> { backend, vram, fits, device?, displayName?, reason? }
 * UI 可读: formatGpuForUI / toDisplayString / backendLabel
 */

import { execFile } from 'child_process'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GpuBackend = 'cuda' | 'rocm' | 'metal' | 'vulkan' | 'cpu'

export type VramInfo = {
  /** MiB */
  totalMB: number
  freeMB?: number
  usedMB?: number
  /** GiB derived (totalMB / 1024, 保留1位) */
  totalGB?: number
}

export type GpuInfo = {
  backend: GpuBackend
  /** null 表示未获取到显存信息（CPU / 探测失败） */
  vram: VramInfo | null
  /** 该 GPU / 环境是否可承载模型（基于阈值或实际显存） */
  fits: boolean
  /** 设备名，如 "NVIDIA GeForce RTX 4090" / "Apple M3 Max" */
  device?: string
  /** UI 可读标签 */
  displayName?: string
  /** 人可读原因 / 详情 */
  reason?: string
}

export const GPU_BACKEND_LABEL: Record<GpuBackend, string> = {
  cuda: 'NVIDIA CUDA',
  rocm: 'AMD ROCm',
  metal: 'Apple Metal',
  vulkan: 'Vulkan',
  cpu: 'CPU',
}

export const DEFAULT_REQUIRED_VRAM_MB = 2048
export const MIN_USABLE_VRAM_MB = 1024

// ---------------------------------------------------------------------------
// Exec abstraction (injectable for tests)
// ---------------------------------------------------------------------------

export type ExecResult = { stdout: string; stderr: string; code: number }

export type ExecFn = (cmd: string, args?: string[], opts?: { timeout?: number }) => Promise<ExecResult>

export const defaultExec: ExecFn = (cmd, args = [], opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 4000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ stdout: '', stderr: String((err as Error).message), code: 127 })
        return
      }
      const code = (err as { code?: number } | null)?.code ?? (err ? 1 : 0)
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', code: code ?? 0 })
    })
  })

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** nvidia-smi CSV: name, memory.total, memory.free  (MiB, nounits) */
export function parseNvidiaSmiCsv(output: string): { device: string; totalMB: number; freeMB: number } | null {
  const line = output.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return null
  // 例: "NVIDIA GeForce RTX 4090, 24564, 23000"
  const parts = line.split(',').map((s) => s.trim())
  if (parts.length < 2) return null
  const device = parts[0] ?? 'NVIDIA GPU'
  const totalMB = Number.parseInt(parts[1] ?? '', 10)
  const freeMB = parts[2] != null ? Number.parseInt(parts[2], 10) : Number.NaN
  if (!Number.isFinite(totalMB) || totalMB <= 0) return null
  return { device, totalMB, freeMB: Number.isFinite(freeMB) ? freeMB : undefined as unknown as number }
}

export function parseRocmSmi(output: string): { device: string; totalMB: number } | null {
  // rocm-smi 输出多变: 尝试提取 "VRAM Total Memory ... 16384" 或 "8192 MB"
  // 兜底: 找到第一个 >=512 的 MB 数
  const deviceMatch = output.match(/(Radeon[^,\n]*|Instinct[^,\n]*|RX[^,\n]*)/i)
  const device = deviceMatch?.[1]?.trim() ?? 'AMD GPU'
  // 寻找数字 + MB
  const mbMatches = [...output.matchAll(/(\d{3,6})\s*MB/gi)].map((m) => Number.parseInt(m[1]!, 10))
  const candidate = mbMatches.find((n) => n >= 512 && n <= 262144)
  if (candidate != null) return { device, totalMB: candidate }
  // 寻找 "Total" 附近数字
  const totalMatch = output.match(/Total[^0-9]*(\d{3,6})/i)
  if (totalMatch) {
    const n = Number.parseInt(totalMatch[1]!, 10)
    if (n >= 512) return { device, totalMB: n }
  }
  return null
}

export function parseMetalProfiler(output: string): { device: string; totalMB?: number } | null {
  // system_profiler SPDisplaysDataType 片段:
  // Chipset Model: Apple M3 Max
  // VRAM (Total): 48 GB  或 36 GB /  Unified Memory
  const chipset = output.match(/Chipset Model:\s*(.+)/i)?.[1]?.trim()
  const vramLine = output.match(/VRAM[^:]*:\s*(\d+)\s*GB/i)
  const unified = output.match(/Unified Memory[^:]*:\s*(\d+)\s*GB/i) ?? output.match(/Memory:\s*(\d+)\s*GB/i)
  const gbStr = vramLine?.[1] ?? unified?.[1]
  const totalMB = gbStr ? Number.parseInt(gbStr, 10) * 1024 : undefined
  const device = chipset ?? 'Apple GPU'
  // Metal: Supported 存在则认为可用，否则也以 chipset 判断
  const metalSupported = /Metal:\s*Supported/i.test(output) || /Metal.*Supported/i.test(output)
  if (!chipset && !metalSupported && totalMB == null) {
    // 没有任何 Apple GPU 迹象视为未命中；但为 fallback，仍返回 null 让调用方决定
    if (!/Apple/i.test(output)) return null
  }
  return { device, totalMB }
}

export function parseVulkanInfo(output: string): { device: string } | null {
  // vulkaninfo --summary 包含 "Vulkan Instance Version" 且 deviceName / GPU 段落
  if (!/Vulkan Instance Version/i.test(output) && !/Vulkan/i.test(output)) return null
  const dev = output.match(/deviceName\s*=\s*(.+)/i)?.[1]?.trim() ?? output.match(/GPU\d*:\s*(.+)/i)?.[1]?.trim() ?? 'Vulkan Device'
  return { device: dev }
}

// ---------------------------------------------------------------------------
// Fits logic
// ---------------------------------------------------------------------------

export function buildVram(totalMB: number, freeMB?: number): VramInfo {
  const usedMB = freeMB != null && Number.isFinite(freeMB) ? totalMB - freeMB : undefined
  return {
    totalMB,
    freeMB: freeMB != null && Number.isFinite(freeMB) ? freeMB : undefined,
    usedMB: usedMB != null && usedMB >= 0 ? usedMB : undefined,
    totalGB: Math.round((totalMB / 1024) * 10) / 10,
  }
}

export function doesFit(totalMB: number | null | undefined, requiredMB: number = DEFAULT_REQUIRED_VRAM_MB): boolean {
  if (totalMB == null) return false
  return totalMB >= requiredMB
}

export function fitsForModel(info: GpuInfo, requiredMB: number = DEFAULT_REQUIRED_VRAM_MB): boolean {
  if (info.backend === 'cpu') return false
  if (!info.vram) return true // 有 GPU 但无显存信息时假定可尝试
  return doesFit(info.vram.totalMB, requiredMB)
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

export function formatGpuForUI(info: GpuInfo): string {
  const label = GPU_BACKEND_LABEL[info.backend] ?? info.backend
  if (info.backend === 'cpu') return `${label} — 未检测到独立 GPU，已回退 CPU`
  const vramStr = info.vram ? `${info.vram.totalGB ?? Math.round(info.vram.totalMB / 1024)} GB` : '显存未知'
  const dev = info.device ? ` (${info.device})` : ''
  const fitsStr = info.fits ? '✓ 可承载' : '✗ 显存不足'
  return `${label}${dev} · ${vramStr} · ${fitsStr}`
}

export function toDisplayName(info: GpuInfo): string {
  return info.displayName ?? formatGpuForUI(info)
}

// ---------------------------------------------------------------------------
// Detectors (injectable exec + platform)
// ---------------------------------------------------------------------------

export type DetectOptions = {
  execFn?: ExecFn
  platform?: NodeJS.Platform
  requiredVramMB?: number
  timeoutMs?: number
}

async function detectCuda(execFn: ExecFn, timeout?: number): Promise<GpuInfo | null> {
  // 首选带 query 的精确输出；失败则回退 nvidia-smi 基础调用
  const q = await execFn('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout })
  if (q.code === 0 && q.stdout.trim()) {
    const parsed = parseNvidiaSmiCsv(q.stdout)
    if (parsed) {
      const vram = buildVram(parsed.totalMB, parsed.freeMB)
      const fits = vram.totalMB >= MIN_USABLE_VRAM_MB
      return { backend: 'cuda', vram, fits, device: parsed.device, displayName: `${GPU_BACKEND_LABEL.cuda} (${parsed.device})`, reason: 'nvidia-smi' }
    }
  }
  // 回退: 仅执行 nvidia-smi 看是否成功（用于无 query 的旧版本）
  if (q.code !== 127) {
    const fallback = await execFn('nvidia-smi', [], { timeout })
    if (fallback.code === 0 && /NVIDIA/i.test(fallback.stdout)) {
      // 能执行但 query 失败（如权限/旧版），仍标记 cuda 但显存未知
      return { backend: 'cuda', vram: null, fits: true, device: 'NVIDIA GPU', displayName: GPU_BACKEND_LABEL.cuda, reason: 'nvidia-smi (no query)' }
    }
  }
  return null
}

async function detectRocm(execFn: ExecFn, timeout?: number): Promise<GpuInfo | null> {
  const r = await execFn('rocm-smi', ['--showmeminfo', 'vram'], { timeout })
  if (r.code === 0 && r.stdout.trim()) {
    const parsed = parseRocmSmi(r.stdout)
    if (parsed) {
      const vram = buildVram(parsed.totalMB)
      return { backend: 'rocm', vram, fits: vram.totalMB >= MIN_USABLE_VRAM_MB, device: parsed.device, displayName: `${GPU_BACKEND_LABEL.rocm} (${parsed.device})`, reason: 'rocm-smi' }
    }
    // 有输出但解析失败仍视为 rocm 可用
    return { backend: 'rocm', vram: null, fits: true, device: 'AMD GPU', displayName: GPU_BACKEND_LABEL.rocm, reason: 'rocm-smi' }
  }
  // 备用: rocm-smi 无参
  if (r.code !== 127) {
    const r2 = await execFn('rocm-smi', [], { timeout })
    if (r2.code === 0 && /AMD|Radeon|ROCm/i.test(r2.stdout)) {
      const parsed = parseRocmSmi(r2.stdout)
      if (parsed) {
        const vram = buildVram(parsed.totalMB)
        return { backend: 'rocm', vram, fits: vram.totalMB >= MIN_USABLE_VRAM_MB, device: parsed.device, displayName: `${GPU_BACKEND_LABEL.rocm} (${parsed.device})`, reason: 'rocm-smi' }
      }
      return { backend: 'rocm', vram: null, fits: true, device: 'AMD GPU', displayName: GPU_BACKEND_LABEL.rocm, reason: 'rocm-smi' }
    }
  }
  return null
}

async function detectMetal(execFn: ExecFn, platform: string, timeout?: number): Promise<GpuInfo | null> {
  if (platform !== 'darwin') return null
  const m = await execFn('system_profiler', ['SPDisplaysDataType'], { timeout })
  if (m.code === 0 && m.stdout.trim()) {
    const parsed = parseMetalProfiler(m.stdout)
    if (parsed) {
      const vram = parsed.totalMB ? buildVram(parsed.totalMB) : null
      const fits = vram ? vram.totalMB >= MIN_USABLE_VRAM_MB : true
      return { backend: 'metal', vram, fits, device: parsed.device, displayName: `${GPU_BACKEND_LABEL.metal} (${parsed.device})`, reason: 'system_profiler SPDisplaysDataType' }
    }
  }
  // darwin 上若 profiler 失败但系统是 macOS，仍兜底返回 metal（显存未知）
  if (m.code !== 127) {
    // 非 ENOENT 视为系统存在但解析失败
    return null
  }
  // ENOENT 时尝试 fallback: uname 无法判断，返回 null
  return null
}

async function detectVulkan(execFn: ExecFn, timeout?: number): Promise<GpuInfo | null> {
  const v = await execFn('vulkaninfo', ['--summary'], { timeout })
  if (v.code === 0 && v.stdout.trim()) {
    const parsed = parseVulkanInfo(v.stdout)
    if (parsed) {
      return { backend: 'vulkan', vram: null, fits: true, device: parsed.device, displayName: `${GPU_BACKEND_LABEL.vulkan} (${parsed.device})`, reason: 'vulkaninfo' }
    }
  }
  // 部分发行版 vulkaninfo 不支持 --summary，尝试无参
  if (v.code !== 127) {
    const v2 = await execFn('vulkaninfo', [], { timeout })
    if (v2.code === 0 && /Vulkan/i.test(v2.stdout)) {
      const parsed = parseVulkanInfo(v2.stdout)
      return { backend: 'vulkan', vram: null, fits: true, device: parsed?.device ?? 'Vulkan Device', displayName: GPU_BACKEND_LABEL.vulkan, reason: 'vulkaninfo' }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * 探测 GPU 后端。顺序: CUDA -> ROCm -> Metal(仅 darwin) -> Vulkan -> CPU 回退
 * 注入 execFn / platform 便于单测；超时默认 4000ms。
 */
export async function detectGpu(opts: DetectOptions = {}): Promise<GpuInfo> {
  const execFn = opts.execFn ?? defaultExec
  const platform = opts.platform ?? process.platform
  const requiredMB = opts.requiredVramMB ?? DEFAULT_REQUIRED_VRAM_MB
  const timeout = opts.timeoutMs ?? 4000

  const cuda = await detectCuda(execFn, timeout)
  if (cuda) {
    if (cuda.vram) cuda.fits = doesFit(cuda.vram.totalMB, requiredMB)
    return cuda
  }

  const rocm = await detectRocm(execFn, timeout)
  if (rocm) {
    if (rocm.vram) rocm.fits = doesFit(rocm.vram.totalMB, requiredMB)
    return rocm
  }

  const metal = await detectMetal(execFn, platform, timeout)
  if (metal) {
    if (metal.vram) metal.fits = doesFit(metal.vram.totalMB, requiredMB)
    return metal
  }

  const vulkan = await detectVulkan(execFn, timeout)
  if (vulkan) return vulkan

  return {
    backend: 'cpu',
    vram: null,
    fits: false,
    device: 'CPU',
    displayName: GPU_BACKEND_LABEL.cpu,
    reason: 'no GPU detected, fallback to CPU',
  }
}

/** 别名，便于外部调用 */
export const getGpuInfo = detectGpu

// ---------------------------------------------------------------------------
// HTTP handler — GET /health/gpu
// ---------------------------------------------------------------------------

export type GpuHealthResponse = {
  backend: GpuBackend
  vram: VramInfo | null
  fits: boolean
  device?: string
  displayName?: string
  reason?: string
  /** UI 额外字段 */
  uiText?: string
}

export function toHealthResponse(info: GpuInfo): GpuHealthResponse {
  return {
    backend: info.backend,
    vram: info.vram,
    fits: info.fits,
    device: info.device,
    displayName: info.displayName ?? formatGpuForUI(info),
    reason: info.reason,
    uiText: formatGpuForUI(info),
  }
}

export type GpuHandlerOptions = DetectOptions & {
  /** 覆盖探测结果（用于缓存/单测） */
  getInfo?: () => Promise<GpuInfo>
}

/**
 * 创建 Node http 风格 handler: (req, res) => void
 * 仅响应 GET /health/gpu，其他路径 next() 或 404。
 * 同时兼容 fetch Request -> Response 的 handleGpuRequest。
 */
export function createGpuHealthHandler(opts: GpuHandlerOptions = {}) {
  const getInfo = opts.getInfo ?? (() => detectGpu(opts))

  const handler = async (req: { method?: string; url?: string }, res: { statusCode?: number; setHeader?: (k: string, v: string) => void; end?: (b: string) => void }) => {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = req.url ?? '/health/gpu'
    let pathname: string
    try {
      pathname = new URL(url, 'http://127.0.0.1').pathname
    } catch {
      pathname = url
    }
    if (pathname !== '/health/gpu') {
      if (res.statusCode != null) res.statusCode = 404
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: 'not found' }))
      return
    }
    if (method !== 'GET') {
      if (res.statusCode != null) res.statusCode = 405
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    try {
      const info = await getInfo()
      const body = toHealthResponse(info)
      if (res.statusCode != null) res.statusCode = 200
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify(body))
    } catch (e) {
      if (res.statusCode != null) res.statusCode = 500
      res.setHeader?.('content-type', 'application/json')
      res.end?.(JSON.stringify({ error: (e as Error).message ?? String(e) }))
    }
  }

  // fetch-style helper attached
  ;(handler as unknown as Record<string, unknown>)['handleRequest'] = async (req: Request): Promise<Response> => {
    const info = await getInfo()
    const body = toHealthResponse(info)
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  return handler as typeof handler & { handleRequest: (req: Request) => Promise<Response> }
}

/**
 * 纯函数: 将 Request 映射为 GET /health/gpu Response。
 * 适用于 fetch / Electron net / 中间件挂载。
 */
export async function handleGpuRequest(req: Request, opts: GpuHandlerOptions = {}): Promise<Response> {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname !== '/health/gpu') {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  if (req.method.toUpperCase() !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'content-type': 'application/json' } })
  }
  const getInfo = opts.getInfo ?? (() => detectGpu(opts))
  const info = await getInfo()
  const body = toHealthResponse(info)
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

export default detectGpu
