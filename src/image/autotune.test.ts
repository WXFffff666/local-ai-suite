/**
 * autotune.test.ts — 自动档位纯函数测试：家族识别 + 显存→参数映射。
 */

import { describe, expect, it } from 'vitest'

import { autoDefaults, detectModelFamily } from './autotune'

describe('detectModelFamily', () => {
  it('识别 Z-Image / Flux / SDXL / SD1.5', () => {
    expect(detectModelFamily('z-image-turbo-Q8_0.gguf')).toBe('zimage-turbo')
    expect(detectModelFamily('ZImageTurbo_v1.safetensors')).toBe('zimage-turbo')
    expect(detectModelFamily('flux1-schnell-Q4_K_S.gguf')).toBe('flux')
    expect(detectModelFamily('sdxl_base_1.0.safetensors')).toBe('sdxl')
    expect(detectModelFamily('stable-diffusion-xl-base.safetensors')).toBe('sdxl')
    expect(detectModelFamily('sd15-pruned-Q4_0.gguf')).toBe('sd15')
    expect(detectModelFamily('stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf')).toBe('sd15')
    expect(detectModelFamily('some-random-model.gguf')).toBe('other')
  })
})

describe('autoDefaults 档位映射', () => {
  it('8GB + Z-Image Q8 → 1024² / 8 步 / cfg 1.0 / 推荐 Q8', () => {
    const d = autoDefaults({
      vramMB: 8188,
      models: ['z-image-turbo-Q4_K_S.gguf', 'z-image-turbo-Q8_0.gguf'],
    })
    expect(d).toMatchObject({ width: 1024, height: 1024, steps: 8, cfgScale: 1.0 })
    expect(d.recommendedModel).toContain('Q8_0')
    expect(d.message).toContain('高质量档')
  })

  it('6GB + Z-Image Q4 → 快速档', () => {
    const d = autoDefaults({ vramMB: 6144, models: ['z-image-turbo-Q4_K_S.gguf'] })
    expect(d).toMatchObject({ width: 1024, steps: 8 })
    expect(d.message).toContain('快速档')
  })

  it('3GB + Z-Image → 768² 保守', () => {
    const d = autoDefaults({ vramMB: 3072, models: ['z-image-turbo-Q4_K_S.gguf'] })
    expect(d.width).toBe(768)
  })

  it('无 Z-Image 时回退 Flux（4 步）→ SDXL（25 步）→ SD1.5（512²）', () => {
    const flux = autoDefaults({ vramMB: 8192, models: ['flux1-schnell-Q4_K_S.gguf'] })
    expect(flux).toMatchObject({ steps: 4, cfgScale: 1.0 })
    const sdxl = autoDefaults({ vramMB: 8192, models: ['sdxl_base_1.0.safetensors'] })
    expect(sdxl).toMatchObject({ width: 1024, steps: 25, cfgScale: 7 })
    const sd15 = autoDefaults({ vramMB: 4096, models: ['sd15-pruned-Q4_0.gguf'] })
    expect(sd15).toMatchObject({ width: 512, steps: 25 })
  })

  it('SDXL <6GB 降到 768²', () => {
    const d = autoDefaults({ vramMB: 5120, models: ['sdxl_base_1.0.safetensors'] })
    expect(d.width).toBe(768)
    expect(d.message).toContain('<6GB')
  })

  it('无模型 → 保守默认 + 引导下载', () => {
    const d = autoDefaults({ vramMB: 8192, models: [] })
    expect(d).toMatchObject({ width: 512, steps: 20 })
    expect(d.recommendedModel).toBeUndefined()
    expect(d.message).toContain('模型')
  })

  it('显存未知（无 nvidia-smi）→ 保守档不崩', () => {
    const d = autoDefaults({ vramMB: null, models: ['z-image-turbo-Q8_0.gguf'] })
    expect(d.width).toBe(768)
    expect(d.recommendedModel).toContain('Q8_0')
  })
})
