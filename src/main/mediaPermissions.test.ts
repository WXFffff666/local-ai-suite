/**
 * mediaPermissions.test.ts — W1-10→todo36 permission gate matrix. The old
 * baseline denied EVERYTHING; this proves the widen is exactly
 * media+audioCapture+app-origin and nothing else (geolocation must STAY
 * denied — plan acceptance criterion).
 */
import { describe, expect, it } from 'vitest'

import { canGrantMediaPermission, isTrustedAppOrigin, originFromDetails } from './mediaPermissions'

describe('isTrustedAppOrigin', () => {
  it('file:// (packaged loadFile) is trusted', () => {
    expect(isTrustedAppOrigin('file://')).toBe(true)
    expect(isTrustedAppOrigin('file:///D:/app/index.html')).toBe(true)
  })
  it('dev origin matches ELECTRON_RENDERER_URL only', () => {
    expect(isTrustedAppOrigin('http://127.0.0.1:5173', 'http://127.0.0.1:5173')).toBe(true)
    expect(isTrustedAppOrigin('http://127.0.0.1:9999', 'http://127.0.0.1:5173')).toBe(false)
    expect(isTrustedAppOrigin('http://127.0.0.1:5173', undefined)).toBe(false)
  })
  it('empty/undefined never trusted', () => {
    expect(isTrustedAppOrigin(undefined)).toBe(false)
    expect(isTrustedAppOrigin('')).toBe(false)
  })
})

describe('canGrantMediaPermission — selective allow matrix', () => {
  const dev = { rendererUrl: 'http://127.0.0.1:5173' }

  it('media + audioCapture + app origin -> ALLOW (the only yes)', () => {
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'http://127.0.0.1:5173', mediaTypes: ['audioCapture'], ...dev }),
    ).toBe(true)
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'file://', mediaTypes: ['audioCapture'] }),
    ).toBe(true)
  })

  it('geolocation from the SAME trusted origin stays DENIED (historical baseline pinned)', () => {
    expect(
      canGrantMediaPermission({ permission: 'geolocation', requestingOrigin: 'file://', ...dev }),
    ).toBe(false)
    expect(
      canGrantMediaPermission({ permission: 'geolocation', requestingOrigin: 'http://127.0.0.1:5173', ...dev }),
    ).toBe(false)
  })

  it('media from a foreign origin is DENIED', () => {
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'https://evil.example', mediaTypes: ['audioCapture'], ...dev }),
    ).toBe(false)
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'http://localhost:5173', mediaTypes: ['audioCapture'], ...dev }),
    ).toBe(false)
  })

  it('camera-only and display-capture media flavors are DENIED', () => {
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'file://', mediaTypes: ['videoCapture'] }),
    ).toBe(false)
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'file://', mediaTypes: ['audioCapture', 'displayMedia'] }),
    ).toBe(false)
    expect(
      canGrantMediaPermission({ permission: 'media', requestingOrigin: 'file://', mediaTypes: [] }),
    ).toBe(false)
  })

  it('other permissions (clipboard, notifications, …) DENIED regardless of origin', () => {
    for (const p of ['clipboard-sanitized-write', 'notifications', 'midiSysex', 'pointerLock', 'fullscreen']) {
      expect(canGrantMediaPermission({ permission: p, requestingOrigin: 'file://' })).toBe(false)
    }
  })
})

describe('originFromDetails — handler detail normalization', () => {
  it('check-handler string form, request-handler object form, junk -> undefined', () => {
    expect(originFromDetails('file://')).toBe('file://')
    expect(originFromDetails({ requestingOrigin: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5173')
    expect(originFromDetails({})).toBeUndefined()
    expect(originFromDetails(undefined)).toBeUndefined()
    expect(originFromDetails(42)).toBeUndefined()
  })
})
