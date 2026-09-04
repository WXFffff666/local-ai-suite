/**
 * ipc.ts — quickask:* handler factory (todo41).
 * Registration stays in src/main/ipc/handlers.ts (overlay/speech/ocr precedent);
 * this module owns zod validation, the SHARED ask path, and the controller verbs.
 *
 * THE SHARED ASK FUNCTION: ChatRelay.start IS the ask path — chat:send calls it
 * with the chat:* event names, quickask:call calls the SAME relay with a
 * channel-remapping send wrapper (chat:delta→quickask:delta, chat:done→
 * quickask:done, chat:error→quickask:error). One zod gate (chatSendSchema),
 * one upstream arbitration rule, one SSE pump; zero duplicated relay logic. The
 * remap exists so the mini window's listeners can never cross-talk with the
 * main window's chat store (both subscribe by event id; channel separation
 * makes the two UIs independently testable).
 *
 * Channel contract:
 *   quickask:ask        ChatSendInput        -> relay ack {ok,id,streaming}  (this frame only)
 *   quickask:hide       {}                   -> QuickAskHideReply            (sender-guarded)
 *   quickask:prefill:get {}                  -> QuickAskPrefillReply         (sender-guarded pull)
 *   __test.triggerHotkey {name:'quickask'}   -> TestTriggerHotkeyReply
 *     same r2 !app.isPackaged gate as todo38 — packaged builds get 'disabled'.
 * MIT only, no AGPL.
 */
import { chatSendSchema, quickAskEmptySchema, testTriggerHotkeySchema, validatePayload } from '../ipc/schemas'
import type { HandlerContext } from '../ipc/handlers'
import type { ChatRelay } from '../ipc/chatRelay'
import type { IpcSendFn, QuickAskAskReply, QuickAskHideReply, QuickAskPrefillReply, TestTriggerHotkeyReply } from '../ipc/whitelist'
import type { QuickAskController } from './controller'

export type QuickAskIpcDeps = {
  /** Lazy controller seam (index constructs after whenReady); absent = not ready. */
  quickask: () => QuickAskController | null
  /** The SAME ChatRelay instance chat:send uses — the shared upstream path. */
  relay: Pick<ChatRelay, 'start'>
  /** !app.isPackaged gate for '__test.triggerHotkey' — false disables the hook. */
  testHooksEnabled: () => boolean
}

export type QuickAskHandler = (args: unknown[], ctx: HandlerContext) => Promise<unknown>

/** chat:delta/done/error → quickask:delta/done/error (the ONE remap table). */
const CHAT_TO_QUICKASK = {
  'chat:delta': 'quickask:delta',
  'chat:done': 'quickask:done',
  'chat:error': 'quickask:error',
} as const

function first(args: unknown[]): unknown {
  return args.length > 0 ? args[0] : undefined
}

/** Wrap a frame-bound send so the relay's chat:* emissions arrive re-labeled.
 *  Non-stream channels cannot occur (relay only emits the three) — passthrough
 *  keeps the wrapper total without inventing failures. */
export function remapStreamSend(send: IpcSendFn): IpcSendFn {
  return (channel, payload) => {
    const remapped = channel in CHAT_TO_QUICKASK ? CHAT_TO_QUICKASK[channel as keyof typeof CHAT_TO_QUICKASK] : channel
    send(remapped, payload)
  }
}

export function createQuickAskHandlers(deps: QuickAskIpcDeps): Record<
  'quickask:ask' | 'quickask:hide' | 'quickask:prefill:get' | '__test.triggerHotkey',
  QuickAskHandler
> {
  return {
    'quickask:ask': async (args, ctx) => {
      const parsed = validatePayload(chatSendSchema, first(args))
      if (!parsed.ok) return parsed
      // Shared ask: identical relay semantics to chat:send, deltas re-labeled
      // to quickask:* and delivered to THIS frame only (ctx.send contract).
      return deps.relay.start(parsed.data, remapStreamSend(ctx.send)) satisfies QuickAskAskReply
    },

    'quickask:hide': async (args, ctx) => {
      const parsed = validatePayload(quickAskEmptySchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      const quickask = deps.quickask()
      if (quickask === null) return { ok: false, error: 'no-window' } satisfies QuickAskHideReply
      return quickask.hide(ctx.senderId)
    },

    'quickask:prefill:get': async (args, ctx) => {
      const parsed = validatePayload(quickAskEmptySchema, first(args) ?? {})
      if (!parsed.ok) return parsed
      const quickask = deps.quickask()
      if (quickask === null) return { ok: false, error: 'no-window' } satisfies QuickAskPrefillReply
      return quickask.getPrefill(ctx.senderId)
    },

    '__test.triggerHotkey': async (args) => {
      const parsed = validatePayload(testTriggerHotkeySchema, first(args))
      if (!parsed.ok) return parsed
      if (!deps.testHooksEnabled()) {
        const reply: TestTriggerHotkeyReply = { ok: false, error: 'disabled' }
        return reply
      }
      const quickask = deps.quickask()
      if (quickask === null) {
        const reply: TestTriggerHotkeyReply = { ok: false, error: 'create-failed' }
        return reply
      }
      return quickask.trigger()
    },
  }
}
