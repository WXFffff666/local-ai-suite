import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * E2E v2 (todo12): the smoke suite launches the REAL built app
 * (`out/main/index.js` via package.json "main"), so out/ must be freshly
 * compiled from the current source before any test runs. electron-vite has
 * no watch-mode output guarantee here — build unconditionally; it is cached
 * and fast relative to a cold Electron launch.
 */
export default function globalSetup(): void {
  const root = process.cwd()
  const result = spawnSync('pnpm', ['build'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(
      `globalSetup: pnpm build failed (exit ${String(result.status)})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
  for (const rel of [join('out', 'main', 'index.js'), join('out', 'preload', 'index.js'), join('out', 'renderer', 'index.html')]) {
    if (!existsSync(join(root, rel))) throw new Error(`globalSetup: build output missing: ${rel}`)
  }
}
