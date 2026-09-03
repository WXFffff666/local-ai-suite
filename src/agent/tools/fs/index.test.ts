/**
 * index.test.ts — todo27 end-to-end: the four fs tools driven through the
 * real ToolRegistry (which enforces the OpenAI strict-schema contract) with
 * the fake PermissionPort against a real temp workspace. Pins per acceptance
 * criteria: 2MB read cap, atomic writes, SEARCH/REPLACE edit outcomes,
 * gitignore-aware globbing, and fence rejections landing in the audit log.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFsTools } from './index'
import { fakePermission, type FakePermission } from './testutils'
import { ToolRegistry } from '../registry'
import { PermissionDeniedError } from './gating'
import type { ToolExecutionContext } from '../../runner/types'

const MAX_BYTES = 1024 // tiny read cap so the too-large path stays test-cheap

let root: string
let permission: FakePermission

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    callId: 'c-1',
    signal: new AbortController().signal,
    reportPhase: vi.fn(),
    ...overrides,
  }
}

let registry: ToolRegistry

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fstools-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  permission = fakePermission()
  registry = new ToolRegistry()
  for (const tool of createFsTools({ workspaceRoot: root, permission: permission.port, maxReadBytes: MAX_BYTES })) {
    registry.register(tool)
  }
})

describe('registry contract', () => {
  it('registers exactly the four fs tools with strict schemas', () => {
    expect(registry.list().map((d) => d.name).sort()).toEqual(['edit_file', 'glob_list', 'read_file', 'write_file'])
    for (const def of registry.list()) {
      expect(def.parameters['type']).toBe('object')
      expect(def.parameters['additionalProperties']).toBe(false)
      const props = def.parameters['properties'] as object
      const required = def.parameters['required'] as readonly string[]
      expect(Object.keys(props).sort()).toEqual([...required].sort())
    }
  })
})

describe('read_file', () => {
  it('returns content and byte count', async () => {
    writeFileSync(join(root, 'hello.txt'), 'hi there')
    await expect(registry.execute('read_file', JSON.stringify({ path: 'hello.txt' }), ctx())).resolves.toEqual({
      content: 'hi there',
      bytes: 8,
    })
  })

  it('rejects files over the size cap with a too-large error before reading', async () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(MAX_BYTES + 1))
    await expect(registry.execute('read_file', JSON.stringify({ path: 'big.txt' }), ctx())).rejects.toThrow(/too-large/)
  })

  it('rejects missing files', async () => {
    await expect(registry.execute('read_file', JSON.stringify({ path: 'ghost.txt' }), ctx())).rejects.toThrow(/not-found/)
  })

  it('path fence: traversal is rejected AND audited, gate never reached', async () => {
    const outside = join(tmpdir(), 'definitely-outside-fs-fence', 'x.txt')
    await expect(registry.execute('read_file', JSON.stringify({ path: '../x.txt' }), ctx())).rejects.toThrow(/outside/)
    await expect(registry.execute('read_file', JSON.stringify({ path: outside }), ctx())).rejects.toThrow(/outside/)
    expect(permission.audits.some((a) => a.assessment.decision === 'deny' && a.detail?.['reason'] === 'path-outside-workspace')).toBe(true)
    expect(permission.asks).toHaveLength(0)
  })

  it('permission deny: rejects with PermissionDenied and never calls reportPhase(running)', async () => {
    writeFileSync(join(root, 'locked.txt'), 'secret')
    permission.decision = 'deny'
    const c = ctx()
    await expect(registry.execute('read_file', JSON.stringify({ path: 'locked.txt' }), c)).rejects.toThrow(PermissionDeniedError)
    expect(c.reportPhase).not.toHaveBeenCalledWith('running')
  })
})

describe('write_file', () => {
  it('writes through the gate, creates parent dirs, leaves no tmp residue', async () => {
    const c = ctx()
    await expect(registry.execute('write_file', JSON.stringify({ path: 'deep/nest/out.txt', content: 'payload' }), c)).resolves.toMatchObject({ bytes: 7 })
    expect(readFileSync(join(root, 'deep', 'nest', 'out.txt'), 'utf8')).toBe('payload')
    expect(readdirSync(join(root, 'deep', 'nest'))).toEqual(['out.txt']) // write-file-atomic renamed cleanly
    expect(c.reportPhase).toHaveBeenCalledWith('running')
  })

  it('ask → denied: nothing touches disk', async () => {
    permission.decision = 'ask'
    permission.userAnswer = 'deny'
    await expect(registry.execute('write_file', JSON.stringify({ path: 'never.txt', content: 'x' }), ctx())).rejects.toThrow(PermissionDeniedError)
    expectFileAbsent('never.txt')
  })
})

function expectFileAbsent(name: string): void {
  expect(readdirSync(root).includes(name)).toBe(false)
}

describe('edit_file', () => {
  it('applies a unique SEARCH/REPLACE and writes atomically', async () => {
    writeFileSync(join(root, 'code.ts'), 'const a = 1\nconst b = 2\n')
    const diff = '<<<<<<< SEARCH\nconst a = 1\n=======\nconst a = 42\n>>>>>>> REPLACE\n'
    await registry.execute('edit_file', JSON.stringify({ path: 'code.ts', diff }), ctx())
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('const a = 42\nconst b = 2\n')
  })

  it('ambiguous match rejects with the occurrence count and changes nothing', async () => {
    writeFileSync(join(root, 'dup.txt'), 'x\nx\n')
    const diff = '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n'
    await expect(registry.execute('edit_file', JSON.stringify({ path: 'dup.txt', diff }), ctx())).rejects.toThrow(/ambiguous.*2/)
    expect(readFileSync(join(root, 'dup.txt'), 'utf8')).toBe('x\nx\n')
  })

  it('whitespace mismatch is a hard no-match', async () => {
    writeFileSync(join(root, 'ws.txt'), '	a\n') // leading tab
    const diff = '<<<<<<< SEARCH\n a\n=======\nno\n>>>>>>> REPLACE\n' // leading space instead
    await expect(registry.execute('edit_file', JSON.stringify({ path: 'ws.txt', diff }), ctx())).rejects.toThrow(/block 1.*no match/i)
  })

  it('creates a new file from an empty SEARCH block', async () => {
    const diff = '<<<<<<< SEARCH\n=======\nfresh\n>>>>>>> REPLACE\n'
    await registry.execute('edit_file', JSON.stringify({ path: 'fresh.txt', diff }), ctx())
    expect(readFileSync(join(root, 'fresh.txt'), 'utf8')).toBe('fresh\n')
  })

  it('fence + permission behave like write_file', async () => {
    await expect(registry.execute('edit_file', JSON.stringify({ path: '../../etc/passwd', diff: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE' }), ctx())).rejects.toThrow(/outside/)
  })
})

describe('glob_list', () => {
  // Own workspace per test: the shared `root` accumulates files from the
  // read/write/edit suites, which would pollute '**/*' listings.
  let repo: string
  let repoReg: ToolRegistry

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'fsrepo-'))
    mkdirSync(join(repo, 'ignored'))
    mkdirSync(join(repo, 'sub'))
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n*.log\n')
    writeFileSync(join(repo, 'a.ts'), 'a')
    writeFileSync(join(repo, 'b.log'), 'b')
    writeFileSync(join(repo, 'ignored', 'c.ts'), 'c')
    writeFileSync(join(repo, 'sub', 'd.md'), 'd')
    writeFileSync(join(repo, 'node_modules', 'pkg', 'e.js'), 'e')
    repoReg = new ToolRegistry()
    for (const tool of createFsTools({ workspaceRoot: repo, permission: permission.port })) {
      repoReg.register(tool)
    }
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('lists gitignore-clean relative paths sorted, honoring the pattern', async () => {
    const out = (await repoReg.execute('glob_list', JSON.stringify({ pattern: '**/*' }), ctx())) as {
      paths: string[]
      truncated: boolean
    }
    expect(out.paths).toEqual(['.gitignore', 'a.ts', 'sub/d.md'])
    expect(out.truncated).toBe(false)
    expect(permission.audits.at(-1)?.action).toEqual({ type: 'fs.read', target: { path: '**/*' } })
  })

  it('picomatch pattern filters to *.ts only (ignored dir stays hidden)', async () => {
    const out = (await repoReg.execute('glob_list', JSON.stringify({ pattern: '**/*.ts' }), ctx())) as { paths: string[] }
    expect(out.paths).toEqual(['a.ts'])
  })

  it('caps output and flags truncated', async () => {
    const capped = new ToolRegistry()
    for (const tool of createFsTools({ workspaceRoot: repo, permission: permission.port, maxGlobEntries: 2 })) {
      capped.register(tool)
    }
    const out = (await capped.execute('glob_list', JSON.stringify({ pattern: '**' }), ctx())) as {
      paths: string[]
      truncated: boolean
    }
    expect(out.paths).toHaveLength(2)
    expect(out.truncated).toBe(true)
  })

  it('gate ask→deny: no listing happens and the denial is audited', async () => {
    permission.decision = 'ask'
    permission.userAnswer = 'deny'
    await expect(repoReg.execute('glob_list', JSON.stringify({ pattern: '**' }), ctx())).rejects.toThrow(PermissionDeniedError)
    expect(permission.audits.some((a) => a.assessment.decision === 'deny')).toBe(true)
  })

  it('rejects patterns escaping the workspace and audits the denial', async () => {
    await expect(repoReg.execute('glob_list', JSON.stringify({ pattern: '../**' }), ctx())).rejects.toThrow(/outside/)
    await expect(repoReg.execute('glob_list', JSON.stringify({ pattern: '/etc/**' }), ctx())).rejects.toThrow(/outside/)
    expect(permission.audits.filter((a) => a.assessment.decision === 'deny')).toHaveLength(2)
  })
})
