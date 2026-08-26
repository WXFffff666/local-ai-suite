/**
 * CSP / Electron 安全基线 — Wave7 T32
 *
 * 覆盖：
 * - CSP 启用 (default-src 'self')
 * - webSecurity: true
 * - 拖入仅允许 GGUF / safetensors / ckpt
 * - 外链 shell.openExternal
 * - contextBridge 白名单
 * - safeStorage 轮转文档化
 */

/** CSP 策略字符串 — default-src 'self' 为核心，其他指令收紧 */
export const CSP_POLICY =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; media-src 'self' blob:; worker-src 'self' blob:" as const

/**
 * 供 Electron session.webRequest.onHeadersReceived 使用的响应头
 * 在主进程中： session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, ...cspHeaders } }))
 */
export const cspHeaders: Record<string, string> = {
  'Content-Security-Policy': CSP_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

/** BrowserWindow webPreferences 安全基线 — webSecurity 必须为 true */
export const WEB_SECURITY = true as const

export const BROWSER_WINDOW_SECURITY_OPTS = {
  webSecurity: true,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  allowRunningInsecureContent: false,
} as const

// ── 拖入白名单 ──────────────────────────────────────────────

/** 仅允许的模型文件后缀（小写，含点） */
export const ALLOWED_DROP_EXTENSIONS = ['.gguf', '.safetensors', '.ckpt'] as const
export type AllowedDropExtension = (typeof ALLOWED_DROP_EXTENSIONS)[number]

const ALLOWED_DROP_SET: ReadonlySet<string> = new Set<string>(ALLOWED_DROP_EXTENSIONS)

/**
 * 判断拖入文件是否允许
 * - 仅允许 .gguf / .safetensors / .ckpt（大小写不敏感）
 * - 拒绝一切其他后缀，含 .exe / .dll / .js / .bat / .sh / .bin / .onnx 等
 * - 双重后缀如 model.gguf.exe 视为 .exe，拒绝
 * - 空字符串 / 无后缀 / 仅目录 直接拒绝
 *
 * @example isAllowedDropFile('C:\\models\\qwen.gguf') // true
 * @example isAllowedDropFile('model.safetensors') // true
 * @example isAllowedDropFile('evil.exe') // false
 */
export function isAllowedDropFile(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false
  const trimmed = filePath.trim()
  if (!trimmed) return false
  // 取最后一个点后的后缀
  const lower = trimmed.toLowerCase()
  // 处理 Windows 路径，取文件名部分后再取后缀，避免目录中的点干扰
  const slashIdx = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  const fileName = slashIdx >= 0 ? lower.slice(slashIdx + 1) : lower
  const dotIdx = fileName.lastIndexOf('.')
  if (dotIdx <= 0) return false // 无后缀或隐藏文件如 .gguf
  // 对于 .safetensors 需完整匹配；直接取后缀段
  const ext = fileName.slice(dotIdx)
  // 特殊： .safetensors 已含点，直接匹配集合
  if (ALLOWED_DROP_SET.has(ext)) return true
  return false
}

/**
 * 批量过滤拖入文件列表，返回仅允许的文件
 */
export function filterAllowedDropFiles(filePaths: string[]): string[] {
  return filePaths.filter(isAllowedDropFile)
}

// ── 外链 ────────────────────────────────────────────────────

/** 允许通过 shell.openExternal 打开的协议 */
export const ALLOWED_EXTERNAL_PROTOCOLS = ['https:', 'http:'] as const

/**
 * 判断 URL 是否允许外链打开
 * - 仅允许 https: / http:
 * - 拒绝 file: / javascript: / data: / ftp: 等
 */
export function isAllowedExternalUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url.trim())
    return (ALLOWED_EXTERNAL_PROTOCOLS as readonly string[]).includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * 外链打开守卫 — 在主进程中使用：
 * ```
 * import { shell } from 'electron'
 * import { isAllowedExternalUrl } from '../security/csp'
 * window.webContents.setWindowOpenHandler(({ url }) => {
 *   if (isAllowedExternalUrl(url)) void shell.openExternal(url)
 *   return { action: 'deny' }
 * })
 * webContents.on('will-navigate', (e, url) => {
 *   if (!isAllowedExternalUrl(url) && !url.startsWith('file://')) e.preventDefault()
 *   else if (isAllowedExternalUrl(url)) { e.preventDefault(); void shell.openExternal(url) }
 * })
 * ```
 * 渲染进程禁止直接使用 window.open / <a target="_blank"> 跳转外链。
 */
