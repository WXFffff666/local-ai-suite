import { describe, it, expect } from 'vitest'
import {
  ALLOWED_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  assertAllowedChannel,
  assertAllowedEventChannel,
  isAllowedChannel,
  isAllowedEventChannel
} from './whitelist'

describe('ipc whitelist', () => {
  it('合法 channel 通过 — ALLOWED 中所有通道均被 isAllowedChannel 接受', () => {
    for (const ch of ALLOWED_CHANNELS) {
      expect(isAllowedChannel(ch)).toBe(true)
    }
    // W1-8 全集：原 12 项 + chat:abort + image:queue:status + gallery 五动词 +
    // search:run + hf:search + conversations 六通道（todo17 预列）
    // + todo13 models:setDir + todo14b download:cancel + todo16 config:get/config:set
    // + todo19 models:loraScan/models:loraMeta + todo20 image:saveTempImage
    // + todo23 agent:start/agent:status/agent:cancel
    // + todo30b models:launch + engines:status/engines:gpuDownload。
    expect(ALLOWED_CHANNELS).toEqual([
      'health:pulse',
      'models:list',
      'models:download',
      'models:setDir',
      'models:loraScan',
      'models:loraMeta',
      // todo30b: registry-driven llama relaunch (the 21→30 wired hop, services.launchModel)
      'models:launch',
      'download:cancel',
      'config:get',
      'config:set',
      'chat:send',
      'chat:abort',
      // todo23: agent tool-calling loop invoke channels
      'agent:start',
      'agent:status',
      'agent:cancel',
      // todo25: permission approval dialog respond channel
      'permission:respond',
      'image:generate',
      'image:queue:status',
      // todo20: renderer drop/mask-brush PNG dataURLs land under userData/tmp
      'image:saveTempImage',
      'gallery:list',
      'gallery:save',
      'gallery:copy',
      'gallery:insert',
      'gallery:reuse',
      'search:run',
      'hf:search',
      // todo39: RAG v1 hybrid retrieval (status probe / file|dir ingest / query)
      'rag:status',
      'rag:ingest',
      'rag:query',
      // todo30b: engine availability matrix + GPU pack download (events ride 'engines:progress')
      'engines:status',
      'engines:gpuDownload',
      'conversations:list',
      'conversations:create',
      'conversations:rename',
      'conversations:delete',
      'conversations:appendMessage',
      'conversations:listMessages',
      'dialog:confirmDestructive',
      'workspace:delete',
      'coverage:overwrite',
      'release:publish',
      'cache:clear',
      'secrets:encrypt',
      'secrets:decrypt',
      // todo32: staged auto-update gesture channels
      'update:check',
      'update:downloadAndInstall',
      // todo36: speech (whisper push-to-talk) — getStatus is spawn-free
      'speech:getStatus',
      'speech:setPrefs',
      'speech:pickModel',
      'speech:saveWav',
      'speech:transcribe',
      // todo37: local OCR (PaddleOCR-json pipe-mode sidecar) — status is
      // spawn-free AND download-free; install is an explicit gesture
      'ocr:status',
      'ocr:install',
      'ocr:recognize'
    ])
  })

  it('非法 channel 被拒 — 未知通道返回 false 且 assert 抛错', () => {
    const illegal = [
      'evil:channel',
      'health:pulse ',
      'chat:send:extra',
      '',
      'ipcRenderer',
      'models:Delete',
      // todo23 注册了 start/status/cancel 三条 — 其余 agent:* 仍不在白名单
      'agent:',
      'agent:approve',
      'agent:deny',
      'agent:send'
    ]
    for (const ch of illegal) {
      expect(isAllowedChannel(ch)).toBe(false)
      expect(() => assertAllowedChannel(ch)).toThrow(/not allowed/)
    }
  })

  it('preload invoke 面仅暴露白名单 — 无通配/全量暴露', () => {
    for (const ch of ALLOWED_CHANNELS) {
      expect(ch).toMatch(/^[a-z]+(?::[a-zA-Z-]+)+$/)
    }
    for (const ch of ALLOWED_CHANNELS) {
      expect(() => assertAllowedChannel(ch)).not.toThrow()
    }
  })
})

describe('ipc event whitelist (main -> renderer)', () => {
  it('事件白名单精确集 — 计划规定通道 + agent:* 预留 + app:notification', () => {
    expect(ALLOWED_EVENT_CHANNELS).toEqual([
      'chat:delta',
      'chat:done',
      'chat:error',
      'download:progress',
      'image:queue:status',
      'app:notification',
      'agent:event',
      'agent:term',
      // todo25: main -> renderer permission request event
      'permission:request',
      // todo30b: GPU pack download progress (terminal states incl 'quarantined')
      'engines:progress',
      // todo32: electron-updater state machine fanout
      'update:state',
      // todo37: OCR engine pack install progress (terminal done/quarantined/error)
      'ocr:progress'
    ])
    for (const ch of ALLOWED_EVENT_CHANNELS) {
      expect(isAllowedEventChannel(ch)).toBe(true)
      expect(() => assertAllowedEventChannel(ch)).not.toThrow()
    }
  })

  it('invoke 通道不等于事件通道 — 两套独立门禁', () => {
    // chat:send 可 invoke 但不可作为 main->renderer 事件订阅
    expect(isAllowedChannel('chat:send')).toBe(true)
    expect(isAllowedEventChannel('chat:send')).toBe(false)
    // chat:delta 可订阅但不可 invoke
    expect(isAllowedEventChannel('chat:delta')).toBe(true)
    expect(isAllowedChannel('chat:delta')).toBe(false)
  })

  it('未列入事件通道被拒 — assert 抛错', () => {
    const illegal = ['evil:event', 'webContents', 'chat:delta ', '', 'shell:exec']
    for (const ch of illegal) {
      expect(isAllowedEventChannel(ch)).toBe(false)
      expect(() => assertAllowedEventChannel(ch)).toThrow(/not allowed/)
    }
  })
})
