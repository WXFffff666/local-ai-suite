/**
 * secrets:encrypt / secrets:decrypt — moved verbatim from src/main/index.ts
 * (plan W1-8 handler extraction; behaviour unchanged). 密钥加解密必须在主进程
 * 完成：safeStorage 在 sandbox 渲染层不可达（P1 修复）。
 */

export type SafeStorageLike = {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(buf: Buffer): string
}

export function createSecretsHandlers(safeStorage: SafeStorageLike) {
  return {
    'secrets:encrypt': async (args: unknown[]): Promise<unknown> => {
      const plain = typeof args[0] === 'string' ? args[0] : ''
      if (!plain) return { ok: true, value: '' }
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return { ok: true, value: `enc:v1:${safeStorage.encryptString(plain).toString('base64')}` }
        }
        console.warn('[secrets] OS secure storage unavailable — falling back to REVERSIBLE encoding. Configure a system keyring to avoid this.')
        return {
          ok: true,
          warning: 'os-storage-unavailable',
          value: `enc:fallback:v1:${Buffer.from(plain, 'utf-8').toString('base64')}`
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
    'secrets:decrypt': async (args: unknown[]): Promise<unknown> => {
      const payload = typeof args[0] === 'string' ? args[0] : ''
      if (!payload) return { ok: true, value: '' }
      try {
        if (payload.startsWith('enc:v1:')) {
          if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'encrypted with safeStorage but OS storage unavailable' }
          return { ok: true, value: safeStorage.decryptString(Buffer.from(payload.slice('enc:v1:'.length), 'base64')) }
        }
        if (payload.startsWith('enc:fallback:v1:')) {
          return { ok: true, warning: 'fallback-payload', value: Buffer.from(payload.slice('enc:fallback:v1:'.length), 'base64').toString('utf-8') }
        }
        // 历史明文：原样返回（与渲染层旧逻辑一致）
        return { ok: true, value: payload }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  }
}
