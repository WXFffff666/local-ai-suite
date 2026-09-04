/**
 * jumplist.ts — todo42 Windows Jump List（app.setJumpList custom 任务）。
 * 条目 = JumpListLink 形状（Electron 里 link 项无 type 字段 —— type 仅
 * separator/task/file 携带），arguments 携带裸 las:// URL。
 *
 * 条目经 las:// 深链回灌自身 exe（第二实例 argv → extractDeepLinkFromArgv →
 * 'app:deeplink' 事件 → 渲染层导航），与协议注册共用同一条解析通路 — 无旁门。
 * 纯数据构建器：exePath 注入，单测断言形状/arguments，无需 Electron。
 * 参数名与 JumpListLinkItem 字段同名（exePath），对象字面量走 shorthand。
 */

import { DEEP_LINK_SCHEME } from './deeplink'

/** 与 electron-builder.yml appId 一致（AUMID 不匹配则 JumpList 不显示）。 */
export const APP_USER_MODEL_ID = 'com.localaisuite.app'

export type JumpListLinkItem = {
  title: string
  description: string
  exePath: string
  arguments: string
}

export function buildJumpListEntries(exePath: string): readonly JumpListLinkItem[] {
  return [
    {
      title: '新建会话',
      description: '打开 Local AI Suite 并新建一个会话',
      exePath,
      arguments: `${DEEP_LINK_SCHEME}://new-chat`,
    },
    {
      title: '模型页',
      description: '打开 Local AI Suite 模型管理页',
      exePath,
      arguments: `${DEEP_LINK_SCHEME}://models`,
    },
  ]
}
