/**
 * deeplink.ts — todo42 las:// 深链解析（纯函数，index.ts 双入口共用：
 * 首实例启动 argv + second-instance argv）。
 *
 * 语法：las://<action>[/...]（path/query 一律忽略 — action 是唯一载荷）。
 * 合法 action 封闭在 whitelist 的 DEEP_LINK_ACTIONS 联合里：未知 action、
 * 非 las: scheme、语法垃圾、坏百分号编码一律 null（调用方忽略 + 不广播）。
 * hostname 经 percent-decode 后再比对（las://%6e%65%77-... 等价 las://new-chat），
 * decode 抛错视为垃圾。
 */

import { DEEP_LINK_ACTIONS, type DeepLinkAction } from '../ipc/whitelist'

export const DEEP_LINK_SCHEME = 'las'

/** 从 argv 中取第一个 las:// URL（Windows 跳列表/协议处理器都以裸参数传入）。 */
export function extractDeepLinkFromArgv(argv: readonly string[]): DeepLinkAction | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) {
      const action = parseDeepLink(arg)
      if (action !== null) return action
    }
  }
  return null
}

/** 解析单条 las:// URL；任何违规（含非法编码）→ null，绝不抛。 */
export function parseDeepLink(raw: string): DeepLinkAction | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null
  const host = url.hostname.toLowerCase()
  let decoded: string
  try {
    decoded = decodeURIComponent(host)
  } catch {
    return null
  }
  return (DEEP_LINK_ACTIONS as readonly string[]).includes(decoded) ? (decoded as DeepLinkAction) : null
}
