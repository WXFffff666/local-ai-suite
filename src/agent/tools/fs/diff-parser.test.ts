/**
 * diff-parser.test.ts — aider SEARCH/REPLACE grammar (Appendix A row 23-28:
 * "aider SEARCH/REPLACE 语法", cline/Roo semantic reference). Pinned
 * behaviors: exact-whitespace match, unique-or-ambiguous with the match
 * count, `:all` replace-all marker, sequential multi-block application.
 */
import { describe, expect, it } from 'vitest'

import { applySearchReplace, parseSearchReplaceBlocks } from './diff-parser'

const B = 'line1\nline2\nline3\n'

describe('parseSearchReplaceBlocks', () => {
  it('parses one block with exact whitespace', () => {
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\nline1\n=======\nfirst\n>>>>>>> REPLACE\n')
    expect(blocks).toEqual([{ search: 'line1\n', replace: 'first\n', replaceAll: false }])
  })

  it('supports multiple blocks and preserves trailing indentation inside blocks', () => {
    const diff =
      '<<<<<<< SEARCH\n  indented\n=======\n  fixed\n>>>>>>> REPLACE\n' +
      '<<<<<<< SEARCH\ntail\n=======\nend\n>>>>>>> REPLACE'
    const blocks = parseSearchReplaceBlocks(diff)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ search: '  indented\n', replace: '  fixed\n', replaceAll: false })
    expect(blocks[1]).toEqual({ search: 'tail\n', replace: 'end\n', replaceAll: false })
  })

  it('recognizes the :all replace-all marker variant', () => {
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE :all\n')
    expect(blocks[0]?.replaceAll).toBe(true)
  })

  it('empty SEARCH block (new-file form) parses to an empty search string', () => {
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\n=======\nhello\n>>>>>>> REPLACE\n')
    expect(blocks).toEqual([{ search: '', replace: 'hello\n', replaceAll: false }])
  })

  it('rejects malformed blocks: missing separator, missing end marker, junk outside blocks', () => {
    expect(() => parseSearchReplaceBlocks('<<<<<<< SEARCH\na\n>>>>>>> REPLACE')).toThrow(/=======/)
    expect(() => parseSearchReplaceBlocks('<<<<<<< SEARCH\na\n=======\nb')).toThrow(/REPLACE/)
    expect(() => parseSearchReplaceBlocks('just some text')).toThrow(/SEARCH/)
    expect(() => parseSearchReplaceBlocks('')).toThrow(/no SEARCH/)
  })
})

describe('applySearchReplace', () => {
  it('applies a unique match', () => {
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\nline2\n=======\nLINE TWO\n>>>>>>> REPLACE\n')
    expect(applySearchReplace(B, blocks)).toBe('line1\nLINE TWO\nline3\n')
  })

  it('rejects a non-matching search block naming its index', () => {
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE\n')
    expect(() => applySearchReplace(B, blocks)).toThrow(/block 1.*no match/i)
  })

  it('rejects multiple matches as ambiguous and reports the count', () => {
    const content = 'dup\ndup\ndup\n'
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\ndup\n=======\nu\n>>>>>>> REPLACE\n')
    expect(() => applySearchReplace(content, blocks)).toThrow(/ambiguous.*3/i)
  })

  it('replaces every occurrence when the block carries :all', () => {
    const content = 'dup\ndup\ndup\n'
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\ndup\n=======\nu\n>>>>>>> REPLACE :all\n')
    expect(applySearchReplace(content, blocks)).toBe('u\nu\nu\n')
  })

  it('applies blocks sequentially: block 2 sees block 1 output', () => {
    const diff =
      '<<<<<<< SEARCH\nline1\n=======\nAAA\n>>>>>>> REPLACE\n' +
      '<<<<<<< SEARCH\nAAA\n=======\nBBB\n>>>>>>> REPLACE'
    expect(applySearchReplace(B, parseSearchReplaceBlocks(diff))).toBe('BBB\nline2\nline3\n')
  })

  it('empty search replaces an empty document only', () => {
    const blocks = parseSearchReplaceBlocks('<<<<<<< SEARCH\n=======\ncreated\n>>>>>>> REPLACE\n')
    expect(applySearchReplace('', blocks)).toBe('created\n')
    expect(() => applySearchReplace(B, blocks)).toThrow(/no match/i)
  })
})