export function shouldOpenExternal(url: string): boolean {
  return isAllowedExternalUrl(url)
}

// ── contextBridge 白名单 ───────────────────────────────────

/**
 * contextBridge 允许暴露的白名单
 * - 仅允许 'api' 单一键（见 src/preload/index.ts 的 contextBridge.exposeInMainWorld('api', api)）
 * - 禁止直接暴露 ipcRenderer / shell / fs 等原生模块
 */
export const CONTEXT_BRIDGE_WHITELIST = ['api'] as const
export type ContextBridgeWhitelistKey = (typeof CONTEXT_BRIDGE_WHITELIST)[number]

const CONTEXT_BRIDGE_SET: ReadonlySet<string> = new Set<string>(CONTEXT_BRIDGE_WHITELIST)

export function isAllowedBridgeKey(key: string): boolean {
  return CONTEXT_BRIDGE_SET.has(key)
}

/**
 * 断言 key 在白名单内，否则抛错
 */
export function assertAllowedBridgeKey(key: string): asserts key is ContextBridgeWhitelistKey {
  if (!isAllowedBridgeKey(key)) {
    throw new Error(`contextBridge key not allowed: ${key}`)
  }
}

// ── safeStorage 轮转文档化 ─────────────────────────────────

/**
 * safeStorage 轮转（Rotation）说明
 *
 * 存储形态（见 docs/SECURITY.md 与 src/main/storage）：
 * - 加密：safeStorage.encryptString(plain) -> Buffer -> `enc:v1:<base64>` 落盘
 * - 解密：Buffer.from(b64,'base64') -> safeStorage.decryptString(buf)
 * - 不可用时（CI/无钥匙串 Linux）：降级为 `enc:fallback:v1:<base64>`，启动警告
 * - 展示层一律 maskSecret() 脱敏，日志/IPC 禁止明文
 *
 * 何时轮转（90 天或事件触发）：
 * - 提供商侧提示密钥泄露/过期
 * - 成员变动、设备更换、系统重装/钥匙串迁移
 * - 扫描命中 settings.json 历史明文
 *
 * 轮转步骤：
 * 1) 在提供商处重新生成密钥（HF/Tavily/Exa/Brave 各自 Dashboard）
 * 2) 应用内「设置」页粘贴新密钥 -> saveSettings() 自动 encryptSecret() 重加密落盘
 * 3) 或一键重加密：rotateSecrets() 用当前 OS 钥匙串重封全部密钥（适用于 DPAPI/Keychain 变更）
 * 4) 验证：grep settings.json 确认 enc:v1: 且无明文；重启后脱敏显示正常
 * 5) 在提供商侧吊销旧密钥，确认旧 token 401
 * 6) 审计：meta.updatedAt 记录轮转时间
 *
 * 应急泄露：
 * 1) 立即吊销旧密钥 2) clearSecret(key) 清空落盘 3) 写入新密钥 4) git filter-repo 清理历史
 *
 * @see docs/SECURITY.md#rotation
 */
export const SAFE_STORAGE_ROTATION_DOC = 'see docs/SECURITY.md#rotation' as const

/**
 * 轮转所需的密钥字段白名单（与 settings 加密字段保持一致）
 */
export const ROTATABLE_SECRET_KEYS = ['hfToken', 'tavilyApiKey', 'exaApiKey', 'braveApiKey'] as const
export type RotatableSecretKey = (typeof ROTATABLE_SECRET_KEYS)[number]

/**
 * 判断是否为已加密形态（enc:v1: 或 enc:fallback:v1:）
 */
export function isEncryptedSecret(value: string): boolean {
  return typeof value === 'string' && (value.startsWith('enc:v1:') || value.startsWith('enc:fallback:v1:'))
}
