/**
 * UpdateBanner.tsx — 自动更新提示条 (plan todo32, wave W5).
 *
 * App-level chrome mounted at the .las-shell root (top-right overlay). The
 * banner is PASSIVE: it never triggers a check itself — main pushes the
 * electron-updater state machine on 'update:state' (deferred 5s check /
 * manual 'update:check'), and the banner only reacts. Zero network from the
 * renderer (offline red line + the e2e zero-external-requests invariant).
 *
 * Visibility (plan):
 *  - offer / downloading / ready — the 下载 / 安装（重启） affordances;
 *  - 'error' + signatureUnavailable → 仅提示新版本 graceful mode (unsigned
 *    build; see the failure-string citations in src/main/updater.ts): manual
 *    release-page link, NO download/install buttons;
 *  - plain error / not-available → hidden (dev ENOENT must not nag);
 *  - dismiss = session snooze keyed by version, module-scope memory only —
 *    restart re-surfaces (no persistence, never a forced update).
 *
 * Progress bar reuses the market download-bar classes (las-market-job-bar /
 * -fill / -indeterminate): market.css loads app-wide because MarketPage is
 * statically imported in App.tsx, and the width/formatBytes pattern is the
 * exact DownloadJobList precedent (one-line reuse, zero new bar CSS).
 */
import { useEffect, useReducer } from 'react'
import { X } from 'lucide-react'
import type { UpdateStateEvent } from '../../../../main/ipc/whitelist'

import './updater.css'

/** Manual-download target for the signature-graceful mode. */
export const RELEASES_PAGE_URL = 'https://github.com/WXFffff666/local-ai-suite/releases'

/** Shared snooze key for the graceful mode (no actionable version on errors). */
export const GRACEFUL_SNOOZE_KEY = '***'

/** Session-snoozed keys (in-memory by design — a restart re-offers). */
export const snoozed = new Set<string>()

type ProgressSlice = { percent: number; received: number; total: number }

/** Derived banner view — pure reducer output, exhaustively matched below. */
export type BannerView =
  | { kind: 'hidden' }
  | { kind: 'offer'; version: string }
  | { kind: 'downloading'; version: string; progress: ProgressSlice | null }
  | { kind: 'ready'; version: string }
  | { kind: 'graceful' }

type BannerState = { view: BannerView }

type BannerAction = { type: 'event'; event: UpdateStateEvent } | { type: 'dismiss' }

/**
 * The one-state-machine reducer. Every UpdateStateEvent phase is named —
 * a new phase on the wire is a compile error here (exhaustive switch).
 */
export function bannerReducer(state: BannerState, action: BannerAction): BannerState {
  if (action.type === 'dismiss') return { view: { kind: 'hidden' } }
  const event = action.event
  // Runtime shape guard: the channel contract says UpdateStateEvent, but test
  // fakes / future wire drift share the same listener registry — a payload
  // without a phase must bounce, not poison the reducer state.
  if (event === null || typeof event !== 'object' || !('phase' in event)) return state
  switch (event.phase) {
    case 'checking':
      // a re-check never tears down a live offer; keep whatever is showing
      return state
    case 'available':
      return { view: { kind: 'offer', version: event.version } }
    case 'not-available':
      return { view: { kind: 'hidden' } }
    case 'downloading':
      return { view: { kind: 'downloading', version: event.version, progress: null } }
    case 'progress': {
      // progress lines are only meaningful under a live download
      if (state.view.kind !== 'downloading') return state
      return { view: { ...state.view, progress: { percent: event.percent, received: event.received, total: event.total } } }
    }
    case 'downloaded':
      return { view: { kind: 'ready', version: event.version } }
    case 'error':
      // graceful unsigned-build mode keeps a manual-link banner; every other
      // error (network, ENOENT app-update.yml, cancelled) stays silent.
      if (event.signatureUnavailable === true) return { view: { kind: 'graceful' } }
      return { view: { kind: 'hidden' } }
  }
  // Unreachable for the typed union (every phase returns above); belt for a
  // runtime phase value outside the contract — bounce instead of undefined.
  return state
}

