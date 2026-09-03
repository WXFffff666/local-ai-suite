/**
 * index.test.ts (tools barrel) — lane-29 wiring surface: registerFileTools
 * must put all four strict-schema fs tools onto a real ToolRegistry and
 * reject a double registration (same registry used twice = wiring bug);
 * registerShellTools (28's deferred barrel export) adds run_shell so both
 * families register through this single entry point.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { registerFileTools, registerShellTools, shellGrantSuggestion } from './index'
import { ToolRegistry } from './registry'
import { fakePermission } from './fs/testutils'

describe('registerFileTools (todo27 wiring surface)', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fsbarrel-'))
  })
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('registers read_file/write_file/edit_file/glob_list with strict schemas', () => {
    const registry = new ToolRegistry()
    registerFileTools(registry, { workspaceRoot: root, permission: fakePermission().port })
    expect(registry.list().map((d) => d.name).sort()).toEqual(['edit_file', 'glob_list', 'read_file', 'write_file'])
    expect(() => registerFileTools(registry, { workspaceRoot: root, permission: fakePermission().port })).toThrow(/already registered/)
  })

  it('registerShellTools adds run_shell through the same barrel (todo29 surface)', () => {
    const registry = new ToolRegistry()
    registerFileTools(registry, { workspaceRoot: root, permission: fakePermission().port })
    registerShellTools(registry, { workspaceRoot: root, permission: fakePermission().port, jailMode: 'off' })
    expect(registry.list().map((d) => d.name).sort()).toEqual(['edit_file', 'glob_list', 'read_file', 'run_shell', 'write_file'])
    expect(() =>
      registerShellTools(registry, { workspaceRoot: root, permission: fakePermission().port, jailMode: 'off' }),
    ).toThrow(/already registered/)
  })

  it('shellGrantSuggestion is re-exported for the grant-rule builder', () => {
    expect(shellGrantSuggestion('npm run test --watch')).toBe('Bash(npm:*)')
  })
})
