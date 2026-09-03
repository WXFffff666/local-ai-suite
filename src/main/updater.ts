/**
 * updater.ts — electron-updater wiring (plan todo32, wave W5).
 *
 * Staged auto-update: GitHub provider draft releases (electron-builder.yml
 * publish block: releaseType draft + publishAutoUpdate true + stagingPercentage
 * 10). The updater module is the ONLY place that touches electron-updater;
 * everything the renderer sees is the closed UpdateStateEvent union in
 * ipc/whitelist.ts, fanned out on the 'update:state' event channel.
 *
 * Policy (plan-mandated):
 *  - autoDownload=false — bytes move only after an explicit user gesture.
 *  - autoInstallOnAppQuit=true — a downloaded update lands on next quit.
 *  - allowDowngrade=false — channel switches never walk a machine backwards.
 *  - channel defaults to 'latest'; env override exists for the prerelease+
 *    beta fallback (SPIKE-PENDING below).
 *  - Never a forced update: quitAndInstall fires ONLY from the banner button
 *    ('update:downloadAndInstall' while phase 'downloaded').
 *
 * ---------------------------------------------------------------------------
 * SPIKE-PENDING-FINAL: draft-release visibility & stagingPercentage with the
 * github provider must be asserted at tag v0.1.0 during FINAL delivery
 * (plan R3b: electron-updater × GitHub DRAFT visibility = UNKNOWN). Fallback
 * decision tree:
 *   1. draft NOT client-visible  -> switch feed to prerelease + set
 *      LAS_UPDATE_CHANNEL=beta (channel override below) per plan R3b;
 *   2. stagingPercentage ignored -> latest.yml metadata is provider-agnostic
 *      (Appendix A row 32); if the field is absent from the published yml,
 *      fix electron-builder.yml publish block (yml edit, no code change).
 * Until that spike runs, this file ships the 'latest' channel and the
 * unsigned-build graceful mode; nothing here assumes draft visibility.
 * ---------------------------------------------------------------------------
 *
 * Unsigned-build graceful mode ("仅提示新版本"): the real electron-updater
 * failure strings on Windows code-signature verification (v6.8.9 source):
 *  - NsisUpdater.js: `New version ${v} is not signed by the application
 *    owner: ${status}` (code ERR_UPDATER_INVALID_SIGNATURE)
 *  - windowsExecutableCodeSignatureVerifier.js: `Sign verification failed,
 *    installer signed with incorrect certificate: ...` and the
 *    `publisherNames: ...` payload it embeds.
 * Dev/unsigned launches additionally fail earlier with missing
 * `app-update.yml` (ENOENT) — that path is NOT signature-related and stays a
 * plain error state (banner silent). When the message matches the
 * signature/publisher/certificate family we set signatureUnavailable so the
 * banner offers the manual release-page link instead of install buttons.
 */

import { autoUpdater } from 'electron-updater'
import type { UpdateCheckReply, UpdateDownloadInstallReply, UpdateStateEvent } from './ipc/whitelist'

/** Initial post-launch check defer (plan: 延迟检查). Exported for tests. */
export const UPDATE_CHECK_INITIAL_DELAY_MS = 5_000

/** env override for the prerelease/beta fallback (SPIKE-PENDING decision 1). */
export const UPDATE_CHANNEL_ENV = 'LAS_UPDATE_CHANNEL'

/**
 * Signature-verification failure detector. Matches ONLY the electron-updater
 * strings cited above (case-insensitive): "not signed", "signature",
 * "publisherName", "certificate". Deliberately does NOT match generic ENOENT
 * /network errors — those stay plain 'error' states with no banner.
 */
export function isSignatureUnavailable(message: string): boolean {
  return /not signed|signature|publisherName|certificate/i.test(message)
}

/** The minimal logger surface we need (pino Logger satisfies it structurally). */
export type UpdaterLog = {
  info(obj: unknown, msg: string): void
  warn(obj: unknown, msg: string): void
  error(obj: unknown, msg: string): void
}

const NOOP_LOG: UpdaterLog = { info: () => undefined, warn: () => undefined, error: () => undefined }

/**
 * Minimal structural views of electron-updater payload shapes. The real
 * classes come from builder-util-runtime, which pnpm keeps un-hoisted under
 * the electron-updater package (not importable from src). These mirrors carry
 * only the fields this module reads; electron-updater's real event payloads
 * are width-supersets, so the `on(...)` listener wiring below type-checks
 * against the real AppUpdater overload set via the AutoUpdaterLike seam.
 */
export type UpdateInfoLike = { version: string }
export type ProgressInfoLike = { percent: number; transferred: number; total: number }

/**
 * Structural view of electron-updater's AutoUpdater (the singleton import is
 * the prod default; tests vi.mock the module and pass the fake through deps).
 */
export type AutoUpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  channel: string | null
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'update-not-available', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'download-progress', listener: (info: ProgressInfoLike) => void): unknown
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type UpdaterDeps = {
  emit: (state: UpdateStateEvent) => void
  log?: UpdaterLog
  env?: Record<string, string | undefined>
  /** injectable for tests; prod binds the electron-updater singleton. */
  updater?: AutoUpdaterLike
}