/** The preload surface (structural so jsdom tests pass fakes). */
export type BannerApi = {
  invoke: (channel: 'update:downloadAndInstall', ...args: unknown[]) => Promise<unknown>
  on: (channel: 'update:state', listener: (state: UpdateStateEvent) => void) => () => void
}

export type UpdateBannerProps = {
  /** Test seam. Defaults to window.api; absent (plain browser) ⇒ inert null. */
  api?: BannerApi
}

/** Effective view after session snooze (hidden if the key is snoozed). */
export function visibleView(view: BannerView, snooze: ReadonlySet<string>): BannerView {
  switch (view.kind) {
    case 'hidden':
      return view
    case 'offer':
    case 'ready':
      return snooze.has(view.version) ? { kind: 'hidden' } : view
    case 'downloading':
      return snooze.has(view.version) ? { kind: 'hidden' } : view
    case 'graceful':
      return snooze.has(GRACEFUL_SNOOZE_KEY) ? { kind: 'hidden' } : view
  }
}

export function UpdateBanner({ api: apiProp }: UpdateBannerProps = {}): React.JSX.Element | null {
  const [state, dispatch] = useReducer(bannerReducer, { view: { kind: 'hidden' } as BannerView })
  const api = apiProp ?? (typeof window !== 'undefined' ? (window.api as unknown as BannerApi | undefined) : undefined)

  useEffect(() => {
    if (!api) return
    return api.on('update:state', (event) => {
      dispatch({ type: 'event', event })
    })
  }, [api])

  if (!api) return null
  const view = visibleView(state.view, snoozed)
  if (view.kind === 'hidden') return null

  const dismiss = (key: string): void => {
    snoozed.add(key)
    dispatch({ type: 'dismiss' })
  }
  const act = (): void => {
    void api.invoke('update:downloadAndInstall')
  }

  if (view.kind === 'graceful') {
    return (
      <div className="las-update-banner las-update-banner-graceful" role="status" data-phase="signature-unavailable">
        <BannerDismiss label="忽略此提示" onDismiss={() => dismiss(GRACEFUL_SNOOZE_KEY)} />
        <p className="las-update-banner-title">发现新版本 — 当前构建无法校验更新包签名，请手动下载</p>
        <a className="las-update-banner-link" href={RELEASES_PAGE_URL} target="_blank" rel="noreferrer">
          前往发布页手动下载
        </a>
      </div>
    )
  }

  return (
    <div className="las-update-banner" role="status" data-phase={view.kind}>
      <BannerDismiss label="忽略此版本" onDismiss={() => dismiss(view.version)} />
      <p className="las-update-banner-title">
        {view.kind === 'ready' ? `新版本 ${view.version} 已就绪` : `发现新版本 ${view.version}`}
      </p>
      {view.kind === 'downloading' ? <ProgressBar progress={view.progress} /> : null}
      {view.kind === 'offer' ? (
        <button type="button" className="las-update-banner-action" onClick={act}>
          下载
        </button>
      ) : null}
      {view.kind === 'ready' ? (
        <button type="button" className="las-update-banner-action las-update-banner-install" onClick={act}>
          安装（重启）
        </button>
      ) : null}
    </div>
  )
}

function BannerDismiss({ label, onDismiss }: { label: string; onDismiss: () => void }): React.JSX.Element {
  return (
    <button type="button" className="las-update-banner-dismiss" aria-label={label} onClick={onDismiss}>
      <X size={14} aria-hidden="true" />
    </button>
  )
}

/** Market-bar clone: known → width%, unknown (total=0) → indeterminate shimmer. */
export function ProgressBar({ progress }: { progress: ProgressSlice | null }): React.JSX.Element {
  const known = progress !== null && progress.total > 0
  const pct = known ? Math.min(100, Math.max(0, Math.round(progress.percent))) : 0
  return (
    <div
      className={`las-market-job-bar${!known ? ' las-market-job-bar-indeterminate' : ''}`}
      role="progressbar"
      aria-label="更新下载进度"
      aria-valuemin={0}
      aria-valuemax={known ? progress.total : undefined}
      aria-valuenow={known ? progress.received : 0}
    >
      <div className="las-market-job-bar-fill" style={known ? { width: `${pct}%` } : undefined} />
    </div>
  )
}

export default UpdateBanner
