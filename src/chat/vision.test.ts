/**
 * todo21 vision.ts 单测：intake 闸门 + 能力探测（注入 fake invoke，无 window 依赖）。
 */
import { describe, expect, it, vi } from 'vitest'

import {
  ACCEPTED_IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  VISION_DISABLED_TOOLTIP,
  isAcceptedImageFile,
  isRenderableImageSrc,
  probeVisionCapability,
  selectAttachableImages,
} from './vision'

describe('vision intake gates', () => {
  it('四类栅格 mime 收，svg/heic/webp 之外的全部拒', () => {
    expect(ACCEPTED_IMAGE_MIMES).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    for (const type of ACCEPTED_IMAGE_MIMES) {
      expect(isAcceptedImageFile({ type, size: 1024 })).toBe(true)
    }
    expect(isAcceptedImageFile({ type: 'image/svg+xml', size: 1024 })).toBe(false)
    expect(isAcceptedImageFile({ type: 'application/octet-stream', size: 1024 })).toBe(false)
  })

  it('4MiB 解码上限（file.size 即解码字节数）', () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024)
    expect(isAcceptedImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES })).toBe(true)
    expect(isAcceptedImageFile({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 })).toBe(false)
  })

  it('selectAttachableImages: 过滤不支持项并在剩余名额内截断（≤2/消息）', () => {
    expect(MAX_IMAGES_PER_MESSAGE).toBe(2)
    const files = [
      { type: 'image/png', size: 10 },
      { type: 'image/svg+xml', size: 10 },
      { type: 'image/webp', size: 10 },
      { type: 'image/gif', size: 10 },
    ]
    expect(selectAttachableImages(files, 0)).toEqual([0, 2])
    expect(selectAttachableImages(files, 1)).toEqual([0])
    expect(selectAttachableImages(files, 2)).toEqual([])
  })

  it('isRenderableImageSrc: 只认本地 dataURL 栅格图，远端/svg 一律 false', () => {
    expect(isRenderableImageSrc('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isRenderableImageSrc('data:image/jpeg;base64,/9j/4AAQ')).toBe(true)
    expect(isRenderableImageSrc('https://evil.example/x.png')).toBe(false)
    expect(isRenderableImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isRenderableImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
  })

  it('tooltip 文案 pin（plan QA-fail 场景）', () => {
    expect(VISION_DISABLED_TOOLTIP).toBe('该模型无视觉投影文件')
  })
})

describe('probeVisionCapability', () => {
  it('存在带 projectorPath 的 gguf → true', async () => {
    const invoke = vi.fn(async () => ({
      models: [
        { name: 'qwen2.5-vl', file: 'llm/a.gguf', format: 'gguf', projectorPath: 'C:\\models\\mmproj-a.gguf' },
        { name: 'bge', file: 'e.safetensors', format: 'safetensors' },
      ],
    }))
    await expect(probeVisionCapability(invoke)).resolves.toBe(true)
  })

  it('llama 模型全无投影文件 → false（attach 禁用依据）', async () => {
    const invoke = vi.fn(async () => ({ models: [{ format: 'gguf', name: 'qwen3' }] }))
    await expect(probeVisionCapability(invoke)).resolves.toBe(false)
  })

  it('projectorPath 空串/缺字段视为无；models:list 抛错降级 false', async () => {
    await expect(probeVisionCapability(async () => ({ models: [{ format: 'gguf', projectorPath: '' }] }))).resolves.toBe(false)
    await expect(probeVisionCapability(async () => { throw new Error('ipc gone') })).resolves.toBe(false)
    await expect(probeVisionCapability(async () => null)).resolves.toBe(false)
  })
})
