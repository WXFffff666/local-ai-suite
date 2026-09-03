/**
 * src/agent/tools barrel — registration entry points for the tool lanes.
 * registerFileTools() is the todo27 surface and registerShellTools() the
 * todo28 surface (28 deferred its barrel re-export to lane 29 — it lands
 * here); todo29's wiring (src/main/agentWiring.ts) builds the real
 * PermissionEngine + the ask-bridge as a PermissionPort and passes the
 * active workspace root. Nothing here touches registry.ts (todo23 owns
 * that class).
 */
import type { ToolRegistry } from './registry'
import { createFsTools, type FsToolDeps } from './fs/index'

export { ToolRegistry, type ToolRegistration, assertStrictToolSchema } from './registry'
export { createFsTools, type FsToolDeps, type FsToolLogger, READ_FILE_MAX_BYTES } from './fs/index'
export {
  fencePath,
  FsPathError,
  gate,
  PermissionDeniedError,
  toRelativeSlash,
  type PermissionPort,
} from './fs/gating'
export { parseSearchReplaceBlocks, applySearchReplace, type SearchReplaceBlock } from './fs/diff-parser'
export { listWorkspaceFiles, type GlobResult } from './fs/glob'

export { createShellTools, registerShellTools } from './shell/index'
export { shellGrantSuggestion, firstProgram } from './shell/tokenize'
export type {
  ShellChunk,
  ShellChunkSink,
  ShellResult,
  ShellStream,
  ShellToolDeps,
  ShellToolLogger,
} from './shell/index'

/** Registers the four fs tools (read_file/write_file/edit_file/glob_list). */
export function registerFileTools(registry: ToolRegistry, deps: FsToolDeps): void {
  for (const tool of createFsTools(deps)) {
    registry.register(tool)
  }
}
