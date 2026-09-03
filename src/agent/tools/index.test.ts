/**
 * index.test.ts (tools barrel) — lane-25 wiring surface: registerFileTools
 * must put all four strict-schema fs tools onto a real ToolRegistry and
 * reject a double registration (same registry used twice = wiring bug).
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { registerFileTools } from './index'
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
})
