/**
 * filename.ts — todo42 导出文件名净化（destructive 边界：写盘前的最后一道闸）。
 *
 * Windows 保留集：< > : " / \ | ? * + 控制字符 \u0000-\u001F\u007F +
 * 设备保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）+ 结尾点/空格非法。
 * 中文与常规可打印字符原样保留；净化后封顶 120 码点（Array.from 保代理对），
 * 空结果回退 'chat'。纯函数 — 单测覆盖混排/封顶/控制字符/保留名。
 */

export const MAX_FILENAME_CHARS = 120
export const FALLBACK_FILENAME = 'chat'

/** 控制字符（\t\n\r 除外 — 它们随空白折叠为单空格；含 DEL）— 直接删除。 */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g
/** Windows 文件名非法字符 — 替换为空格（保留词边界，中文不受影响）。 */
const FORBIDDEN_RE = /[<>:"/\\|?*]/g
/** 设备保留名（不含扩展名比较）。 */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function sanitizeExportFilename(raw: string): string {
  let s = raw.replace(CONTROL_RE, '').replace(FORBIDDEN_RE, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  // 结尾点/空格在 Windows 上非法（与 FORBIDDEN 替换后的尾随空白一并剪除）
  s = s.replace(/[. ]+$/g, '')
  if (RESERVED_RE.test(s)) s = `${s}_`
  const chars = Array.from(s)
  if (chars.length > MAX_FILENAME_CHARS) {
    s = chars.slice(0, MAX_FILENAME_CHARS).join('').replace(/[. ]+$/g, '')
  }
  return s.length === 0 ? FALLBACK_FILENAME : s
}
