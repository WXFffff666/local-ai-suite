/**
 * filename.test.ts — todo42 导出文件名净化单测（destructive 边界）。
 */
import { describe, expect, it } from 'vitest'
import { FALLBACK_FILENAME, MAX_FILENAME_CHARS, sanitizeExportFilename } from './filename'

describe('sanitizeExportFilename (todo42)', () => {
  it('中文 + 非法字符混排：非法符换空格，中文原样保留', () => {
    expect(sanitizeExportFilename('项目:<>|"\\/?*说明')).toBe('项目 说明')
    expect(sanitizeExportFilename('会话 <A> | B? *')).toBe('会话 A B')
    expect(sanitizeExportFilename('a/b\\c:d')).toBe('a b c d')
  })

  it('控制字符直接删除（含 NUL/换行/DEL）', () => {
    expect(sanitizeExportFilename('ab\u0000cd\u0007\u001fe\u007ff')).toBe('abcdef')
    expect(sanitizeExportFilename('行1\n行2')).toBe('行1 行2')
  })

  it('封顶 120 码点且封顶后再剪尾点/空格；代理对按码点计', () => {
    const long = 'x'.repeat(200)
    expect(sanitizeExportFilename(long)).toHaveLength(MAX_FILENAME_CHARS)
    const cjk = '汉'.repeat(200)
    expect(Array.from(sanitizeExportFilename(cjk))).toHaveLength(MAX_FILENAME_CHARS)
    // emoji 代理对不能被腰斩（UTF-16 length 130 > 120 code units but 120 code points OK）
    const emoji = '😀'.repeat(150)
    const out = sanitizeExportFilename(emoji)
    expect(Array.from(out)).toHaveLength(MAX_FILENAME_CHARS)
    expect(out).toBe('😀'.repeat(MAX_FILENAME_CHARS))
  })

  it('结尾点/空格剪除；Windows 设备保留名加尾缀下划线', () => {
    expect(sanitizeExportFilename('报告...')).toBe('报告')
    expect(sanitizeExportFilename('名字  ')).toBe('名字')
    expect(sanitizeExportFilename('CON')).toBe('CON_')
    expect(sanitizeExportFilename('CON .')).toBe('CON_')
    expect(sanitizeExportFilename('com9')).toBe('com9_')
  })

  it('全非法/全空回退 "chat"', () => {
    expect(sanitizeExportFilename('')).toBe(FALLBACK_FILENAME)
    expect(sanitizeExportFilename('::??**')).toBe(FALLBACK_FILENAME)
    expect(sanitizeExportFilename('...')).toBe(FALLBACK_FILENAME)
  })
})
