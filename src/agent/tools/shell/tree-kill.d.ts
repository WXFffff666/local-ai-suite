/**
 * tree-kill has no bundled types and no @types package on npm (verified:
 * 404) — this is the minimal declaration for the only call site we have.
 */
declare module 'tree-kill' {
  function treeKill(pid: number, signal?: string | number, callback?: (error?: Error) => void): void
  export = treeKill
}
