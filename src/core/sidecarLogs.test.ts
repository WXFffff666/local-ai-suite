import { describe, expect, it } from 'vitest'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { SidecarLogger, LOG_MAX_BYTES, type LogFsDeps } from './sidecarLogs'

const realFs: LogFsDeps = {
  createWriteStream,
  statSync,
  renameSync,
  mkdirSync,
  existsSync,
}

function makeLogger(name: string): { logger: SidecarLogger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'las-sidecarlogs-'))
  const logger = new SidecarLogger({ name, logDir: dir, maxBytes: LOG_MAX_BYTES, fsDeps: realFs })
  return { logger, dir }
}

describe('SidecarLogger — flush-before-remove contract (CI ENOTEMPTY)', () => {
  it('whenIdle() resolves only after the append stream fully closes its fd', async () => {
    const { logger, dir } = makeLogger('idle')
    logger.open()
    logger.write('[start] hello world')
    expect(logger.filePath).toBe(join(dir, 'sidecar-idle.log'))
    logger.close()
    // Hand the closing stream back to the event loop and await real fd release.
    await logger.whenIdle()
    // After whenIdle() resolves, the file is fully flushed and no handle is
    // held — removing the dir must succeed with a plain (non-retrying) rm.
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow()
  })

  it('whenIdle() is a no-op resolve when nothing was ever opened', async () => {
    const { logger, dir } = makeLogger('noop')
    await expect(logger.whenIdle()).resolves.toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reopen after close tracks only the live stream; stale handle still flushes', async () => {
    const { logger, dir } = makeLogger('reopen')
    logger.open()
    logger.write('first')
    logger.close()
    logger.open()
    logger.write('second')
    logger.close()
    await logger.whenIdle()
    const body = readFileSync(logger.filePath, 'utf8') as string
    expect(body).toContain('first')
    expect(body).toContain('second')
    rmSync(dir, { recursive: true, force: true })
  })
})
