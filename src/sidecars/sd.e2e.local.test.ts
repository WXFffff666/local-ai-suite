/** 本地 E2E（不入 CI：需要真实 sd-server + GPU 模型）— 验证原生 img_gen 任务流 */
import { describe, it, expect } from 'vitest'
import { generateImage } from './sd'

const E2E_PORT = Number(process.env['SD_E2E_PORT'] ?? 0)
const d = E2E_PORT > 0 ? describe : describe.skip

d('local e2e: sd-server img_gen', () => {
  it('真实出图返回 PNG b64', async () => {
    const res = await generateImage(
      { prompt: 'a cute cat', steps: 4, width: 256, height: 256, cfg_scale: 7 },
      { port: E2E_PORT, pollMs: 300 },
    )
    expect(res.image).toMatch(/^iVBOR/)
  }, 120_000)
})
