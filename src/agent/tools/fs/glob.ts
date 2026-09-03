/**
 * glob.ts — recursive workspace listing for glob_list (todo27). R7 file stack:
 * `ignore` (gitignore semantics, used by eslint) per-directory scopes +
 * `picomatch` for the user pattern. Walk rules: depth cap 8, hard-skip
 * .git/node_modules/dist/out, never follow symlinks (the fence is per-root
 * and mid-walk links are a cycle/escape surface), output as sorted
 * workspace-relative slash paths capped at maxEntries + truncated flag.
 *
 * Deviation note (documented, deliberate): a deeper .gitignore that NEGATES
 * a parent's ignore (`!keep.txt`) is not re-enabled — we resolve scopes
 * deepest-first and only ever upgrade to ignored. Listing too little is
 * safe; listing a re-included file is not worth the pattern-match audit.
 * `ignore@7.0.8` resolves to its CJS build (module.exports), so a static
 * import is bundler-safe here despite the upstream ESM-only warning for
 * future majors; if a later bump flips it, switch to `await import('ignore')`
 * inside listWorkspaceFiles (already async).
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

import ignore from 'ignore'
import picomatch from 'picomatch'

export const GLOB_MAX_DEPTH = 8
export const GLOB_DEFAULT_MAX_ENTRIES = 2000
export const GLOB_SKIP_DIRS: readonly string[] = ['.git', 'node_modules', 'dist', 'out']

export type GlobResult = {
  readonly paths: readonly string[]
  readonly truncated: boolean
}

type IgnoreScope = { readonly dirRel: string; readonly ig: ignore.Ignore }

function isIgnored(scopes: readonly IgnoreScope[], rel: string, isDir: boolean): boolean {
  const probe = isDir && !rel.endsWith('/') ? `${rel}/` : rel
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    const scope = scopes[i]
    if (scope === undefined) continue
    const sub = scope.dirRel === '' ? probe : probe.startsWith(`${scope.dirRel}/`) ? probe.slice(scope.dirRel.length + 1) : null
    if (sub === null || sub === '') continue
    if (scope.ig.ignores(sub)) return true
  }
  return false
}

async function loadGitignore(dirAbs: string): Promise<string | null> {
  try {
    return await readFile(join(dirAbs, '.gitignore'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Lists files (not directories) under `rootAbs` matching `pattern`,
 * skipping gitignored paths. `rootAbs` must already be fenced + realpath'd.
 * Throws on abort so the runner surfaces a cancelled tool_result.
 */
export async function listWorkspaceFiles(
  rootAbs: string,
  pattern: string,
  opts: { readonly maxEntries: number; readonly signal: AbortSignal },
): Promise<GlobResult> {
  const isMatch = picomatch(pattern, { dot: true })
  const paths: string[] = []
  let truncated = false

  async function walk(dirAbs: string, dirRel: string, scopes: readonly IgnoreScope[], depth: number): Promise<void> {
    if (truncated) return
    if (opts.signal.aborted) throw new Error('glob_list aborted')
    const own = await loadGitignore(dirAbs)
    const chain = own === null ? scopes : [...scopes, { dirRel, ig: ignore().add(own) }]
    const entries = (await readdir(dirAbs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (truncated) return
      const rel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (GLOB_SKIP_DIRS.includes(entry.name)) continue
        if (isIgnored(chain, rel, true)) continue
        if (depth + 1 > GLOB_MAX_DEPTH) continue
        await walk(join(dirAbs, entry.name), rel, chain, depth + 1)
      } else if (entry.isFile()) {
        if (isIgnored(chain, rel, false)) continue
        if (!isMatch(rel)) continue
        if (paths.length >= opts.maxEntries) {
          truncated = true
          return
        }
        paths.push(rel)
      }
    }
  }

  await walk(rootAbs, '', [], 0)
  paths.sort()
  return { paths, truncated }
}