/** The IPC-facing surface (handlers.ts consumes this via the deps seam). */
export type Updater = {
  /** Fire-and-forget kick; the outcome streams on 'update:state' events. */
  check(): UpdateCheckReply
  /** Phase-routed: available→download, downloaded→install-on-quit-restart. */
  downloadAndInstall(): UpdateDownloadInstallReply
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const updater = deps.updater ?? autoUpdater
  const log = deps.log ?? NOOP_LOG
  const env = deps.env ?? process.env

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  updater.allowDowngrade = false
  // channel is set BEFORE allowDowngrade re-assertion: electron-updater flips
  // allowDowngrade=true when a non-default channel is assigned (its setter
  // doc), so pin the policy again after.
  const channel = env[UPDATE_CHANNEL_ENV] ?? 'latest'
  updater.channel = channel
  updater.allowDowngrade = false

  /** last observed update target (banner + downloadAndInstall routing). */
  let availableVersion: string | null = null
  let downloaded = false
  /** the error instance already dispatched through the 'error' event, so the
   * rejected checkForUpdates()/downloadUpdate() promise never double-emits. */
  let lastDispatchedError: unknown = null

  const emitError = (error: unknown): UpdateStateEvent => {
    const message = error instanceof Error ? error.message : String(error)
    const signatureUnavailable = isSignatureUnavailable(message)
    const state: UpdateStateEvent = {
      phase: 'error',
      message,
      ...(signatureUnavailable ? { signatureUnavailable: true } : {}),
    }
    lastDispatchedError = error
    log.error({ err: error, signatureUnavailable }, 'updater error')
    deps.emit(state)
    return state
  }

  updater.on('checking-for-update', () => {
    deps.emit({ phase: 'checking' })
  })
  updater.on('update-available', (info: UpdateInfoLike) => {
    availableVersion = info.version
    downloaded = false
    deps.emit({ phase: 'available', version: info.version })
  })
  updater.on('update-not-available', () => {
    availableVersion = null
    downloaded = false
    deps.emit({ phase: 'not-available' })
  })
  updater.on('download-progress', (info: ProgressInfoLike) => {
    deps.emit({ phase: 'progress', percent: info.percent, received: info.transferred, total: info.total })
  })
  updater.on('update-downloaded', (info: UpdateInfoLike) => {
    downloaded = true
    availableVersion = info.version
    deps.emit({ phase: 'downloaded', version: info.version })
  })
  updater.on('error', (error: Error) => {
    emitError(error)
  })

  return {
    // Kick a check. 'checking' itself comes from the library's own
    // 'checking-for-update' event (fired synchronously inside
    // checkForUpdates()), so no manual emit here — one source per phase.
    // electron-updater ALSO dispatches 'error' for async failures, so the
    // catch re-emits only when the rejection was not already delivered
    // through the event (identity dedupe).
    check(): UpdateCheckReply {
      void updater.checkForUpdates().catch((error: unknown) => {
        if (error === lastDispatchedError) return
        emitError(error)
      })
      return { ok: true }
    },
    downloadAndInstall(): UpdateDownloadInstallReply {
      if (downloaded) {
        // Explicit user gesture only (no forced update — plan Must-NOT).
        // quitAndInstall closes windows and relaunches; errors still route
        // through the 'error' listener.
        log.info({ version: availableVersion }, 'updater: quitAndInstall (user gesture)')
        updater.quitAndInstall(false, true)
        return { ok: true, action: 'installing' }
      }
      if (availableVersion === null) {
        // No check result in flight: honest invalid-state, no guess.
        log.warn({}, 'updater: downloadAndInstall without an available update')
        return { ok: false, error: 'invalid-state' }
      }
      deps.emit({ phase: 'downloading', version: availableVersion })
      void updater.downloadUpdate().catch((error: unknown) => {
        if (error === lastDispatchedError) return
        emitError(error)
      })
      return { ok: true, action: 'downloading' }
    },
  }
}

/**
 * Schedule the deferred post-launch check (plan: 启动后延迟检查). A throw from
 * `schedule` (non-electron env) is swallowed by design: the user can still
 * invoke update:check manually; auto-update is best-effort UX, never critical
 * path. Returns whether a check was scheduled (test/evidence hook).
 */
export function scheduleInitialUpdateCheck(opts: {
  check: () => void
  disabled?: boolean
  delayMs?: number
  /** schedule seam: setTimeout in prod, fake timers/assertions in tests. */
  schedule?: (fn: () => void, ms: number) => unknown
}): boolean {
  if (opts.disabled === true) return false
  const delayMs = opts.delayMs ?? UPDATE_CHECK_INITIAL_DELAY_MS
  const schedule = opts.schedule ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
  try {
    schedule(() => opts.check(), delayMs)
    return true
  } catch {
    return false
  }
}
