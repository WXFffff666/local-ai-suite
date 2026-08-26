import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Buffer } from 'buffer'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => { throw new Error('mock: no electron in test') }) },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((s: string) => Buffer.from('enc:' + s)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, '')),
  },
}))

import {
  DEFAULT_SETTINGS,
  encryptSecret,
  decryptSecret,
  maskSecret,
  isEncryptedPayload,
  validatePort,
  validatePorts,
  validateHfToken,
  validateImageBackend,
  validateSearchSettings,
  getSettings,
  saveSettings,
  rotateSecrets,
  clearSecret,
  getSettingsPath,
  ENC_PREFIX,
  ENC_FALLBACK_PREFIX,
  __setMockSafeStorage,
} from './settings'

let tmpDir = ''
let origCwd = ''

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'las-settings-'))
  origCwd = process.cwd()
  process.chdir(tmpDir)
  __setMockSafeStorage(null)
})

afterEach(() => {
  try { process.chdir(origCwd) } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  __setMockSafeStorage(null)
})

describe('settings — safeStorage 加密与脱敏', () => {
  it('fallback 加密非明文且可往返解密', async () => {
    const plain = 'hf_test_token_123'
    const enc = await encryptSecret(plain)
    expect(enc).not.toContain(plain)
    expect(isEncryptedPayload(enc)).toBe(true)
    expect(enc.startsWith(ENC_FALLBACK_PREFIX) || enc.startsWith(ENC_PREFIX)).toBe(true)
    const dec = await decryptSecret(enc)
    expect(dec).toBe(plain)
  })

  it('safeStorage 路径往返', async () => {
    const mock = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from('MOCK_ENC:' + s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8').replace(/^MOCK_ENC:/, ''),
    }
    __setMockSafeStorage(mock)
    const plain = 'tvly-abc123-secret'
    const enc = await encryptSecret(plain)
    expect(enc.startsWith(ENC_PREFIX)).toBe(true)
    expect(enc).not.toContain(plain)
    expect(await decryptSecret(enc)).toBe(plain)
  })

  it('IPC 可用时优先走主进程 safeStorage（归属修复）', async () => {
    const calls: Array<[string, unknown[]]> = []
    ;(globalThis as unknown as { api?: unknown }).api = {
      invoke: async (ch: string, ...args: unknown[]) => {
        calls.push([ch, args])
        if (ch === 'secrets:encrypt') return { ok: true, value: 'enc:v1:FROMMAIN' }
        if (ch === 'secrets:decrypt') return { ok: true, value: 'plain-from-main' }
        return { ok: false, error: 'unexpected channel' }
      },
    }
    try {
      const enc = await encryptSecret('secret-via-main')
      expect(enc).toBe('enc:v1:FROMMAIN')
      expect(calls[0][0]).toBe('secrets:encrypt')
      const dec = await decryptSecret('enc:v1:whatever')
      expect(dec).toBe('plain-from-main')
      expect(calls[1][0]).toBe('secrets:decrypt')
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).api
    }
  })

  it('maskSecret 永不暴露明文', async () => {
    expect(maskSecret('')).toBe('未配置')
    expect(maskSecret('ab')).toBe('****')
    const masked = maskSecret('hf_abcdefghijklmnopqrstuvwxyz')
    expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(masked).toMatch(/^\w{2}\*\*\*\*\w{2}$/)
  })

  it('空密钥不产生密文', async () => {
    expect(await encryptSecret('')).toBe('')
    expect(await decryptSecret('')).toBe('')
  })

  it('落盘永不明文 — settings.json 不含明文 token/key', async () => {
    const token = 'hf_super_secret_999'
    const tavily = 'tvly-secret-xyz'
    await saveSettings({ hfToken: token, search: { tavilyApiKey: tavily } })
    const fp = getSettingsPath()
    expect(existsSync(fp)).toBe(true)
    const raw = readFileSync(fp, 'utf-8')
    expect(raw).not.toContain(token)
    expect(raw).not.toContain(tavily)
    // 含加密前缀
    expect(raw).toContain('enc:')
    // 读回能解密
    const loaded = await getSettings()
    expect(loaded.hfToken).toBe(token)
    expect(loaded.search.tavilyApiKey).toBe(tavily)
  })

  it('多密钥同时落盘均非明文', async () => {
    await saveSettings({
      hfToken: 'hf_a1b2c3',
      search: { tavilyApiKey: 'tvly-aaa', exaApiKey: 'exa_bbb', braveApiKey: 'BSA_ccc' },
    })
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    expect(raw).not.toContain('hf_a1b2c3')
    expect(raw).not.toContain('tvly-aaa')
    expect(raw).not.toContain('exa_bbb')
    expect(raw).not.toContain('BSA_ccc')
    const loaded = await getSettings()
    expect(loaded.search.exaApiKey).toBe('exa_bbb')
    expect(loaded.search.braveApiKey).toBe('BSA_ccc')
  })
})

