import { describe, it, expect } from 'vitest'
import {
  CSP_POLICY,
  cspHeaders,
  WEB_SECURITY,
  BROWSER_WINDOW_SECURITY_OPTS,
  ALLOWED_DROP_EXTENSIONS,
  isAllowedDropFile,
  filterAllowedDropFiles,
  ALLOWED_EXTERNAL_PROTOCOLS,
  isAllowedExternalUrl,
  shouldOpenExternal,
  CONTEXT_BRIDGE_WHITELIST,
  isAllowedBridgeKey,
  assertAllowedBridgeKey,
  SAFE_STORAGE_ROTATION_DOC,
  ROTATABLE_SECRET_KEYS,
  isEncryptedSecret,
} from './csp'

describe('csp — CSP 启用 default-src self', () => {
  it('CSP_POLICY 包含 default-src self', () => {
    expect(CSP_POLICY).toContain("default-src 'self'")
    expect(CSP_POLICY).toContain("script-src 'self'")
    expect(CSP_POLICY).toContain("object-src 'none'")
    expect(CSP_POLICY).toContain("frame-ancestors 'none'")
  })

  it('cspHeaders 含 Content-Security-Policy 且值为 CSP_POLICY', () => {
    expect(cspHeaders['Content-Security-Policy']).toBe(CSP_POLICY)
    expect(cspHeaders['X-Content-Type-Options']).toBe('nosniff')
    expect(cspHeaders['X-Frame-Options']).toBe('DENY')
  })

  it('webSecurity:true', () => {
    expect(WEB_SECURITY).toBe(true)
    expect(BROWSER_WINDOW_SECURITY_OPTS.webSecurity).toBe(true)
    expect(BROWSER_WINDOW_SECURITY_OPTS.sandbox).toBe(true)
    expect(BROWSER_WINDOW_SECURITY_OPTS.contextIsolation).toBe(true)
    expect(BROWSER_WINDOW_SECURITY_OPTS.nodeIntegration).toBe(false)
  })
})

describe('isAllowedDropFile — 仅允许 GGUF/safetensors/ckpt', () => {
  it('允许的后缀（大小写不敏感）', () => {
    expect(isAllowedDropFile('model.gguf')).toBe(true)
    expect(isAllowedDropFile('MODEL.GGUF')).toBe(true)
    expect(isAllowedDropFile('C:\\models\\qwen.gguf')).toBe(true)
    expect(isAllowedDropFile('/tmp/foo.safetensors')).toBe(true)
    expect(isAllowedDropFile('foo.SAFETENSORS')).toBe(true)
    expect(isAllowedDropFile('checkpoint.ckpt')).toBe(true)
    expect(isAllowedDropFile('a/b/c/model.ckpt')).toBe(true)
  })

  it('拒绝 exe 及其他非法后缀', () => {
    const blocked = [
      'evil.exe',
      'malware.dll',
      'script.js',
      'run.bat',
      'run.sh',
      'model.bin',
      'model.onnx',
      'model.pth',
      'model.pt',
      'archive.zip',
      'doc.pdf',
      'model.gguf.exe', // 双重后缀，最后为 exe
      'model.safetensors.bak',
      '',
      '   ',
      'noext',
      '.gguf', // 隐藏文件风格，无文件名
      'C:\\path\\to\\evil.EXE',
    ]
    for (const f of blocked) {
      expect(isAllowedDropFile(f), `should block ${f}`).toBe(false)
    }
  })

  it('filterAllowedDropFiles 批量过滤', () => {
    const input = ['a.gguf', 'b.exe', 'c.safetensors', 'd.ckpt', 'e.js']
    expect(filterAllowedDropFiles(input)).toEqual(['a.gguf', 'c.safetensors', 'd.ckpt'])
  })

  it('ALLOWED_DROP_EXTENSIONS 仅含三项且不含 exe', () => {
    expect(ALLOWED_DROP_EXTENSIONS).toEqual(['.gguf', '.safetensors', '.ckpt'])
    expect(ALLOWED_DROP_EXTENSIONS).not.toContain('.exe')
  })
})

describe('外链 shell.openExternal 白名单', () => {
  it('仅允许 https/http', () => {
    expect(isAllowedExternalUrl('https://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://example.com')).toBe(true)
    expect(isAllowedExternalUrl('http://127.0.0.1:3000')).toBe(true)
  })

  it('拒绝 file/javascript/data/ftp 等', () => {
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedExternalUrl('data:text/html,<h1>hi</h1>')).toBe(false)
    expect(isAllowedExternalUrl('ftp://example.com')).toBe(false)
    expect(isAllowedExternalUrl('')).toBe(false)
    expect(isAllowedExternalUrl('not a url')).toBe(false)
  })

  it('shouldOpenExternal 与 isAllowedExternalUrl 一致', () => {
    expect(shouldOpenExternal('https://huggingface.co')).toBe(true)
    expect(shouldOpenExternal('file:///tmp/x')).toBe(false)
  })

  it('ALLOWED_EXTERNAL_PROTOCOLS 仅 http/https', () => {
    expect(ALLOWED_EXTERNAL_PROTOCOLS).toEqual(['https:', 'http:'])
  })
})

describe('contextBridge 白名单', () => {
  it('仅允许 api', () => {
    expect(CONTEXT_BRIDGE_WHITELIST).toEqual(['api'])
    expect(isAllowedBridgeKey('api')).toBe(true)
    expect(isAllowedBridgeKey('ipcRenderer')).toBe(false)
    expect(isAllowedBridgeKey('shell')).toBe(false)
    expect(isAllowedBridgeKey('fs')).toBe(false)
  })

  it('assertAllowedBridgeKey 非白名单抛错', () => {
    expect(() => assertAllowedBridgeKey('api')).not.toThrow()
    expect(() => assertAllowedBridgeKey('evil')).toThrow(/not allowed/)
  })
})

describe('safeStorage 轮转文档化', () => {
  it('SAFE_STORAGE_ROTATION_DOC 指向 docs/SECURITY.md', () => {
    expect(SAFE_STORAGE_ROTATION_DOC).toContain('SECURITY.md')
  })

  it('ROTATABLE_SECRET_KEYS 含密钥字段', () => {
    expect(ROTATABLE_SECRET_KEYS).toContain('hfToken')
    expect(ROTATABLE_SECRET_KEYS).toContain('tavilyApiKey')
  })

  it('isEncryptedSecret 识别 enc:v1: 前缀', () => {
    expect(isEncryptedSecret('enc:v1:abc')).toBe(true)
    expect(isEncryptedSecret('enc:fallback:v1:abc')).toBe(true)
    expect(isEncryptedSecret('hf_xxx')).toBe(false)
    expect(isEncryptedSecret('')).toBe(false)
  })
})
