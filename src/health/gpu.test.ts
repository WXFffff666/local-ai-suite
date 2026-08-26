import { describe, it, expect, vi } from 'vitest'
import {
  parseNvidiaSmiCsv,
  parseRocmSmi,
  parseMetalProfiler,
  parseVulkanInfo,
  buildVram,
  doesFit,
  fitsForModel,
  formatGpuForUI,
  detectGpu,
  toHealthResponse,
  createGpuHealthHandler,
  handleGpuRequest,
  GPU_BACKEND_LABEL,
  DEFAULT_REQUIRED_VRAM_MB,
  type GpuInfo,
  type ExecFn,
} from './gpu'

// helper to mock execFn
function mockExec(responses: Record<string, { stdout: string; code: number }>): ExecFn {
  return async (cmd: string, args: string[] = []) => {
    const key = `${cmd} ${args.join(' ')}`.trim()
    // try exact match, then cmd only
    if (responses[key]) return { stdout: responses[key].stdout, stderr: '', code: responses[key].code }
    if (responses[cmd]) return { stdout: responses[cmd].stdout, stderr: '', code: responses[cmd].code }
    return { stdout: '', stderr: 'ENOENT', code: 127 }
  }
}

describe('parseNvidiaSmiCsv', () => {
  it('parses cuda csv', () => {
    const r = parseNvidiaSmiCsv('NVIDIA GeForce RTX 4090, 24564, 23000\n')
    expect(r?.device).toBe('NVIDIA GeForce RTX 4090')
    expect(r?.totalMB).toBe(24564)
    expect(r?.freeMB).toBe(23000)
  })
  it('returns null on empty', () => {
    expect(parseNvidiaSmiCsv('')).toBeNull()
    expect(parseNvidiaSmiCsv('   \n')).toBeNull()
  })
  it('parses without free', () => {
    const r = parseNvidiaSmiCsv('NVIDIA Tesla V100, 16384\n')
    expect(r?.totalMB).toBe(16384)
  })
})

describe('parseMetalProfiler', () => {
  it('parses Apple M3', () => {
    const out = `Chipset Model: Apple M3 Max\nVRAM (Total): 48 GB\nMetal: Supported`
    const r = parseMetalProfiler(out)
    expect(r?.device).toBe('Apple M3 Max')
    expect(r?.totalMB).toBe(48 * 1024)
  })
  it('null on non-apple empty', () => {
    expect(parseMetalProfiler('blah no gpu')).toBeNull()
  })
})

describe('parseVulkanInfo', () => {
  it('parses vulkan summary', () => {
    const out = `Vulkan Instance Version: 1.3.250\ndeviceName = NVIDIA GeForce RTX 4080`
    expect(parseVulkanInfo(out)?.device).toBe('NVIDIA GeForce RTX 4080')
  })
  it('null when no vulkan', () => {
    expect(parseVulkanInfo('no gpu here')).toBeNull()
  })
})

describe('parseRocmSmi', () => {
  it('parses MB', () => {
    const r = parseRocmSmi('Radeon RX 7900 XTX  VRAM Total Memory 24576 MB')
    expect(r?.totalMB).toBe(24576)
  })
})

describe('buildVram / doesFit / fitsForModel', () => {
  it('buildVram calculates GB', () => {
    const v = buildVram(24564, 23000)
    expect(v.totalMB).toBe(24564)
    expect(v.freeMB).toBe(23000)
    expect(v.usedMB).toBe(1564)
    expect(v.totalGB).toBe(24)
  })
  it('doesFit threshold', () => {
    expect(doesFit(4096, 2048)).toBe(true)
    expect(doesFit(1024, 2048)).toBe(false)
    expect(doesFit(null as unknown as number)).toBe(false)
  })
  it('fitsForModel cpu false', () => {
    const info: GpuInfo = { backend: 'cpu', vram: null, fits: false }
    expect(fitsForModel(info)).toBe(false)
  })
  it('fitsForModel with vram true', () => {
    const info: GpuInfo = { backend: 'cuda', vram: buildVram(8192), fits: true }
    expect(fitsForModel(info, 2048)).toBe(true)
  })
  it('formatGpuForUI', () => {
    const info: GpuInfo = { backend: 'cuda', vram: buildVram(8192), fits: true, device: 'RTX 4090', displayName: GPU_BACKEND_LABEL.cuda }
    const s = formatGpuForUI(info)
    expect(s).toContain('NVIDIA CUDA')
  })
})

