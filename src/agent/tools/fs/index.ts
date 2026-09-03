/**
 * createFsTools — the todo27 file-tool set (read_file / write_file /
 * edit_file / glob_list) as registry-ready ToolRegistrations. Every run body
 * follows the same order: parse args (zod strictObject = the trust boundary)
 * → fence path (audited rejection) → gate (audited decision) →
 * ctx.reportPhase('running') (types.ts contract: only after allow) → effect.
 * Writes go through write-file-atomic (temp + fsync + rename in-dir).
 */
import { mkdir, readFile, stat } from 'fs/promises'
import { realpathSync } from 'fs'
import { dirname, resolve } from 'path'

import writeFileAtomic from 'write-file-atomic'
import { z, type ZodType } from 'zod'

import type { JsonObject, JsonSchema, ToolDef, ToolExecutionContext } from '../../runner/types'
import type { PermissionKind } from '../../policy/types'
import type { ToolRegistration } from '../registry'
import { fencePath, FsPathError, gate, toRelativeSlash, type PermissionPort } from './gating'
import { applySearchReplace, parseSearchReplaceBlocks } from './diff-parser'
import { GLOB_DEFAULT_MAX_ENTRIES, listWorkspaceFiles } from './glob'

/** 2 MiB per the plan; overridable only for tests. */
export const READ_FILE_MAX_BYTES = 2 * 1024 * 1024

export type FsToolLogger = {
  warn(msg: string, meta?: Readonly<Record<string, unknown>>): void
}

export type FsToolDeps = {
  readonly workspaceRoot: string
  readonly permission: PermissionPort
  readonly log?: FsToolLogger
  /** test seam; defaults to READ_FILE_MAX_BYTES */
  readonly maxReadBytes?: number
  /** test seam; defaults to 2000 */
  readonly maxGlobEntries?: number
}

type ResolvedDeps = FsToolDeps & { readonly maxReadBytes: number; readonly maxGlobEntries: number }

// --- strict schemas (OpenAI strict: every property required) ---------------------

const readFileSchema = z.strictObject({
  path: z.string().min(1).describe('File path relative to the workspace root'),
})
const writeFileSchema = z.strictObject({
  path: z.string().min(1).describe('File path relative to the workspace root'),
  content: z.string().describe('Full new content of the file'),
})
const editFileSchema = z.strictObject({
  path: z.string().min(1).describe('File path relative to the workspace root'),
  diff: z
    .string()
    .min(1)
    .describe(
      'One or more <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks; append " :all" to the REPLACE terminator to replace every occurrence; whitespace is matched exactly',
    ),
})
const globListSchema = z.strictObject({
  pattern: z
    .string()
    .describe('picomatch glob with / separators, relative to the workspace root, e.g. "**/*.ts"; use "**/*" to list all'),
})

function strictParams(schema: ZodType): JsonSchema {
  // z.toJSONSchema emits the strict-mode document registry.ts validates;
  // the cast erases zod's structural type only — the value is plain JSON.
  return z.toJSONSchema(schema) as unknown as JsonSchema
}

function def(name: string, description: string, schema: ZodType): ToolDef {
  return { name, description, parameters: strictParams(schema) }
}

// --- shared funnel bits -----------------------------------------------------------

/** fencePath + audit-denial on escape (越界即拒并计入审计，pre-fs). */
function fencedPath(deps: ResolvedDeps, kind: PermissionKind, rawPath: string): { abs: string; rel: string } {
  try {
    const abs = fencePath(deps.workspaceRoot, rawPath)
    return { abs, rel: toRelativeSlash(deps.workspaceRoot, abs) }
  } catch (e) {
    if (e instanceof FsPathError) {
      deps.permission.record(
        { type: kind, target: { path: rawPath } },
        { decision: 'deny', rule: null, ruleId: null, scope: null },
        { reason: e.code },
      )
      deps.log?.warn('fs tool path rejected', { kind, path: rawPath, code: e.code })
    }
    throw e
  }
}

function fsCode(e: unknown): string {
  return (e as NodeJS.ErrnoException).code ?? ''
}

/** Pure string fence for glob patterns (no fs probe — patterns carry wildcards). */
function fencePattern(deps: ResolvedDeps, pattern: string): void {
  const normalized = pattern.replace(/\\/g, '/')
  const escapes =
    normalized === '' ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  if (escapes) {
    const code = 'path-outside-workspace'
    deps.permission.record(
      { type: 'fs.read', target: { path: pattern } },
      { decision: 'deny', rule: null, ruleId: null, scope: null },
      { reason: code },
    )
    deps.log?.warn('glob_list pattern rejected', { pattern, code })
    throw new FsPathError(code)
  }
}