describe('settings — 校验', () => {
  it('端口校验 1024-65535 且检测冲突', async () => {
    expect(validatePort(80)).toBeTruthy()
    expect(validatePort(11434)).toBeNull()
    expect(validatePort(70000)).toBeTruthy()
    const errs = validatePorts({ openaiPort: 11434, llamaPort: 11434, ollamaPort: 11435 })
    expect(errs['_conflict']).toBeTruthy()
    expect(validatePorts({ openaiPort: 11434, llamaPort: 11435, ollamaPort: 11436 })['_conflict']).toBeUndefined()
  })

  it('HF Token 校验', async () => {
    expect(validateHfToken('')).toBeNull()
    expect(validateHfToken('ab')).toBeTruthy()
    expect(validateHfToken('hf_valid_token_12345')).toBeNull()
    expect(validateHfToken('bad token')).toBeTruthy()
  })

  it('生图后端校验 — host 仅 127.0.0.1', async () => {
    expect(validateImageBackend({ host: '0.0.0.0' })['host']).toBeTruthy()
    expect(validateImageBackend({ host: '127.0.0.1' })['host']).toBeUndefined()
    expect(validateImageBackend({ port: 80 })['port']).toBeTruthy()
  })

  it('搜索校验', async () => {
    expect(validateSearchSettings({ provider: 'tavily' as never })['provider']).toBeUndefined()
    expect(validateSearchSettings({ searxngUrl: 'http://127.0.0.1:8080' })['searxngUrl']).toBeUndefined()
    expect(validateSearchSettings({ searxngUrl: 'http://0.0.0.0:8080' })['searxngUrl']).toBeTruthy()
  })
})

describe('settings — 端口/更新/生图统一管理', () => {
  it('saveSettings 合并语义 — 端口与更新开关', async () => {
    expect((await getSettings()).ports.openaiPort).toBe(DEFAULT_SETTINGS.ports.openaiPort)
    await saveSettings({ ports: { openaiPort: 15555 } })
    expect((await getSettings()).ports.openaiPort).toBe(15555)
    expect((await getSettings()).ports.llamaPort).toBe(DEFAULT_SETTINGS.ports.llamaPort)
    await saveSettings({ update: { autoUpdateEnabled: false } })
    expect((await getSettings()).update.autoUpdateEnabled).toBe(false)
    await saveSettings({ update: { autoUpdateEnabled: true } })
    expect((await getSettings()).update.autoUpdateEnabled).toBe(true)
  })

  it('生图后端保存', async () => {
    await saveSettings({ image: { backend: 'sd.cpp', port: 11436, model: 'flux' } })
    const s = await getSettings()
    expect(s.image.backend).toBe('sd.cpp')
    expect(s.image.port).toBe(11436)
    expect(s.image.model).toBe('flux')
  })

  it('搜索 provider 保存', async () => {
    await saveSettings({ search: { provider: 'tavily' } })
    expect((await getSettings()).search.provider).toBe('tavily')
  })
})

describe('settings — 轮转', () => {
  it('rotateSecrets 重加密计数正确且仍可解密', async () => {
    await saveSettings({ hfToken: 'hf_rotate_me', search: { tavilyApiKey: 'tvly-rotate', exaApiKey: '' } })
    const before = readFileSync(getSettingsPath(), 'utf-8')
    const r = await rotateSecrets()
    expect(r.rotated).toBe(2)
    const after = readFileSync(getSettingsPath(), 'utf-8')
    // 重加密后文件仍不含明文
    expect(after).not.toContain('hf_rotate_me')
    expect(after).not.toContain('tvly-rotate')
    // 但读回仍正确
    expect((await getSettings()).hfToken).toBe('hf_rotate_me')
    // encVersion 存在
    const parsed = JSON.parse(after)
    expect(parsed.meta.encVersion).toBe(1)
    void before
  })

  it('clearSecret 清空单条密钥', async () => {
    await saveSettings({ hfToken: 'hf_to_clear' })
    expect((await getSettings()).hfToken).toBe('hf_to_clear')
    await clearSecret('hfToken')
    expect((await getSettings()).hfToken).toBe('')
    await saveSettings({ search: { tavilyApiKey: 'tvly-to-clear' } })
    await clearSecret('tavilyApiKey')
    expect((await getSettings()).search.tavilyApiKey).toBe('')
  })
})
