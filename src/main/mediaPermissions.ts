/**
 * mediaPermissions.ts — W1-10 hardening for todo36 (mic).
 *
 * src/main/index.ts used to deny EVERY permission request outright. Push-to-
 * talk needs getUserMedia({audio}) in the main window, so the deny-all becomes
 * a pure decision function (unit-tested matrix) with the narrowest possible
 * allow: the 'media' permission, audio-capture only, requested from the app's
 * OWN origin (dev VITE url or packaged file://). Everything else — geolocation,
 * clipboard, notifications, display-capture, any foreign origin — keeps the
 * historical deny (the security baseline audit trail must not silently widen).
 */

export type MediaPermissionDecision = {
  permission: string
  requestingOrigin: string | undefined
  /** details.mediaTypes for 'media' ('audioCapture' | 'videoCapture' | 'audioLoopback'...). */
  mediaTypes?: readonly string[]
  /** process.env.ELECTRON_RENDERER_URL (dev server url) when present. */
  rendererUrl?: string | undefined
}

/** The only Chromium permission string we ever consider granting. */
export const ALLOWED_PERMISSION = 'media'
/** Screen/share flavors stay denied — todo38 owns display-capture explicitly. */
const DENIED_MEDIA_TYPES = ['desktopVideoCapturer', 'displayMedia', 'loopbackMedia', 'audioLoopback'] as const

/**
 * Electron hands the check-handler a plain string and the request-handler a
 * details object (union-typed); normalize both to an origin string.
 */
export function originFromDetails(details: unknown): string | undefined {
  if (typeof details === 'string') return details
  if (typeof details === 'object' && details !== null) {
    const o = details as { requestingOrigin?: unknown }
    return typeof o.requestingOrigin === 'string' ? o.requestingOrigin : undefined
  }
  return undefined
}

export function isTrustedAppOrigin(origin: string | undefined, rendererUrl?: string): boolean {
  if (origin === undefined || origin === '') return false
  // packaged main window loads via loadFile → file:// origin
  if (origin === 'file://' || origin.startsWith('file://')) return true
  if (rendererUrl) {
    try {
      return new URL(rendererUrl).origin === new URL(origin).origin
    } catch {
      return false
    }
  }
  return false
}

export function canGrantMediaPermission(d: MediaPermissionDecision): boolean {
  if (d.permission !== ALLOWED_PERMISSION) return false
  if (!isTrustedAppOrigin(d.requestingOrigin, d.rendererUrl)) return false
  const types = d.mediaTypes
  if (types === undefined) {
    // setPermissionCheckHandler calls without mediaTypes: allow the generic
    // 'media' check ONLY for the trusted origin (getUserMedia still crosses
    // the request handler with concrete mediaTypes before any capture).
    return true
  }
  if (types.some((t) => (DENIED_MEDIA_TYPES as readonly string[]).includes(t))) return false
  return types.includes('audioCapture')
}
