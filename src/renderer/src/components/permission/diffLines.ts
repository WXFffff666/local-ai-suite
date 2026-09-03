/**
 * todo25 — pure line-diff util for the permission dialog's unified preview.
 * Deliberately self-contained (NO `diff`/jsdiff import this round): a plain
 * LCS backtrace over lines is exact for the ≤300-line inputs the guard
 * allows, and the dialog only needs +/-/context rows, not git's hunk
 * headers. Oversized sides return a tooLarge marker so the caller falls
 * back to a raw old/new render instead of an O(n*m) blowup on agent output.
 *
 * EOF-newline honesty: a missing trailing newline survives the split as a
 * final empty line, so "a\n" vs "a" diffs as `del:''` — the same signal
 * git renders as "\ No newline at end of file".
 */

/** Per-side line ceiling for the LCS path (guard is strictly greater-than). */
export const MAX_DIFF_LINES = 300

export type DiffLine = { readonly type: 'ctx' | 'add' | 'del'; readonly text: string }

export type DiffResult =
  | { readonly tooLarge: false; readonly lines: readonly DiffLine[] }
  | { readonly tooLarge: true; readonly oldText: string; readonly newText: string }

/** '' is zero lines; otherwise split on \n, keeping a trailing '' when present. */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

export function diffLines(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { tooLarge: true, oldText, newText }
  }

  const n = a.length
  const m = b.length
  // LCS length table, bottom-up. Int32Array keeps reads total (no undefined
  // widening, no assertions) and the whole budget at the cap is ~301 KB.
  const dp: Int32Array[] = []
  for (let i = 0; i <= n; i += 1) dp.push(new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      lines.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    lines.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    lines.push({ type: 'add', text: b[j] })
    j += 1
  }
  return { tooLarge: false, lines }
}