describe('detectGpu — CUDA / Metal / Vulkan / CPU fallback', () => {
  it('detects CUDA via nvidia-smi', async () => {
    const exec = mockExec({
      'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits': { stdout: 'NVIDIA GeForce RTX 4090, 24564, 23000\n', code: 0 },
    })
    const info = await detectGpu({ execFn: exec, requiredVramMB: 2048 })
    expect(info.backend).toBe('cuda')
    expect(info.vram?.totalMB).toBe(24564)
    expect(info.fits).toBe(true)
    expect(info.device).toContain('4090')
  })

  it('cuda fits false when vram small', async () => {
    const exec = mockExec({
      'nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits': { stdout: 'NVIDIA GTX 1050, 2048, 1000\n', code: 0 },
    })
    const info = await detectGpu({ execFn: exec, requiredVramMB: 8192 })
    expect(info.backend).toBe('cuda')
    expect(info.fits).toBe(false)
  })

  it('detects Metal on darwin via system_profiler', async () => {
    const exec: ExecFn = async (cmd, args) => {
      if (cmd === 'nvidia-smi') return { stdout: '', stderr: '', code: 127 }
      if (cmd === 'rocm-smi') return { stdout: '', stderr: '', code: 127 }
      if (cmd === 'system_profiler') return { stdout: 'Chipset Model: Apple M2 Pro\nVRAM (Total): 32 GB\nMetal: Supported', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 127 }
    }
    const info = await detectGpu({ execFn: exec, platform: 'darwin' })
    expect(info.backend).toBe('metal')
    expect(info.vram?.totalMB).toBe(32768)
  })

  it('detects Vulkan when cuda/metal absent', async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'nvidia-smi' || cmd === 'rocm-smi') return { stdout: '', stderr: '', code: 127 }
      if (cmd === 'system_profiler') return { stdout: '', stderr: '', code: 127 }
      if (cmd === 'vulkaninfo') return { stdout: 'Vulkan Instance Version: 1.3.0\ndeviceName = AMD Radeon RX 7900', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 127 }
    }
    const info = await detectGpu({ execFn: exec, platform: 'linux' })
    expect(info.backend).toBe('vulkan')
    expect(info.device).toContain('Radeon')
  })

  it('detects ROCm', async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'nvidia-smi') return { stdout: '', stderr: '', code: 127 }
      if (cmd === 'rocm-smi') return { stdout: 'Radeon RX 7900 XTX VRAM Total Memory 24576 MB', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 127 }
    }
    const info = await detectGpu({ execFn: exec })
    expect(info.backend).toBe('rocm')
    expect(info.vram?.totalMB).toBe(24576)
  })

  it('falls back to cpu', async () => {
    const exec: ExecFn = async () => ({ stdout: '', stderr: '', code: 127 })
    const info = await detectGpu({ execFn: exec, platform: 'win32' })
    expect(info.backend).toBe('cpu')
    expect(info.vram).toBeNull()
    expect(info.fits).toBe(false)
  })

  it('priority cuda > rocm > metal > vulkan', async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA RTX 4090, 24564, 23000', stderr: '', code: 0 }
      if (cmd === 'rocm-smi') return { stdout: 'Radeon 24576 MB', stderr: '', code: 0 }
      if (cmd === 'vulkaninfo') return { stdout: 'Vulkan Instance Version: 1.3', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 127 }
    }
    const info = await detectGpu({ execFn: exec })
    expect(info.backend).toBe('cuda')
  })
})

