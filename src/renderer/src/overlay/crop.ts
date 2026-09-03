/**
 * crop.ts — the todo38 overlay renderer's canvas crop (sharp is a DEV-only
 * dependency, so the proven path is the plan's: crop IN the overlay via
 * <canvas>). The source frame is the physical-resolution desktopCapturer
 * image; the CSS-px selection maps through the SAME scaleMath the main
 * process uses (src/main/overlay/scaleMath.ts, additive tsconfig.web include)
 * — one rounding policy, one clamp rule, unit-tested on the node side.
 *
 * Size fit: the chat:send gate (src/main/ipc/schemas.ts) rejects >4MiB decoded
 * images, so an oversize crop walks down the [png, jpeg@full, jpeg@½, jpeg@¼]
 * ladder and only then reports crop-too-large (honest cancel, never a silent
 * relay rejection). MAX_DATA_URL_CHARS mirrors the 6,000,000-char zod cap with
 * margin — the zod gate stays the final trust boundary.
 */
import { cssRectToPhysical, type CssRect } from '../../../main/overlay/scaleMath'
import type { OverlayDisplayInfo } from '../../../main/ipc/whitelist'

export const MAX_DATA_URL_CHARS = 5_900_000

export class CropTooLargeError extends Error {
  constructor() {
    super('crop-too-large')
    this.name = 'CropTooLargeError'
  }
}

function loadImage(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('frame-decode-failed'))
    img.src = dataURL
  })
}

function encode(img: HTMLImageElement, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number, mime: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('canvas-2d-unavailable')
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh)
  return canvas.toDataURL(mime)
}

/**
 * Crop the selection out of the frame image. Returns a PNG (or downscaled
 * JPEG when the PNG busts the chat gate) dataURL sized in DEVICE pixels.
 */
export async function cropFrameToPng(dataURL: string, rect: CssRect, display: OverlayDisplayInfo): Promise<string> {
  const phys = cssRectToPhysical(rect, display.scale, { width: display.physicalWidth, height: display.physicalHeight })
  if (phys === null) throw new Error('empty-selection')
  const img = await loadImage(dataURL)
  // Map the requested physical frame coords onto the image's REAL pixels —
  // identical in production (thumbnailSize was requested at physical size),
  // a shrink factor under the e2e fake capturer (1x1 frame).
  const rx = img.naturalWidth / display.physicalWidth
  const ry = img.naturalHeight / display.physicalHeight
  const sx = phys.x * rx
  const sy = phys.y * ry
  const sw = phys.width * rx
  const sh = phys.height * ry
  const candidates: ReadonlyArray<{ scale: number; mime: string }> = [
    { scale: 1, mime: 'image/png' },
    { scale: 1, mime: 'image/jpeg' },
    { scale: 0.5, mime: 'image/jpeg' },
    { scale: 0.25, mime: 'image/jpeg' },
  ]
  for (const c of candidates) {
    const out = encode(img, sx, sy, sw, sh, Math.max(1, Math.round(phys.width * c.scale)), Math.max(1, Math.round(phys.height * c.scale)), c.mime)
    if (out.length <= MAX_DATA_URL_CHARS) return out
  }
  throw new CropTooLargeError()
}
