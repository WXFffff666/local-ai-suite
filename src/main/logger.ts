/**
 * Main-process structured logging (pino + pino-roll), introduced by audit fix W0-1.
 *
 * - Rolling file: `<userData>/logs/main.<date>.<n>.log`, rotated at 5 MiB, oldest
 *   files pruned beyond a retention count (mirrors SidecarManager's 5 MiB rotation).
 * - {@link registerGlobalErrorLogging} wires `uncaughtException` /
 *   `unhandledRejection` into that file. uncaughtException keeps Node's default
 *   terminal semantics: log → flush → exit(1). unhandledRejection only logs.
 *
 * The logger is created lazily so importing this module never spawns the pino
 * transport worker (tests inject fakes via deps instead).
 */

import { join } from 'path'
import { app } from 'electron'
import pino from 'pino'
import type { Logger } from 'pino'

export const MAIN_LOG_ROTATION_BYTES = 5 * 1024 * 1024
export const MAIN_LOG_RETAINED_ROTATIONS = 5
/** Upper bound on waiting for the transport flush before forcing exit. */
export const FLUSH_EXIT_GRACE_MS = 500

export function createMainLogger(logDir: string = join(app.getPath('userData'), 'logs')): Logger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { app: 'local-ai-suite' },
      timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.transport({
      target: 'pino-roll',
      options: {
        // file name stem → rotated outputs look like main.<date>.<n>.log
        file: join(logDir, 'main'),
        size: MAIN_LOG_ROTATION_BYTES,
        extension: 'log',
        mkdir: true,
        limit: { count: MAIN_LOG_RETAINED_ROTATIONS }
      }
    })
  )
}

let cached: Logger | null = null

export function getMainLogger(): Logger {
  cached ??= createMainLogger()
  return cached
}

export interface ErrorLoggingDeps {
  getLogger: () => Logger
  /** Exit seam: Electron main uses app.exit(); injectable for tests. */
  exit?: (code: number) => void
}

/**
 * Install process-level fatal logging. Returns an unregister function.
 * Side effects on `process` are intentional: this is the last-resort boundary.
 */
export function registerGlobalErrorLogging(deps: ErrorLoggingDeps): () => void {
  const exit = deps.exit ?? ((code: number): void => process.exit(code))

  const onUncaughtException = (error: Error): void => {
    const logger = deps.getLogger()
    logger.fatal({ err: error, event: 'process.uncaughtException' }, 'uncaught exception in main process')
    logger.flush(() => exit(1))
    // Transport worker may die before invoking the flush callback — hard bound.
    setTimeout(() => exit(1), FLUSH_EXIT_GRACE_MS).unref()
  }

  const onUnhandledRejection = (reason: unknown): void => {
    deps.getLogger().error(
      { err: asError(reason), event: 'process.unhandledRejection' },
      'unhandled promise rejection in main process'
    )
  }

  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)
  return () => {
    process.off('uncaughtException', onUncaughtException)
    process.off('unhandledRejection', onUnhandledRejection)
  }
}

function asError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  return new Error(`non-Error rejection: ${String(reason)}`)
}
