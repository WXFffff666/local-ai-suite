/**
 * tokenize.test.ts — todo28 tokenizer units: the first-program extraction is
 * ONLY for the grant suggestion / optional program list; the command string
 * itself must cross to the shell untouched (pipes/quotes preserved verbatim
 * — the exec matrix spawns prove the "intact" half).
 */
import { describe, expect, it } from 'vitest'

import { firstProgram, shellGrantSuggestion } from './tokenize'
import { resolveShellInvocation } from './process'

describe('firstProgram', () => {
  it('extracts the plain leading token', () => {
    expect(firstProgram('git commit -m "fix x"')).toBe('git')
  })

  it('basenames + de-extensions a quoted absolute path', () => {
    expect(firstProgram('"C:\\Program Files\\Git\\bin\\git.exe" push')).toBe('git')
  })

  it('handles POSIX paths and .cmd shims', () => {
    expect(firstProgram('/usr/local/bin/node script.js')).toBe('node')
    expect(firstProgram('npx.cmd vitest run')).toBe('npx')
  })

  it('returns empty for whitespace-only input', () => {
    expect(firstProgram('   ')).toBe('')
  })
})

describe('shellGrantSuggestion', () => {
  it('renders the Claude-Code-style prefix rule for the user always-grant', () => {
    expect(shellGrantSuggestion('npm run test:unit -- --watch')).toBe('Bash(npm:*)')
  })

  it('falls back to the exact bash wrapper for an untokenizable command', () => {
    expect(shellGrantSuggestion('   ')).toBe('Bash(:*)')
  })
})

describe('resolveShellInvocation', () => {
  it('win32: powershell -EncodedCommand carrying the UTF-8 prefix + command as ONE lossless base64 payload', () => {
    const command = `git log --oneline | Select-String "fix" && echo done`
    const { file, args } = resolveShellInvocation(command, 'win32')
    expect(file).toBe('powershell.exe')
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    // base64(UTF-16LE) is the ONLY handoff that survives every argv-quoting
    // layer intact — decode and pin the raw pipeline character-for-character
    const script = Buffer.from(args[3] as string, 'base64').toString('utf16le')
    expect(script.endsWith(`git log --oneline | Select-String "fix" && echo done`)).toBe(true)
    expect(script).toContain('[Console]::OutputEncoding=[Text.Encoding]::UTF8;')
  })

  it('posix: $SHELL (fallback /bin/sh) -c with the raw command as one argument', () => {
    const command = `echo 'a|b' && ls`
    const { file, args } = resolveShellInvocation(command, 'linux', '/bin/zsh')
    expect(file).toBe('/bin/zsh')
    expect(args).toEqual(['-c', command])
  })

  it('posix default shell is /bin/sh when none is given', () => {
    expect(resolveShellInvocation('true', 'linux').file).toBe('/bin/sh')
  })
})
