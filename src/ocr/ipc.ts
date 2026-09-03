/**
 * ipc.ts — ocr:* handler factories (todo37). Registration stays in
 * src/main/ipc/handlers.ts (single IPC surface, speech/ipc precedent); this
 * module owns validation + engine/service side effects.
 *
 * Channel contract:
 *   ocr:status     {}                         -> OcrStatusReply   (spawn-free, download-free)
 *   ocr:install    {}                         -> OcrInstallReply  (ack; outcome streams 'ocr:progress')
 *   ocr:recognize  {dataURL | galleryId}      -> OcrRecognizeReply
 *
 * recognize accepts exactly one image source:
 *  - dataURL: chat message image (todo21 data-URL wire contract) → base64 →
 *    engine image_base64 key (zero temp files, protocol-verified);
 *  - galleryId: re-resolved MAIN-side through the Gallery registry
 *    (get → sanitized containment), then the engine's image_path key —
 *    the renderer can never steer the engine at arbitrary paths.
 */

import { existsSync, statSync } from 'fs'

import {
  ocrInstallSchema,
  ocrRecognizeSchema,
  ocrStatusSchema,
  validatePayload,
  type OcrRecognizeInput,
} from '../main/ipc/schemas'
import type { HandlerContext } from '../main/ipc/handlers'
import type {
  OcrInstallReply,
  OcrProgressEvent,
  OcrRecognizeReply,
  OcrStatusReply,
} from '../main/ipc/whitelist'
import type { GalleryItem } from '../gallery/gallery'
import type { OcrService } from './service'

/** Decoded image ceiling on ocr:recognize dataURL (32 MiB, chat images are ≪). */
export const OCR_IMAGE_MAX_BYTES = 32 * 1024 * 1024

export type OcrGallerySurface = {
  get(id: string): GalleryItem
}

export type OcrIpcDeps = {
  /** ocr engine owner; injected (tests) or the lazy main-process singleton. */
  service: () => OcrService
  gallery: () => OcrGallerySurface
}

export type OcrHandler = (args: unknown[], ctx: HandlerContext) => Promise<unknown>

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

/** strip "data:image/...;base64," → raw base64 (engine wants no prefix). */
export function dataUrlToBase64(dataURL: string): string {
  const comma = dataURL.indexOf(',')
  return comma >= 0 ? dataURL.slice(comma + 1) : dataURL
}

export function createOcrHandlers(deps: OcrIpcDeps): Record<
  'ocr:status' | 'ocr:install' | 'ocr:recognize',
  OcrHandler
> {
  const service = () => deps.service()
  let installing = false

  const buildStatus = (): OcrStatusReply => {
    const st = service().status()
    return {
      ok: true,
      supported: st.supported,
      engine: { bin: st.engine.bin, source: st.engine.source, version: st.engine.version },
      running: st.running,
    }
  }

  return {
    'ocr:status': async (args) => {
      const parsed = validatePayload(ocrStatusSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      return buildStatus()
    },

    'ocr:install': async (args, ctx) => {
      const parsed = validatePayload(ocrInstallSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      const st = service().status()
      if (!st.supported) {
        const reply: OcrInstallReply = { ok: false, error: 'engine-unsupported-platform' }
        return reply
      }
      if (st.engine.source === 'pack') {
        // already installed: re-install would clobber a live pack — UI says 已安装.
        const reply: OcrInstallReply = { ok: false, error: 'already-installed' }
        return reply
      }
      if (installing) {
        const reply: OcrInstallReply = { ok: false, error: 'already-downloading' }
        return reply
      }
      installing = true
      const emit = (state: OcrProgressEvent['state'], received = 0, total = 0, note?: string): void => {
        const event: OcrProgressEvent = { state, received, total, ...(note === undefined ? {} : { note }) }
        ctx.send('ocr:progress', event)
      }
      void service()
        .install((p) => emit(p.stage, p.downloaded, p.total ?? 0))
        .then((outcome) => {
          installing = false
          if (outcome.ok) emit('done')
          else if (outcome.reason === 'sha256-mismatch') emit('quarantined', 0, 0, '引擎包损坏，已隔离')
          else emit('error', 0, 0, outcome.reason ?? 'install-failed')
        })
        .catch((error: unknown) => {
          installing = false
          emit('error', 0, 0, error instanceof Error ? error.message : String(error))
        })
      const ack: OcrInstallReply = { ok: true }
      return ack
    },

    'ocr:recognize': async (args) => {
      const parsed = validatePayload(ocrRecognizeSchema, first(args))
      if (!parsed.ok) return parsed
      const input = parsed.data as OcrRecognizeInput
      const st = service().status()
      if (!st.supported) {
        const reply: OcrRecognizeReply = { ok: false, error: 'engine-unsupported-platform' }
        return reply
      }
      try {
        let text: string
        if (input.dataURL !== undefined) {
          const b64 = dataUrlToBase64(input.dataURL)
          if (Buffer.byteLength(b64, 'base64') > OCR_IMAGE_MAX_BYTES) {
            const reply: OcrRecognizeReply = { ok: false, error: 'image-too-large' }
            return reply
          }
          text = await service().recognize({ imageBase64: b64 })
        } else {
          // galleryId → MAIN-resolved canonical path (sanitize + containment
          // inside Gallery.get); renderer never supplies filesystem paths.
          let item: GalleryItem
          try {
            item = deps.gallery().get(String(input.galleryId))
          } catch {
            const reply: OcrRecognizeReply = { ok: false, error: 'gallery-item-not-found' }
            return reply
          }
          if (!existsSync(item.originalPath) || !statSync(item.originalPath).isFile()) {
            const reply: OcrRecognizeReply = { ok: false, error: 'gallery-item-not-found' }
            return reply
          }
          text = await service().recognize({ imagePath: item.originalPath })
        }
        const reply: OcrRecognizeReply = { ok: true, text }
        return reply
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const code = detail.includes('engine binary not found')
          ? 'engine-missing'
          : detail.includes('pinned sha256')
            ? 'engine-tampered'
            : 'recognize-failed'
        const reply: OcrRecognizeReply = { ok: false, error: code, detail }
        return reply
      }
    },
  }
}
