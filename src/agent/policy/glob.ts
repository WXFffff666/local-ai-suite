// Minimal gitignore-flavoured glob matcher for permission rules (todo24).
// Deliberately dependency-free (picomatch is not in the main-process bundle).
//
// Supported syntax (the whole documented subset):
//   `**` as a full segment: zero or more path segments - leading, middle,
//          trailing, or the bare double-star (see globToRegExp cases)
//   `*`  inside a segment: any run of characters except `/`
//   every other character is a literal (`?`, `[`, `{` are NOT special)
//
// Known limits (documented deviations from gitignore/picomatch):
//   - no character classes, no `!` negation, no backslash escapes
//   - case-sensitive; callers fold case where wanted (net rules lowercase both sides)
//   - trailing-slash patterns and consecutive `**` segments are undefined
//   - separator normalization (backslash -> slash) happens in rules.ts before matching

/** Escape a character for literal use inside a RegExp source. */
function escapeChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function segmentToRegExpSource(seg: string): string {
  let re = ''
  for (const ch of seg) re += ch === '*' ? '[^/]*' : escapeChar(ch)
  return re
}

/** Compile a mini-glob pattern into an anchored RegExp. */
export function globToRegExp(pattern: string): RegExp {
  const segs = pattern.split('/')
  const n = segs.length
  let re = ''
  let skipSep = false
  for (let i = 0; i < n; i++) {
    const seg = segs[i] as string
    const isFirst = i === 0
    const isLast = i === n - 1
    if (seg === '**') {
      if (isFirst) {
        // leading `**/...`: zero or more directory segments (or everything, if bare)
        re += isLast ? '[\\s\\S]*' : '(?:[^/]+/)*'
        skipSep = !isLast
      } else if (isLast) {
        // trailing `/**`: the directory itself plus anything below it
        re += '(?:/[\\s\\S]*)?'
      } else {
        // middle `/.../`: zero or more full segments between the slashes
        re += '/(?:[^/]+/)*'
        skipSep = true
      }
      continue
    }
    if (!isFirst && !skipSep) re += '/'
    skipSep = false
    re += segmentToRegExpSource(seg)
  }
  return new RegExp('^' + re + '$')
}

/** Length of the literal prefix before the first wildcard - the Roo-style specificity score. */
export function literalPrefixLength(pattern: string): number {
  const i = pattern.indexOf('*')
  return i === -1 ? pattern.length : i
}

/**
 * Match a rule pattern against a path-like value.
 * A pattern without any star is a literal PATH PREFIX: `src` matches `src` and
 * `src/a.ts` but not `srcx/a.ts` (segment boundary required). Patterns with
 * wildcards compile to the mini-glob above.
 */
export function matchPathLike(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) {
    const base = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
    return value === base || value.startsWith(base + '/')
  }
  return globToRegExp(pattern).test(value)
}
