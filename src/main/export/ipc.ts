/**
 * ipc.ts — todo42 'chat:exportHtml' 主进程侧。
 *
 * 职责严格三件事（HTML 组装在渲染层完成 — 见 renderer/components/export）：
 *  1. zod 门（html ≤16M chars / filename ≤1024）；
 *  2. 破坏性文件名净化（sanitizeExportFilename — 非法字符/控制符/封顶/回退）；
 *  3. 用户同意门：dialog.showSaveDialog（默认落 downloads），取消 = 良性
 *     'cancelled'；确认后才 writeFileSync UTF-8。
 * 全部依赖注入（dialog / getDownloadsDir / writeFile）— 单测零真实文件对话框
 * （learnings.md vitest 约定，speech pickModel 同型）。
 */

import { join } from 'path'
import type { ChatExportHtmlReply } from '../ipc/whitelist'
import type { IpcHandler } from '../ipc/handlers'
import { chatExportHtmlSchema, validatePayload } from '../ipc/schemas'
import { sanitizeExportFilename } from './filename'

export const EXPORT_HTML_FILTER_NAME = 'HTML 文档'

export type SaveDialogLike = {
  showSaveDialog(options: {
    title?: string
    defaultPath?: string
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<{ canceled: boolean; filePath?: string }>
}

export type WriteFileFn = (path: string, data: string) => void

export type ExportIpcDeps = {
  dialog: SaveDialogLike
  getDownloadsDir: () => string
  writeFile: WriteFileFn
}

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

export function createExportHandlers(deps: ExportIpcDeps): { 'chat:exportHtml': IpcHandler } {
  const chatExportHtml: IpcHandler = async (args) => {
    const parsed = validatePayload(chatExportHtmlSchema, first(args))
    if (!parsed.ok) return parsed
    const safeName = sanitizeExportFilename(parsed.data.filename)
    const defaultPath = join(deps.getDownloadsDir(), `${safeName}.html`)
    const ret = await deps.dialog.showSaveDialog({
      title: '导出会话为 HTML',
      defaultPath,
      filters: [{ name: EXPORT_HTML_FILTER_NAME, extensions: ['html'] }],
    })
    if (ret.canceled || typeof ret.filePath !== 'string' || ret.filePath.length === 0) {
      const reply: ChatExportHtmlReply = { ok: false, error: 'cancelled' }
      return reply
    }
    try {
      deps.writeFile(ret.filePath, parsed.data.html)
    } catch (error) {
      const reply: ChatExportHtmlReply = {
        ok: false,
        error: 'write-failed',
        detail: error instanceof Error ? error.message : String(error),
      }
      return reply
    }
    const reply: ChatExportHtmlReply = { ok: true, path: ret.filePath }
    return reply
  }
  return { 'chat:exportHtml': chatExportHtml }
}
