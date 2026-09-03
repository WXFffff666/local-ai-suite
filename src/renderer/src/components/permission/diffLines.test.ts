/**
 * todo25 — diffLines pure util unit tests. LCS line diff with a 300-line
 * guard (oversized inputs fall back to a raw render, never an O(n*m) blowup)
 * and honest EOF-newline modelling: the "missing trailing newline" shows up
 * as its own +/- empty line, mirroring `git diff`'s behaviour.
 */
import { describe, expect, it } from 'vitest'
import { MAX_DIFF_LINES, diffLines, type DiffLine } from './diffLines'

function types(lines: readonly DiffLine[]): string {
  return lines.map((l) => `${l.type}:${l.text}`).join('|')
}

describe('diffLines', () => {
  it('1. identical text -> all context lines, no adds/dels', () => {
    const r = diffLines('a\nb\nc', 'a\nb\nc')
    expect(r.tooLarge).toBe(false)
    expect(r.tooLarge ? '' : types(r.lines)).toBe('ctx:a|ctx:b|ctx:c')
  })

  it('2. pure addition in the middle keeps surrounding context', () => {
    const r = diffLines('a\nc', 'a\nb\nc')
    expect(r.tooLarge ? '' : types(r.lines)).toBe('ctx:a|add:b|ctx:c')
  })

  it('3. pure deletion in the middle', () => {
    const r = diffLines('a\nb\nc', 'a\nc')
    expect(r.tooLarge ? '' : types(r.lines)).toBe('ctx:a|del:b|ctx:c')
  })

  it('4. substitution renders as del+add pair', () => {
    const r = diffLines('a\nb\nc', 'a\nx\nc')
    expect(r.tooLarge ? '' : types(r.lines)).toBe('ctx:a|del:b|add:x|ctx:c')
  })

  it('5. empty old text -> every line is an add (no phantom empty row)', () => {
    const r = diffLines('', 'a\nb')
    expect(r.tooLarge ? '' : types(r.lines)).toBe('add:a|add:b')
  })

  it('6. EOF newline change surfaces as its own line ("a\\n" vs "a")', () => {
    const withNl = diffLines('a\n', 'a')
    expect(withNl.tooLarge ? '' : types(withNl.lines)).toBe('ctx:a|del:')
    const noNl = diffLines('a', 'a\n')
    expect(noNl.tooLarge ? '' : types(noNl.lines)).toBe('ctx:a|add:')
  })

  it('7. CJK lines diff per line, characters intact', () => {
    const r = diffLines('你好\n世界', '你好\n朋友们')
    expect(r.tooLarge ? '' : types(r.lines)).toBe('ctx:你好|del:世界|add:朋友们')
  })

  it('8. oversized side -> tooLarge flag with raw text passthrough (no LCS run)', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join('\n')
    const r = diffLines(big, 'small')
    expect(r.tooLarge).toBe(true)
    if (r.tooLarge) {
      expect(r.oldText).toBe(big)
      expect(r.newText).toBe('small')
    }
  })

  it('9. boundary: exactly MAX_DIFF_LINES on both sides still diffs (guard is strictly >)', () => {
    const at = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`).join('\n')
    const changed = at.split('\n')
    changed[changed.length - 1] = 'last-line-edited'
    const r = diffLines(at, changed.join('\n'))
    expect(r.tooLarge).toBe(false)
    if (!r.tooLarge) {
      expect(r.lines.filter((l) => l.type === 'add')).toEqual([{ type: 'add', text: 'last-line-edited' }])
      expect(r.lines.filter((l) => l.type === 'del')).toEqual([{ type: 'del', text: `l${MAX_DIFF_LINES - 1}` }])
    }
  })

  it('10. multi-hunk file preserves order of all rows', () => {
    const r = diffLines('1\n2\n3\n4\n5\n6', '1\nX\n3\n4\nY\n6')
    expect(r.tooLarge ? '' : types(r.lines)).toBe('ctx:1|del:2|add:X|ctx:3|ctx:4|del:5|add:Y|ctx:6')
  })
})