describe('GET /health/gpu 返回 backend/vram/fits', () => {
  it('toHealthResponse maps backend/vram/fits', () => {
    const info: GpuInfo = { backend: 'cuda', vram: buildVram(8192), fits: true, device: 'RTX 4090', displayName: 'NVIDIA CUDA (RTX 4090)', reason: 'nvidia-smi' }
    const res = toHealthResponse(info)
    expect(res.backend).toBe('cuda')
    expect(res.vram?.totalMB).toBe(8192)
    expect(res.fits).toBe(true)
    expect(res.device).toBe('RTX 4090')
  })

  it('createGpuHealthHandler node-style 200 + backend/vram/fits', async () => {
    const fakeInfo: GpuInfo = { backend: 'metal', vram: buildVram(32768), fits: true, device: 'Apple M3 Max', displayName: 'Apple Metal (Apple M3 Max)', reason: 'system_profiler' }
    const handler = createGpuHealthHandler({ getInfo: async () => fakeInfo })
    const req = { method: 'GET', url: '/health/gpu' }
    let body = ''
    const res: Record<string, unknown> = { statusCode: 200, setHeader: vi.fn(), end: (b: string) => { body = b } }
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    expect(res['statusCode']).toBe(200)
    const json = JSON.parse(body)
    expect(json.backend).toBe('metal')
    expect(json.vram.totalMB).toBe(32768)
    expect(json.fits).toBe(true)
  })

  it('createGpuHealthHandler 404 on wrong path', async () => {
    const handler = createGpuHealthHandler({ getInfo: async () => ({ backend: 'cpu', vram: null, fits: false }) })
    const req = { method: 'GET', url: '/health/other' }
    const res: Record<string, unknown> = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    expect(res['statusCode']).toBe(404)
  })

  it('createGpuHealthHandler 405 on POST', async () => {
    const handler = createGpuHealthHandler({ getInfo: async () => ({ backend: 'cpu', vram: null, fits: false }) })
    const req = { method: 'POST', url: '/health/gpu' }
    const res: Record<string, unknown> = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)
    expect(res['statusCode']).toBe(405)
  })

  it('handleGpuRequest fetch-style returns Response with backend/vram/fits', async () => {
    const fakeInfo: GpuInfo = { backend: 'vulkan', vram: null, fits: true, device: 'Vulkan Device', displayName: 'Vulkan' }
    const req = new Request('http://127.0.0.1/health/gpu', { method: 'GET' })
    const res = await handleGpuRequest(req, { getInfo: async () => fakeInfo })
    expect(res.status).toBe(200)
    const json = await res.json() as { backend: string; fits: boolean }
    expect(json.backend).toBe('vulkan')
    expect(json.fits).toBe(true)
  })

  it('handleGpuRequest 404 and 405', async () => {
    expect((await handleGpuRequest(new Request('http://127.0.0.1/health/other'))).status).toBe(404)
    expect((await handleGpuRequest(new Request('http://127.0.0.1/health/gpu', { method: 'POST' }))).status).toBe(405)
  })

  it('handler handleRequest attached fetch helper', async () => {
    const fakeInfo: GpuInfo = { backend: 'cuda', vram: buildVram(24564), fits: true, device: 'RTX 4090' }
    const h = createGpuHealthHandler({ getInfo: async () => fakeInfo }) as unknown as { handleRequest: (r: Request) => Promise<Response> }
    const res = await h.handleRequest(new Request('http://127.0.0.1/health/gpu'))
    expect(res.status).toBe(200)
    const j = await res.json() as { backend: string; vram: { totalMB: number } }
    expect(j.backend).toBe('cuda')
    expect(j.vram.totalMB).toBe(24564)
  })

  it('DEFAULT_REQUIRED_VRAM_MB is 2048', () => {
    expect(DEFAULT_REQUIRED_VRAM_MB).toBe(2048)
  })
})
