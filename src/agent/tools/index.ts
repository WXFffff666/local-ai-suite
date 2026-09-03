/**
 * src/agent/tools barrel — registration entry points for the tool lanes.
 * registerFileTools() is the todo27 surface consumed by lane 25's wiring
 * (services.ts builds the real PermissionEngine + the ask-bridge as a
 * PermissionPort and passes the active workspace root); it deliberately does
 * NOT touch registry.ts (todo23 owns that class) or the todo28 shell tools.
 */
import type { ToolRegistry } from './registry'
import { createFsTools, type FsToolDeps } from './fs/index'

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

/** Registers the four fs tools (read_file/write_file/edit_file/glob_list). */
export function registerFileTools(registry: ToolRegistry, deps: FsToolDeps): void {
  for (const tool of createFsTools(deps)) {
    registry.register(tool)
  }
}
