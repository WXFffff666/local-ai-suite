/**
 * autotune（阶段1）— 设备检测 + 自动参数档位：用户只写一句话，分辨率/步数/
 * CFG/模型档位全部自动落定，无需手动调参。
 *
 * 纯函数（渲染层可算）：输入 = nvidia-smi 显存（engines:status 已暴露）+
 * 注册表 diffusion 文件名列表（models:list 已暴露），输出 = 默认参数与推荐模型。
 * 档位表依据 stable-diffusion.cpp 社区实测（8GB 卡 + GGUF 量化 + FA/VAE tile）：
 *   Z-Image Turbo Q8 ~7GB / Q4 ~5GB（8 步，cfg 1.0 蒸馏档）
 *   SDXL fp16 ~7GB（25 步，cfg 7）· SD1.5 ~3GB（25 步，cfg 7）
 *   FLUX.1-schnell Q4 ~8GB（4 步，cfg 1.0，T5 offload）
 *
 * MIT, 无 AGPL.
 */

/** 模型家族识别（按注册表文件名 token） */
export type ModelFamily = 'zimage-turbo' | 'sdxl' | 'sd15' | 'flux' | 'other'

export function detectModelFamily(fileName: string): ModelFamily {
  const n = fileName.toLowerCase()
  if (/z[-_]?image/.test(n)) return 'zimage-turbo'
  if (/flux/.test(n)) return 'flux'
  if (/(sdxl|stable[-_ ]?diffusion[-_ ]?xl)/.test(n)) return 'sdxl'
  if (/(sd[-_ ]?1[._-]?5|stable[-_ ]?diffusion[-_ ]?1)/.test(n) || /v1[-_]5/.test(n)) return 'sd15'
  return 'other'
}

export type AutoDefaults = {
  width: number
  height: number
  steps: number
  cfgScale: number
  /** 推荐模型（注册表条目名，作为 payload.model 子串匹配 pickDiffusionModel） */
  recommendedModel?: string
  /** 中文一句话说明（UI 直接展示） */
  message: string
}

/** 量化档偏好：显存够 → Q8（质量甜点），否则 Q4 系 */
function pickZimage(models: readonly string[], vramMB: number): string | undefined {
  const z = models.filter((m) => detectModelFamily(m) === 'zimage-turbo')
  if (z.length === 0) return undefined
  if (vramMB >= 7168) {
    const q8 = z.find((m) => /q8|f16|fp16/.test(m.toLowerCase()))
    if (q8 !== undefined) return q8
  }
  const q4 = z.find((m) => /q4|iq4|q5/.test(m.toLowerCase()))
  return q4 ?? z[0]
}

/**
 * 自动档位主函数。models 为注册表 diffusion/** 文件名（或条目名）列表；
 * vramMB 缺失（无 nvidia-smi）时按最保守档兜底。
 */
export function autoDefaults(params: { vramMB?: number | null; models: readonly string[] }): AutoDefaults {
  const { models } = params
  const vramMB = params.vramMB ?? 0
  const gb = vramMB / 1024

  // 1) Z-Image Turbo：8GB 显存首选（原生中文理解 + 8 步出图）
  const zimage = pickZimage(models, vramMB)
  if (zimage !== undefined) {
    if (gb >= 7) {
      return {
        width: 1024,
        height: 1024,
        steps: 8,
        cfgScale: 1.0,
        recommendedModel: zimage,
        message: `检测到 ${gb.toFixed(0)}GB 显存，已选 Z-Image Turbo 高质量档（1024²，8 步）`,
      }
    }
    if (gb >= 4.5) {
      return {
        width: 1024,
        height: 1024,
        steps: 8,
        cfgScale: 1.0,
        recommendedModel: zimage,
        message: `检测到 ${gb.toFixed(1)}GB 显存，已选 Z-Image Turbo 快速档（1024²，8 步）`,
      }
    }
    return {
      width: 768,
      height: 768,
      steps: 8,
      cfgScale: 1.0,
      recommendedModel: zimage,
      message: `显存 ${gb.toFixed(1)}GB 偏小，已自动降到 768² 保守出图`,
    }
  }

  // 2) FLUX.1-schnell：4 步蒸馏（大显存 or offload，慢）
  const flux = models.find((m) => detectModelFamily(m) === 'flux')
  if (flux !== undefined) {
    return {
      width: 1024,
      height: 1024,
      steps: 4,
      cfgScale: 1.0,
      recommendedModel: flux,
      message: '已选 FLUX schnell 细节档（1024²，4 步，出图较慢）',
    }
  }

  // 3) SDXL
  const sdxl = models.find((m) => detectModelFamily(m) === 'sdxl')
  if (sdxl !== undefined) {
    const small = gb > 0 && gb < 6
    return {
      width: small ? 768 : 1024,
      height: small ? 768 : 1024,
      steps: 25,
      cfgScale: 7,
      recommendedModel: sdxl,
      message: small
        ? `显存 ${gb.toFixed(1)}GB <6GB，SDXL 已降到 768² 保守出图`
        : '已选 SDXL（1024²，25 步）',
    }
  }

  // 4) SD1.5
  const sd15 = models.find((m) => detectModelFamily(m) === 'sd15')
  if (sd15 !== undefined) {
    return {
      width: 512,
      height: 512,
      steps: 25,
      cfgScale: 7,
      recommendedModel: sd15,
      message: '已选 SD1.5 极速档（512²，25 步）',
    }
  }

  // 5) 无任何已知家族 → 保守默认 + 引导
  return {
    width: 512,
    height: 512,
    steps: 20,
    cfgScale: 7,
    message: '未识别画图模型档位 — 请在「模型」页下载 Z-Image Turbo / SD 模型到 models/diffusion/',
  }
}