// --- the factory -------------------------------------------------------------------

export function createFsTools(deps: FsToolDeps): readonly ToolRegistration[] {
  const resolved: ResolvedDeps = {
    ...deps,
    maxReadBytes: deps.maxReadBytes ?? READ_FILE_MAX_BYTES,
    maxGlobEntries: deps.maxGlobEntries ?? GLOB_DEFAULT_MAX_ENTRIES,
  }
  const rootReal = realpathSync(resolve(deps.workspaceRoot))

  const readFileTool: ToolRegistration = {
    def: def('read_file', `Read one workspace file as UTF-8 text (max ${resolved.maxReadBytes} bytes).`, readFileSchema),
    run: async (args: JsonObject, ctx: ToolExecutionContext): Promise<unknown> => {
      const { path } = readFileSchema.parse(args)
      const { abs, rel } = fencedPath(resolved, 'fs.read', path)
      await gate(resolved.permission, { type: 'fs.read', target: { path: rel } }, ctx)
      ctx.reportPhase('running')
      const info = await stat(abs).catch((e: unknown): never => {
        if (fsCode(e) === 'ENOENT') throw new Error(`read_file: file not-found: ${rel}`)
        throw e
      })
      if (!info.isFile()) throw new Error(`read_file: not-a-file: ${rel}`)
      if (info.size > resolved.maxReadBytes) {
        throw new Error(`read_file: file too-large (${info.size} bytes > cap ${resolved.maxReadBytes})`)
      }
      const content = await readFile(abs, 'utf8')
      return { content, bytes: info.size }
    },
  }

  const writeFileTool: ToolRegistration = {
    def: def('write_file', 'Create or overwrite one workspace file atomically (parents auto-created).', writeFileSchema),
    run: async (args: JsonObject, ctx: ToolExecutionContext): Promise<unknown> => {
      const { path, content } = writeFileSchema.parse(args)
      const { abs, rel } = fencedPath(resolved, 'fs.write', path)
      await gate(resolved.permission, { type: 'fs.write', target: { path: rel } }, ctx)
      ctx.reportPhase('running')
      await mkdir(dirname(abs), { recursive: true })
      await writeFileAtomic(abs, content, { encoding: 'utf8' })
      return { path: rel, bytes: Buffer.byteLength(content, 'utf8') }
    },
  }

  const editFileTool: ToolRegistration = {
    def: def('edit_file', 'Edit one workspace file with aider SEARCH/REPLACE blocks, written atomically.', editFileSchema),
    run: async (args: JsonObject, ctx: ToolExecutionContext): Promise<unknown> => {
      const { path, diff } = editFileSchema.parse(args)
      const blocks = parseSearchReplaceBlocks(diff) // parse before fs/permission side effects
      const { abs, rel } = fencedPath(resolved, 'fs.write', path)
      await gate(resolved.permission, { type: 'fs.write', target: { path: rel } }, ctx)
      ctx.reportPhase('running')
      let original: string
      try {
        original = await readFile(abs, 'utf8')
      } catch (e) {
        if (fsCode(e) !== 'ENOENT') throw e
        original = '' // only an empty-SEARCH block may proceed on a missing file
      }
      const next = applySearchReplace(original, blocks)
      await mkdir(dirname(abs), { recursive: true })
      await writeFileAtomic(abs, next, { encoding: 'utf8' })
      return { path: rel, blocks: blocks.length, bytes: Buffer.byteLength(next, 'utf8') }
    },
  }

  const globListTool: ToolRegistration = {
    def: def(
      'glob_list',
      `List workspace files matching a gitignore-aware glob (up to ${resolved.maxGlobEntries} sorted relative paths).`,
      globListSchema,
    ),
    run: async (args: JsonObject, ctx: ToolExecutionContext): Promise<unknown> => {
      const { pattern } = globListSchema.parse(args)
      fencePattern(resolved, pattern)
      await gate(resolved.permission, { type: 'fs.read', target: { path: pattern } }, ctx)
      ctx.reportPhase('running')
      return listWorkspaceFiles(rootReal, pattern, {
        maxEntries: resolved.maxGlobEntries,
        signal: ctx.signal,
      })
    },
  }

  return [readFileTool, writeFileTool, editFileTool, globListTool]
}
