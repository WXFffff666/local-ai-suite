import { describe, expect, it } from 'vitest'

import afterAllArtifactBuild from '../../scripts/pack-after-all.mjs'

/**
 * Regression contract (release-run 33832401173, v0.1.0@8744bdc).
 *
 * electron-builder 26 pipes the afterAllArtifactBuild return through
 * asArray() and treats EVERY element as a file-path string to publish
 * (app-builder-lib out/index.js:60-76). The hook previously returned the
 * legacy 24.x object shape { artifacts: [] } — asArray() wraps any
 * non-array in a 1-element array, so scheduleUpload received
 * { file: <Object> } and GitHubPublisher.upload crashed on
 * path.basename(task.file) with:
 *   TypeError: The "path" argument must be of type string.
 *               Received an instance of Object
 * reproduced on BOTH win and linux build jobs, only under --publish
 * always (that is why local -p never dist stayed green).
 *
 * The hook adds no artifacts, so the contract-true value is a string[]
 * (empty). These pins make a shape regression fail `pnpm test`, not CI.
 */
describe('pack-after-all — electron-builder 26 publish contract', () => {
  it('resolves to a plain string[] (never an object with .artifacts)', async () => {
    const result = await afterAllArtifactBuild({ artifactPaths: [], packager: {}, platform: null, arch: null })
    expect(Array.isArray(result)).toBe(true)
    expect(result).not.toHaveProperty('artifacts')
    for (const item of result as unknown[]) {
      expect(typeof item).toBe('string')
    }
  })

  it('empty artifactPaths (dir build) yields zero-length array so the publisher short-circuits', async () => {
    const result = (await afterAllArtifactBuild({ artifactPaths: [] })) as unknown[]
    expect(result).toHaveLength(0)
  })

  it('every item survives path.basename (the exact call that threw in CI)', async () => {
    const { basename } = await import('node:path')
    const result = (await afterAllArtifactBuild({ artifactPaths: [] })) as string[]
    expect(() => result.map((f) => basename(f))).not.toThrow()
  })
})
