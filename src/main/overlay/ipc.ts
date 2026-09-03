/**
 * ipc.ts — overlay:* + the r2 test-hook handler factory (todo38).
 * Registration stays in src/main/ipc/handlers.ts (single IPC surface,
 * speech/ocr/mcp precedent); this module owns zod validation + delegation to
 * the OverlayController surface.
 *
 * Channel contract:
 *   overlay:frame:get  {}                 -> OverlayFrameReply   (renderer pull on mount)
 *   overlay:select     {rect,dataURL,prompt} -> OverlaySelectReply (crop confirmed)
 *   overlay:cancel     {}                 -> OverlayCancelReply  (Esc / stray click)
 *   __test.triggerHotkey {name:'screenshot'} -> TestTriggerHotkeyReply
 *     r2: globalShortcut presses cannot be synthesized from Playwright, so the
 *     e2e calls the hotkey ACTION through this channel. The handler itself is
 *     the gate: whenever app.isPackaged (index supplies testHooksEnabled=false)
 *     it answers {ok:false,error:'disabled'} — packaged builds get NOTHING.
 * MIT only, no AGPL.
 */
import {
  overlayCancelSchema,
  overlayFrameGetSchema,
  overlaySelectSchema,
  testTriggerHotkeySchema,
  validatePayload,
} from '../ipc/schemas'
import type { HandlerContext } from '../ipc/handlers'
import type {
  OverlayCancelReply,
  OverlayFrameReply,
  OverlaySelectReply,
  TestTriggerHotkeyReply,
} from '../ipc/whitelist'

/** The controller verbs the handlers need (tests substitute a fake surface).
 *  senderId = ctx.senderId (the calling frame's webContents id); the controller
 *  answers only for the LIVE overlay window — stale frames get no-overlay. */
export type OverlaySurface = {
  trigger(): Promise<TestTriggerHotkeyReply>
  getFrame(senderId?: number): OverlayFrameReply
  select(
    input: { rect: { x: number; y: number; width: number; height: number }; dataURL: string; prompt: string },
    senderId?: number,
  ): OverlaySelectReply
  cancel(senderId?: number): OverlayCancelReply
}

export type OverlayIpcDeps = {
  /** Lazy controller seam (index constructs after whenReady); absent = not-ready. */
  overlay: () => OverlaySurface | null
  /** !app.isPackaged gate for '__test.triggerHotkey' — false disables the hook. */
  testHooksEnabled: () => boolean
}

export type OverlayHandler = (args: unknown[], ctx: HandlerContext) => Promise<unknown>

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

export function createOverlayHandlers(deps: OverlayIpcDeps): Record<
  'overlay:frame:get' | 'overlay:select' | 'overlay:cancel' | '__test.triggerHotkey',
  OverlayHandler
> {
  return {
    'overlay:frame:get': async (args, ctx) => {
      const parsed = validatePayload(overlayFrameGetSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      const overlay = deps.overlay()
      if (overlay === null) return { ok: false, error: 'no-frame' } satisfies OverlayFrameReply
      return overlay.getFrame(ctx.senderId)
    },

    'overlay:select': async (args, ctx) => {
      const parsed = validatePayload(overlaySelectSchema, first(args))
      if (!parsed.ok) {
        const reply: OverlaySelectReply = { ok: false, error: 'invalid-payload', issues: parsed.issues }
        return reply
      }
      const overlay = deps.overlay()
      if (overlay === null) return { ok: false, error: 'no-overlay' } satisfies OverlaySelectReply
      return overlay.select(parsed.data, ctx.senderId)
    },

    'overlay:cancel': async (args, ctx) => {
      const parsed = validatePayload(overlayCancelSchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      const overlay = deps.overlay()
      if (overlay === null) return { ok: false, error: 'no-overlay' } satisfies OverlayCancelReply
      return overlay.cancel(ctx.senderId)
    },

    '__test.triggerHotkey': async (args) => {
      const parsed = validatePayload(testTriggerHotkeySchema, first(args))
      if (!parsed.ok) return parsed
      if (!deps.testHooksEnabled()) {
        const reply: TestTriggerHotkeyReply = { ok: false, error: 'disabled' }
        return reply
      }
      const overlay = deps.overlay()
      if (overlay === null) {
        const reply: TestTriggerHotkeyReply = { ok: false, error: 'capture-failed' }
        return reply
      }
      return overlay.trigger()
    },
  }
}
