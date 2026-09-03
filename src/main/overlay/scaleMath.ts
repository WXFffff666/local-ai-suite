/**
 * scaleMath.ts — pure display/coordinate math for the screenshot ask-overlay
 * (todo38). ZERO Electron imports: the main controller uses it for display
 * picking + desktopCapturer thumbnail sizing, and the overlay renderer imports
 * THE SAME module (additive tsconfig.web include, whitelist.ts precedent) to
 * map its rubber-band CSS-px selection onto physical frame pixels for the
 * <canvas> crop. One implementation, one rounding policy, unit-tested here
 * against the 100% / 125% / 150% matrix and negative-bounds secondary displays
 * (plan QA failure scenario: 多显示器坐标换算/负坐标屏).
 *
 * Coordinate spaces:
 *  - DIP ("CSS px"): Electron window/screen coordinates; a secondary display
 *    left of the primary has NEGATIVE bounds.x. Overlay windows are sized to a
 *    display's DIP bounds, so pointer events inside one are display-RELATIVE
 *    (origin 0,0 = that display's top-left — negative bounds never reach the
 *    crop math, only display PICKING).
 *  - physical px: frame pixels of the desktopCapturer image, per convention
 *    physical = round(DIP * scaleFactor) (display.physicalSize is reported
 *    untrustworthy across platforms; bounds*scale is what the thumbnail we
 *    REQUEST is sized by, so it is what comes BACK).
 * MIT only, no AGPL.
 */

/** Rubber-band minimum side in CSS px; anything smaller is a stray click → cancel. */
export const MIN_SELECT_CSS_PX = 10

/** Display-rect origin corner in DIP space (Electron Display.bounds). */
export type CssBounds = { x: number; y: number; width: number; height: number }

/** Minimal structural view of Electron's Display (tests pass literals). */
export type DisplayGeom = {
  id: number
  bounds: CssBounds
  scaleFactor: number
}

/** Pointer position in absolute DIP screen coordinates. */
export type ScreenPoint = { x: number; y: number }

/** Rectangle in CSS px, display-RELATIVE (0,0 = overlay/display top-left). */
export type CssRect = { x: number; y: number; width: number; height: number }

/** Rectangle in physical frame pixels (desktopCapturer image space). */
export type PhysicalRect = CssRect

export function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0
}

/** Physical frame size to REQUEST from desktopCapturer for a display. */
export function physicalSizeOf(display: DisplayGeom): { width: number; height: number } {
  return {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
  }
}

/** True iff the absolute DIP point falls inside the display bounds (half-open on the far edge, matching Electron). */
export function containsPoint(bounds: CssBounds, p: ScreenPoint): boolean {
  return p.x >= bounds.x && p.x < bounds.x + bounds.width && p.y >= bounds.y && p.y < bounds.y + bounds.height
}

function centerDistanceSq(bounds: CssBounds, p: ScreenPoint): number {
  // Distance from the point to the bounds RECT (not its center): 0 inside,
  // gap-to-edge outside — the same tie-break geometry Electron's
  // getDisplayNearestPoint documents ("nearest" = smallest gap).
  const dx = Math.max(bounds.x - p.x, 0, p.x - (bounds.x + bounds.width))
  const dy = Math.max(bounds.y - p.y, 0, p.y - (bounds.y + bounds.height))
  return dx * dx + dy * dy
}

/**
 * Display under the cursor; containment wins, otherwise the display whose
 * bounds rectangle is nearest (negative-origin secondary displays included).
 * Stable: ties resolve to the first candidate, like the caller's array order.
 * Returns null for an empty display list (defensive headless edge).
 */
export function pickDisplay<T extends DisplayGeom>(displays: readonly T[], cursor: ScreenPoint): T | null {
  const inside = displays.find((d) => containsPoint(d.bounds, cursor))
  if (inside !== undefined) return inside
  let best: T | null = null
  let bestD = Number.POSITIVE_INFINITY
  for (const d of displays) {
    const dist = centerDistanceSq(d.bounds, cursor)
    if (dist < bestD) {
      bestD = dist
      best = d
    }
  }
  return best
}

/**
 * Normalize a two-pointer-point drag (start/current, DIP, display-relative)
 * into a non-negative CSS rect clamped to the display's DIP size.
 */
export function normalizeDragRect(
  start: ScreenPoint,
  end: ScreenPoint,
  display: { width: number; height: number },
): CssRect {
  const x = Math.max(0, Math.min(start.x, end.x))
  const y = Math.max(0, Math.min(start.y, end.y))
  const right = Math.min(display.width, Math.max(start.x, end.x))
  const bottom = Math.min(display.height, Math.max(start.y, end.y))
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

/** True iff a CSS rect is big enough to be a real selection. */
export function isMeaningfulSelection(rect: CssRect): boolean {
  return rect.width >= MIN_SELECT_CSS_PX && rect.height >= MIN_SELECT_CSS_PX
}

/**
 * Map a display-relative CSS rect onto physical frame pixels.
 * Edges use floor(origin)/ceil(end) so no intended source pixel is dropped by
 * rounding at non-integer scales (125%: 25 CSS px = 31.25 phys → 31..32);
 * the result is clamped into [0, physicalSize]. Returns null when the rect
 * collapses (clamped to zero area) or its inputs are non-finite — a null is a
 * cancel path, never a half-open crop.
 */
export function cssRectToPhysical(
  rect: CssRect,
  scale: number,
  physical: { width: number; height: number },
): PhysicalRect | null {
  if (!Number.isFinite(scale) || scale <= 0) return null
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null
  if (rect.width <= 0 || rect.height <= 0) return null
  if (!isPositiveFinite(physical.width) || !isPositiveFinite(physical.height)) return null

  const x0 = Math.min(Math.max(Math.floor(rect.x * scale), 0), physical.width)
  const y0 = Math.min(Math.max(Math.floor(rect.y * scale), 0), physical.height)
  const x1 = Math.min(Math.max(Math.ceil((rect.x + rect.width) * scale), 0), physical.width)
  const y1 = Math.min(Math.max(Math.ceil((rect.y + rect.height) * scale), 0), physical.height)
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
