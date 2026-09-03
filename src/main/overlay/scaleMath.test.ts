/**
 * scaleMath.test.ts — todo38 coordinate-conversion matrix (plan QA-fail
 * scenario: multi-display mapping incl. a NEGATIVE-origin secondary display).
 * Pure node env, no Electron, no mocks — the module is the unit under test.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_SELECT_CSS_PX,
  containsPoint,
  cssRectToPhysical,
  isMeaningfulSelection,
  normalizeDragRect,
  physicalSizeOf,
  pickDisplay,
  type DisplayGeom,
} from './scaleMath'

// ---------------------------------------------------------------------------
// fixtures — one primary 1920x1080 @0,0 plus secondaries RIGHT (positive) and
// LEFT (NEGATIVE bounds.x — the QA-pinned case) and a BELOW one.
// ---------------------------------------------------------------------------

const PRIMARY_100: DisplayGeom = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
const LEFT_125: DisplayGeom = { id: 2, bounds: { x: -1536, y: -100, width: 1536, height: 864 }, scaleFactor: 1.25 }
const RIGHT_150: DisplayGeom = { id: 3, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }
const DISPLAYS = [PRIMARY_100, LEFT_125, RIGHT_150]

// ---------------------------------------------------------------------------
// physicalSizeOf — thumbnailSize to request from desktopCapturer
// ---------------------------------------------------------------------------

describe('physicalSizeOf', () => {
  it.each([
    ['100% 1920x1080', PRIMARY_100, { width: 1920, height: 1080 }],
    ['125% 1536x864', LEFT_125, { width: 1920, height: 1080 }],
    ['150% 2560x1440', RIGHT_150, { width: 3840, height: 2160 }],
  ] as const)('%s → %j', (_name, display, expected) => {
    expect(physicalSizeOf(display)).toEqual(expected)
  })

  it('rounds fractional products (3333 DIP @1.25 = 4166.25 → 4166)', () => {
    const d: DisplayGeom = { id: 9, bounds: { x: 0, y: 0, width: 3333, height: 1 }, scaleFactor: 1.25 }
    expect(physicalSizeOf(d).width).toBe(4166)
  })
})

// ---------------------------------------------------------------------------
// pickDisplay — containment first, nearest-gap fallback, negative origins
// ---------------------------------------------------------------------------

describe('pickDisplay', () => {
  it('cursor inside a positive-bounds primary → primary', () => {
    expect(pickDisplay(DISPLAYS, { x: 900, y: 500 })?.id).toBe(1)
  })

  it('cursor inside a NEGATIVE-bounds secondary (x=-1000,y=0) → that display, not the primary', () => {
    expect(pickDisplay(DISPLAYS, { x: -1000, y: 0 })?.id).toBe(2)
  })

  it('far edge is exclusive: x=1920 leaves the primary, lands on the 150% right display', () => {
    expect(pickDisplay(DISPLAYS, { x: 1920, y: 500 })?.id).toBe(3)
  })

  it('gap point (x=1800,y=500): nearer primary than right display by edge gap', () => {
    // 1800 is INSIDE the primary (bounds 0..1920) — containment wins outright.
    expect(pickDisplay(DISPLAYS, { x: 1800, y: 500 })?.id).toBe(1)
  })

  it('no containment → nearest by rectangle gap (point above-right of the primary)', () => {
    // (1500, -500): gap to primary = 500 (dy only); gap to LEFT_125 alone
    // covers 1500 DIP horizontally — the primary wins on rect distance.
    expect(pickDisplay(DISPLAYS, { x: 1500, y: -500 })?.id).toBe(1)
  })

  it('far above everything picks the display with the least vertical overhang', () => {
    // LEFT_125 reaches y=-100; at y=-5000, x=900 its rect is (dx=900,dy=4900)
    // — closer than the primary's (dx=0, dy=5000). Distance, not center, decides.
    expect(pickDisplay(DISPLAYS, { x: 900, y: -5000 })?.id).toBe(2)
  })

  it('negative-bounds display is nearest when the cursor sits just left of it', () => {
    // gap to LEFT_125 (-1536..0) at x=-2000 = 464 DIP; gap to primary = 2000.
    expect(pickDisplay(DISPLAYS, { x: -2000, y: 400 })?.id).toBe(2)
  })

  it('empty display list → null (defensive headless edge)', () => {
    expect(pickDisplay([], { x: 0, y: 0 })).toBeNull()
  })

  it('containsPoint half-open far edge: x=bounds.width is OUTSIDE', () => {
    expect(containsPoint(PRIMARY_100.bounds, { x: 1920, y: 0 })).toBe(false)
    expect(containsPoint(PRIMARY_100.bounds, { x: 1919.9, y: 1079.9 })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeDragRect / isMeaningfulSelection — renderer-side gate, shared code
// ---------------------------------------------------------------------------

describe('normalizeDragRect', () => {
  it('bottom-right drag passes through, top-left drag flips to positive extent', () => {
    const down = normalizeDragRect({ x: 30, y: 40 }, { x: 130, y: 140 }, { width: 800, height: 600 })
    const up = normalizeDragRect({ x: 130, y: 140 }, { x: 30, y: 40 }, { width: 800, height: 600 })
    expect(down).toEqual({ x: 30, y: 40, width: 100, height: 100 })
    expect(up).toEqual(down)
  })

  it('clamps out-of-display coordinates to the display size', () => {
    const r = normalizeDragRect({ x: 780, y: 580 }, { x: 9999, y: 9999 }, { width: 800, height: 600 })
    expect(r).toEqual({ x: 780, y: 580, width: 20, height: 20 })
  })
})

describe('isMeaningfulSelection', () => {
  it(`accepts sides exactly ${MIN_SELECT_CSS_PX}px, rejects smaller (stray click → cancel)`, () => {
    expect(isMeaningfulSelection({ x: 0, y: 0, width: 10, height: 10 })).toBe(true)
    expect(isMeaningfulSelection({ x: 0, y: 0, width: 9.5, height: 10 })).toBe(false)
    expect(isMeaningfulSelection({ x: 0, y: 0, width: 10, height: 1 })).toBe(false)
    expect(MIN_SELECT_CSS_PX).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// cssRectToPhysical — THE scale matrix (100/125/150%) + clamping + edges
// ---------------------------------------------------------------------------

describe('cssRectToPhysical', () => {
  it('100%: identity mapping', () => {
    expect(cssRectToPhysical({ x: 100, y: 200, width: 300, height: 400 }, 1, { width: 1920, height: 1080 })).toEqual({
      x: 100,
      y: 200,
      width: 300,
      height: 400,
    })
  })

  it('125%: floor(origin)/ceil(extent) keeps every intended source pixel (25 DIP = 31.25 → 2 rows, no pixel shaved)', () => {
    // x=20 DIP → phys 25; width 25 DIP → extent (20+25)*1.25=56.25 → 56 vs 57 ceil.
    const r = cssRectToPhysical({ x: 20, y: 0, width: 25, height: 25 }, 1.25, { width: 1920, height: 1080 })
    expect(r).toEqual({ x: 25, y: 0, width: 32, height: 32 })
  })

  it('150%: 100x50 CSS at (40,60) → 150x75 at (60,90)', () => {
    expect(cssRectToPhysical({ x: 40, y: 60, width: 100, height: 50 }, 1.5, { width: 3840, height: 2160 })).toEqual({
      x: 60,
      y: 90,
      width: 150,
      height: 75,
    })
  })

  it('negative-bounds secondary display: the rect is DISPLAY-RELATIVE, so the crop maps identically at 125% even though the display origin is x=-1536', () => {
    const phys = physicalSizeOf(LEFT_125)
    const r = cssRectToPhysical({ x: 500, y: 20, width: 100, height: 40 }, LEFT_125.scaleFactor, phys)
    expect(phys).toEqual({ width: 1920, height: 1080 })
    expect(r).toEqual({ x: 625, y: 25, width: 125, height: 50 })
  })

  it('clamps a rect running off the physical frame edge to the frame size', () => {
    const r = cssRectToPhysical({ x: 1800, y: 1000, width: 500, height: 500 }, 1, { width: 1920, height: 1080 })
    expect(r).toEqual({ x: 1800, y: 1000, width: 120, height: 80 })
  })

  it('fully outside → null (zero area after clamping), never an inverted rect', () => {
    expect(cssRectToPhysical({ x: 5000, y: 5000, width: 100, height: 100 }, 1, { width: 1920, height: 1080 })).toBeNull()
    expect(cssRectToPhysical({ x: 10, y: 10, width: 0, height: 50 }, 1, { width: 100, height: 100 })).toBeNull()
  })

  it('garbage inputs → null: NaN, negative scale, non-finite physical size', () => {
    expect(cssRectToPhysical({ x: Number.NaN, y: 0, width: 10, height: 10 }, 1, { width: 100, height: 100 })).toBeNull()
    expect(cssRectToPhysical({ x: 0, y: 0, width: 10, height: 10 }, -1, { width: 100, height: 100 })).toBeNull()
    expect(cssRectToPhysical({ x: 0, y: 0, width: 10, height: 10 }, 1, { width: 0, height: 100 })).toBeNull()
  })

  it('sub-pixel selection at 150% still yields ≥1 phys px (6px CSS → 9px phys)', () => {
    const r = cssRectToPhysical({ x: 0, y: 0, width: 6, height: 6 }, 1.5, { width: 1000, height: 1000 })
    expect(r).toEqual({ x: 0, y: 0, width: 9, height: 9 })
  })
})
