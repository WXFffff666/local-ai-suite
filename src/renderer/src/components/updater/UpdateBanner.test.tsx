// @vitest-environment jsdom
/**
 * UpdateBanner.test.tsx — todo32 banner component test (jsdom, the
 * MarketPage.test.tsx convention: createRoot + act + fake window.api).
 *
 * Covers: available → 下载 button → invoke; downloading → progress bar
 * (indeterminate until a progress line with total>0 arrives); downloaded →
 * 安装（重启）; dismiss = session snooze (same version stays hidden, new
 * version re-surfaces); signature-graceful error = link ONLY (no action
 * buttons); plain error stays silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import UpdateBanner, {
  RELEASES_PAGE_URL,
  bannerReducer,
  snoozed,
  type BannerApi,
  type BannerView
} from './UpdateBanner'
import type { UpdateStateEvent } from '../../../../main/ipc/whitelist'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type FakeApi = BannerApi & {
  invoke: ReturnType<typeof vi.fn>
  emit: (s: UpdateStateEvent) => void
}

function makeFakeApi(): FakeApi {
  const listeners: Array<(s: UpdateStateEvent) => void> = []
  return {
    invoke: vi.fn(async () => ({ ok: true })),
    on: (_channel, listener) => {
      listeners.push(listener)
      return () => {
        const i = listeners.indexOf(listener)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    emit: (s) => {
      for (const l of listeners.slice()) l(s)
    }
  }
}

async function mount(api: FakeApi): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<UpdateBanner api={api} />)
  })
}

let container: HTMLDivElement
let root: Root

async function send(api: FakeApi, s: UpdateStateEvent): Promise<void> {
  await act(async () => {
    api.emit(s)
  })
}

function banner(): HTMLElement | null {
  return container.querySelector('.las-update-banner')
}

beforeEach(() => {
  snoozed.clear()
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

describe('offer flow: available → download → progress → downloaded → install', () => {
  it('available renders the version and a 下载 button that invokes the channel', async () => {
    const api = makeFakeApi()
    await mount(api)
    expect(banner()).toBeNull() // passive until an event arrives
    await send(api, { phase: 'available', version: '0.2.0' })
    expect(banner()?.textContent).toContain('0.2.0')
    const download = banner()?.querySelector('button.las-update-banner-action')
    expect(download?.textContent).toBe('下载')
    await act(async () => {
      ;(download as HTMLButtonElement)?.click()
    })
    expect(api.invoke).toHaveBeenCalledWith('update:downloadAndInstall')
  })

  it('downloading renders the market progress bar; a progress line fills it', async () => {
    const api = makeFakeApi()
    await mount(api)
    await send(api, { phase: 'available', version: '0.2.0' })
    await send(api, { phase: 'downloading', version: '0.2.0' })
    const bar = banner()?.querySelector('[role="progressbar"]')
    expect(bar).not.toBeNull()
    // total unknown at first → indeterminate class (market precedent)
    expect(bar?.className).toContain('las-market-job-bar-indeterminate')
    await send(api, { phase: 'progress', percent: 40, received: 4000, total: 10000 })
    const filled = banner()?.querySelector('[role="progressbar"]')
    expect(filled?.className).not.toContain('las-market-job-bar-indeterminate')
    expect(filled?.getAttribute('aria-valuenow')).toBe('4000')
    expect(filled?.querySelector('.las-market-job-bar-fill')?.getAttribute('style')).toContain('width: 40%')
  })

  it('downloaded swaps to 安装（重启）, invoking the same channel (main routes to quitAndInstall)', async () => {
    const api = makeFakeApi()
    await mount(api)
    await send(api, { phase: 'available', version: '0.2.0' })
    await send(api, { phase: 'downloaded', version: '0.2.0' })
    const install = banner()?.querySelector('.las-update-banner-install')
    expect(install?.textContent).toBe('安装（重启）')
    await act(async () => {
      ;(install as HTMLButtonElement)?.click()
    })
    expect(api.invoke).toHaveBeenCalledWith('update:downloadAndInstall')
  })
})

describe('dismiss = session snooze (in-memory)', () => {
  it('dismiss hides the banner; the same version stays hidden; a new version returns', async () => {
    const api = makeFakeApi()
    await mount(api)
    await send(api, { phase: 'available', version: '0.2.0' })
    await act(async () => {
      ;(banner()?.querySelector('.las-update-banner-dismiss') as HTMLButtonElement)?.click()
    })
    expect(banner()).toBeNull()
    await send(api, { phase: 'available', version: '0.2.0' })
    expect(banner()).toBeNull() // snoozed for the session
    await send(api, { phase: 'available', version: '0.3.0' })
    expect(banner()?.textContent).toContain('0.3.0')
  })
})

describe('signature-graceful mode (仅提示新版本)', () => {
  it('error with signatureUnavailable shows the manual link and NO action buttons', async () => {
    const api = makeFakeApi()
    await mount(api)
    await send(api, {
      phase: 'error',
      message: 'New version 0.2.0 is not signed by the application owner: ...',
      signatureUnavailable: true
    })
    const el = banner()
    expect(el?.getAttribute('data-phase')).toBe('signature-unavailable')
    expect(el?.querySelector('.las-update-banner-link')?.getAttribute('href')).toBe(RELEASES_PAGE_URL)
    expect(el?.querySelector('button.las-update-banner-action')).toBeNull()
    expect(el?.querySelector('.las-update-banner-install')).toBeNull()
  })

  it('graceful dismiss is sticky for the session too', async () => {
    const api = makeFakeApi()
    await mount(api)
    await send(api, { phase: 'error', message: 'publisherName mismatch', signatureUnavailable: true })
    await act(async () => {
      ;(banner()?.querySelector('.las-update-banner-dismiss') as HTMLButtonElement)?.click()
    })
    await send(api, { phase: 'error', message: 'publisherName mismatch', signatureUnavailable: true })
    expect(banner()).toBeNull()
  })

  it('plain error (network/ENOENT) never renders a banner', async () => {
    const api = makeFakeApi()
    await mount(api)
    await send(api, { phase: 'available', version: '0.2.0' })
    await send(api, { phase: 'error', message: 'ETIMEDOUT' })
    expect(banner()).toBeNull()
  })
})

describe('bannerReducer (pure)', () => {
  const hidden: BannerView = { kind: 'hidden' }
  it('checking keeps a live offer (re-check must not flicker the banner)', () => {
    const offer: BannerView = { kind: 'offer', version: '0.2.0' }
    const next = bannerReducer({ view: offer }, { type: 'event', event: { phase: 'checking' } })
    expect(next.view).toBe(offer)
  })
  it('progress without a live download is ignored', () => {
    const next = bannerReducer(
      { view: hidden },
      { type: 'event', event: { phase: 'progress', percent: 5, received: 5, total: 100 } }
    )
    expect(next.view).toBe(hidden)
  })
  it('payload without a phase bounces (shared-listener fakes)', () => {
    const next = bannerReducer({ view: hidden }, { type: 'event', event: { level: 'info' } as unknown as UpdateStateEvent })
    expect(next.view).toBe(hidden)
  })
})
