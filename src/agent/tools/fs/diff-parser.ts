/**
 * diff-parser.ts — aider SEARCH/REPLACE block grammar (Appendix A row 23-28
 * anchor; cline/Roo Code semantics, re-implemented not vendored):
 *
 *   <<<<<<< SEARCH
 *   exact original text
 *   =======
 *   replacement text
 *   >>>>>>> REPLACE          (or `>>>>>>> REPLACE :all` → replace-all)
 *
 * Rules pinned by the suite: marker lines match exactly (tolerating trailing
 * whitespace); block interior lines are byte-exact (whitespace-sensitive);
 * an empty SEARCH block is the aider "new file" form; multiple blocks apply
 * sequentially to the evolving content; a non-`:all` search must match
 * exactly once or the apply reports ambiguous WITH the match count so the
 * model can widen its context.
 */

export type SearchReplaceBlock = {
  readonly search: string
  readonly replace: string
  readonly replaceAll: boolean
}

export class DiffParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffParseError'
  }
}

export type DiffApplyErrorCode = 'no-match' | 'ambiguous'

export class DiffApplyError extends Error {
  constructor(
    message: string,
    readonly code: DiffApplyErrorCode,
    readonly blockIndex: number,
    readonly matches: number,
  ) {
    super(message)
    this.name = 'DiffApplyError'
  }
}

const SEARCH_MARKER = '<<<<<<< SEARCH'
const SEP_MARKER = '======='

function endsBlock(line: string): { replaceAll: boolean } | null {
  const trimmed = line.replace(/\s+$/, '')
  if (trimmed === '>>>>>>> REPLACE') return { replaceAll: false }
  if (trimmed === '>>>>>>> REPLACE :all') return { replaceAll: true }
  return null
}

function toText(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

/** Parses one or more SEARCH/REPLACE blocks; blank lines between blocks are ignored. */
export function parseSearchReplaceBlocks(diff: string): SearchReplaceBlock[] {
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop() // artifact of a trailing newline, not block content
  const blocks: SearchReplaceBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (line !== SEARCH_MARKER) {
      throw new DiffParseError(
        blocks.length === 0
          ? `line ${i + 1}: expected '${SEARCH_MARKER}' — no SEARCH block found`
          : `line ${i + 1}: unexpected content between SEARCH blocks`,
      )
    }
    i += 1
    const search: string[] = []
    while (i < lines.length && (lines[i] ?? '') !== SEP_MARKER) {
      search.push(lines[i] ?? '')
      i += 1
    }
    if ((lines[i] ?? '') !== SEP_MARKER) {
      throw new DiffParseError(`missing '${SEP_MARKER}' separator in SEARCH block ${blocks.length + 1}`)
    }
    i += 1
    const replace: string[] = []
    let closed = false
    let replaceAll = false
    while (i < lines.length) {
      const end = endsBlock(lines[i] ?? '')
      if (end !== null) {
        closed = true
        replaceAll = end.replaceAll
        i += 1
        break
      }
      replace.push(lines[i] ?? '')
      i += 1
    }
    if (!closed) throw new DiffParseError(`missing '>>>>>>> REPLACE' terminator in block ${blocks.length + 1}`)
    blocks.push({ search: toText(search), replace: toText(replace), replaceAll })
  }
  if (blocks.length === 0) throw new DiffParseError('diff contains no SEARCH block')
  return blocks
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/** Applies blocks sequentially (block n sees block n-1's output). Pure. */
export function applySearchReplace(content: string, blocks: readonly SearchReplaceBlock[]): string {
  let current = content
  blocks.forEach((block, idx) => {
    const n = idx + 1
    if (block.search === '') {
      // aider's new-file form: only legal against an empty document
      if (current !== '') {
        throw new DiffApplyError(`search block ${n}: no match (empty SEARCH only applies to empty files)`, 'no-match', n, 0)
      }
      current = block.replace
      return
    }
    const matches = countOccurrences(current, block.search)
    if (matches === 0) {
      throw new DiffApplyError(`search block ${n}: no match (whitespace-exact search failed)`, 'no-match', n, 0)
    }
    if (matches > 1 && !block.replaceAll) {
      throw new DiffApplyError(`search block ${n}: ambiguous (${matches} matches) — widen the SEARCH context or append :all`, 'ambiguous', n, matches)
    }
    current = block.replaceAll
      ? current.split(block.search).join(block.replace)
      : replaceFirst(current, block.search, block.replace)
  })
  return current
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle)
  return `${haystack.slice(0, at)}${replacement}${haystack.slice(at + needle.length)}`
}
