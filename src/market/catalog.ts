/**
 * catalog（阶段1）— 精选模型目录：为 8GB 显存档位预选好"开箱即用"组合，
 * 一键下载（HF 直下，画图模型落 models/diffusion/、对话模型落 models/llm/），
 * 并给 Civitai 来源页直达链接（用户可自行下载后拖入模型文件夹）。
 *
 * MIT, 无 AGPL.
 */

import type { HfModelCard } from './hf'

export type CuratedKind = 'image' | 'llm' | 'enhancer'

export type CuratedCard = HfModelCard & {
  kind: CuratedKind
  /** 下载目标目录（相对 modelsDir；registry 按目录前缀分类） */
  localDir: string
  /** 显存/硬件建议（中文一句话） */
  vramLabel: string
  /** Civitai 等外部来源页（可直接跳转下载后拖入文件夹） */
  externalUrl?: string
  externalLabel?: string
}

const HF = (repo: string, file: string): string => `https://huggingface.co/${repo}/resolve/main/${file}`

export const FEATURED_CATALOG: readonly CuratedCard[] = [
  // --- 画图：Z-Image Turbo（6B，8 步出图，原生中文理解，8GB 显存甜点） ---
  {
    kind: 'image',
    localDir: 'models/diffusion',
    repoId: 'Comfy-Org/z_image_turbo',
    name: 'Z-Image Turbo（默认画质档）',
    author: 'Comfy-Org',
    quant: 'Q8_0',
    filename: 'z_image_turbo-Q8_0.gguf',
    sizeLabel: '~6.9GB',
    gguf: true,
    description: '阿里通义 6B 生图模型，8 步出图、中文理解与汉字渲染最强，8GB 显存首选',
    tags: ['gguf', 'q8_0', 'z-image', 'turbo'],
    likes: 999,
    vramLabel: '建议显存 ≥8GB',
    externalUrl: 'https://huggingface.co/Comfy-Org/z_image_turbo',
    externalLabel: 'HF 页面',
  },
  {
    kind: 'image',
    localDir: 'models/diffusion',
    repoId: 'felipedpm/z-image-turbo-GGUF-confyui',
    name: 'Z-Image Turbo（快速档 Q4）',
    author: 'felipedpm',
    quant: 'Q4_K_S',
    filename: 'z_image_turbo-Q4_K_S.gguf',
    sizeLabel: '~3.5GB',
    gguf: true,
    description: 'Z-Image Turbo Q4 量化：显存紧张时的快速档，画质略降但速度更快',
    tags: ['gguf', 'q4_k_s', 'z-image', 'turbo'],
    likes: 500,
    vramLabel: '建议显存 ≥6GB',
    externalUrl: 'https://huggingface.co/felipedpm/z-image-turbo-GGUF-confyui',
    externalLabel: 'HF 页面',
  },
  {
    kind: 'image',
    localDir: 'models/diffusion',
    repoId: 'second-state/stable-diffusion-v1-5-GGUF',
    name: 'SD 1.5（极速档）',
    author: 'second-state',
    quant: 'Q4_0',
    filename: 'stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf',
    sizeLabel: '~1.6GB',
    gguf: true,
    description: '经典 SD1.5：1-2 秒出图，适合验证链路与批量草稿',
    tags: ['gguf', 'q4_0', 'sd15'],
    likes: 300,
    vramLabel: '显存 ≥3GB 即可',
  },
  // --- 提示词扩写（画图配套"思考"模型） ---
  {
    kind: 'enhancer',
    localDir: 'models/llm',
    repoId: 'unsloth/Qwen3-4B-Instruct-2507-GGUF',
    name: 'Qwen3-4B 提示词润色（推荐）',
    author: 'unsloth',
    quant: 'Q4_K_M',
    filename: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
    sizeLabel: '~2.5GB',
    gguf: true,
    description: '把你的中文一句话扩写成专业英文画图提示词；CPU 运行零显存占用',
    tags: ['gguf', 'q4_k_m', 'qwen3', 'instruct'],
    likes: 800,
    vramLabel: '纯 CPU 运行，无显存要求',
  },
  // --- 对话 ---
  {
    kind: 'llm',
    localDir: 'models/llm',
    repoId: 'unsloth/Qwen3-8B-GGUF',
    name: 'Qwen3-8B 通用对话',
    author: 'unsloth',
    quant: 'Q4_K_M',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    sizeLabel: '~5GB',
    gguf: true,
    description: '通用中文对话/写作，GPU 加速，与画图错峰使用',
    tags: ['gguf', 'q4_k_m', 'qwen3'],
    likes: 900,
    vramLabel: '建议显存 ≥6GB',
  },
]

/** HF 直链（UI「复制直链」按钮用，配合任意下载器） */
export function curatedDirectUrl(card: CuratedCard): string | undefined {
  return card.filename === undefined ? undefined : HF(card.repoId, card.filename)
}

export const CIVITAI_SEARCH_URL = 'https://civitai.com/search/images?query='
