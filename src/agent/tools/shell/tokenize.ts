/**
 * tokenize.ts — todo28 first-program extraction. This parser is ONLY used
 * for (a) the optional config program list and (b) the `Bash(<prog>:*)`
 * grant suggestion. The command string itself is NEVER re-serialized: it
 * crosses to the shell verbatim as a single argument (see
 * resolveShellInvocation), so pipes/quotes/&& survive — pinned by
 * tokenize.test.ts + the exec matrix. A full shell-grammar tokenizer is
 * deliberately NOT implemented (YAGNI; mis-tokenizing would only affect the
 * suggestion text, worst case over-prompting the user).
 */

const EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.com'] as const

/** Strip surrounding quotes, take the basename, drop a Windows exe suffix, lowercase. */
export function firstProgram(command: string): string {
  const trimmed = command.trimStart()
  if (trimmed === '') return ''
  let token: string
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0]
    const end = trimmed.indexOf(quote, 1)
    token = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  } else {
    const space = trimmed.search(/\s/)
    token = space === -1 ? trimmed : trimmed.slice(0, space)
  }
  // env-assignment prefixes (`FOO=bar cmd ...`) are not programs — skip them
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
    const rest = trimmed.slice(trimmed.indexOf(token) + token.length).trimStart()
    if (rest === '') return ''
    return firstProgram(rest)
  }
  const base = token.split(/[\\/]/).pop() ?? ''
  const lower = base.toLowerCase()
  for (const suffix of EXECUTABLE_SUFFIXES) {
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length)
  }
  return lower
}

/**
 * The Claude-Code-style prefix rule a user "always allow" would persist for
 * this command. todo29's grant bridge uses this for fs.shell actions (the
 * gate() funnel in fs/gating.ts owns audit rows and does not accept extra
 * tool-side detail fields, so the suggestion is exposed as this helper
 * instead — documented deviation).
 */
export function shellGrantSuggestion(command: string): string {
  return `Bash(${firstProgram(command)}:*)`
}
