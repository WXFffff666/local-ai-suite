/**
 * integration.ts — todo42 开机自启 / 协议注册的可注入薄封装。
 *
 * electron app 只经 structural interface 进来（handlers/index 注入真身，
 * 单测注入 mock — engines/dialog 同一约定）。构建逻辑是纯函数：
 *  - buildLoginItemSettings: 自启开 → openAtLogin + '--hidden'（静默进托盘，
 *    index.ts createWindow 消费该 flag；关 → 清 args）。
 *  - applyProtocolRegistration: 开 → setAsDefaultProtocolClient('las')，
 *    关 → removeAsDefaultProtocolClient；返回值 = OS 采纳后的诚实状态。
 */

import { DEEP_LINK_SCHEME } from './deeplink'

/** 自启静默启动参数（--hidden = 建窗但不 show，托盘可唤出）。 */
export const AUTOSTART_HIDDEN_FLAG = '--hidden'

export type LoginItemAppLike = {
  setLoginItemSettings(options: { openAtLogin: boolean; args?: string[] }): void
}

export type ProtocolAppLike = {
  setAsDefaultProtocolClient(protocol: string): boolean
  removeAsDefaultProtocolClient(protocol: string): boolean
  isDefaultProtocolClient(protocol: string): boolean
}

/** IPC 面（handlers.ts deps.integration）：index.ts 以 app.isPackaged 门实现。 */
export type IntegrationSurface = {
  applyAutostart(enabled: boolean): void
  applyProtocolRegistration(enabled: boolean): void
  isProtocolRegistered(): boolean
}

export function buildLoginItemSettings(enabled: boolean): { openAtLogin: boolean; args: string[] } {
  return enabled ? { openAtLogin: true, args: [AUTOSTART_HIDDEN_FLAG] } : { openAtLogin: false, args: [] }
}

export function applyAutostart(app: LoginItemAppLike, enabled: boolean): void {
  app.setLoginItemSettings(buildLoginItemSettings(enabled))
}

/** 注册/注销 las:// 协议；返回 isDefaultProtocolClient 的最终诚实状态。 */
export function applyProtocolRegistration(app: ProtocolAppLike, enabled: boolean): boolean {
  if (enabled) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  } else {
    app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME)
  }
  return app.isDefaultProtocolClient(DEEP_LINK_SCHEME)
}
