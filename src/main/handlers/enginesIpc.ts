/**
 * Engines + launch IPC handler factories (todo30b) — implementation half of the
 * engines:status / engines:gpuDownload / models:launch channels. handlers.ts
 * stays registration-only (same split as imageOps.ts / clearCache.ts).
 *
 * Policies are NOT here: the detection-first cascade, sha256 verification and
 * pack activation live in src/engines/** (unit-tested there). This file only
 * (a) reads the resolver availability matrix + nvidia probe + manifest summary
 * for the settings UI, (b) single-flights GPU pack downloads and streams
 * gpuPack progress onto the 'engines:progress' event with terminal
 * done/quarantined/error states, and (c) wraps the services.launchModel hop
 * (21→30) so its throws never cross the IPC wire.
 */

import type { DownloadPackOptions, DownloadPackResult, NvidiaInfo } from '../../engines/gpuPack'
import type { EngineManifest, ManifestEngineKey, ManifestLoad } from '../../engines/manifest'
import type { ResolvedEngine } from '../../engines/resolver'
import type { EngineProgressState, EngineStatusEntry, EnginesGpuDownloadReply, EnginesManifestSummary, EnginesProgressEvent, EnginesStatusReply, GpuPackEngineWireKey, ModelsLaunchReply, NvidiaSummaryWire } from '../ipc/whitelist'
import {
  enginesGpuDownloadSchema,
  enginesStatusSchema,
  modelsLaunchSchema,
  validatePayload,
} from '../ipc/schemas'
import type { HandlerContext, IpcHandler } from '../ipc/handlers'
import type { Services } from '../services'

/** Injected engines surface (defaults bind the real modules in handlers.ts). */
export type EnginesDeps = {
  detectNvidia: () => Promise<NvidiaInfo>
  loadEngineManifest: () => ManifestLoad
  downloadPack: (opts: DownloadPackOptions) => Promise<DownloadPackResult>
}

/** The container slice these handlers consult (structural; real Services fits). */
export type EnginesServices = Pick<Services, 'userDataDir' | 'engineResolver' | 'getEngineResolutions' | 'launchModel'>

// Compile-time wire-alignment proofs: the self-contained whitelist mirrors must
// stay structurally compatible with the real engines types (same convention as
// CHAT_CONTENT_WIRE_ALIGNED in schemas.ts). Direction: the REAL types must be
// assignable to the WIRE types — live resolver/gpuPack values go straight into
// the replies, so any drift is a compile error, not a runtime surprise.
export const RESOLVED_ENGINE_WIRE_ALIGNED: ResolvedEngine extends EngineStatusEntry ? true : never = true
export const GPU_ENGINE_KEYS_WIRE_ALIGNED: ManifestEngineKey extends GpuPackEngineWireKey
  ? GpuPackEngineWireKey extends ManifestEngineKey
    ? true
    : never
  : never = true
export const NVIDIA_WIRE_ALIGNED: NvidiaInfo extends NvidiaSummaryWire ? true : never = true

/** ManifestLoad -> UI summary (present/generatedAt + downloadable variants). */
export function summarizeManifest(load: ManifestLoad): EnginesManifestSummary {
  if (load.status !== 'ok') return { present: false, generatedAt: null, variants: {} }
  const variants: Partial<Record<GpuPackEngineWireKey, string[]>> = {}
  const enginesOf: EngineManifest['engines'] = load.manifest.engines
  for (const [key, spec] of Object.entries(enginesOf) as [
    ManifestEngineKey,
    EngineManifest['engines'][ManifestEngineKey],
  ][]) {
    const names = Object.keys(spec?.gpu ?? {})
    if (names.length > 0) variants[key as GpuPackEngineWireKey] = names
  }
  return { present: true, generatedAt: load.manifest.generated_at, variants }
}

export type EnginesHandlerMap = {
  'engines:status': IpcHandler
  'engines:gpuDownload': IpcHandler
  'models:launch': IpcHandler
}

export function createEnginesHandlers(services: EnginesServices, engines: EnginesDeps): EnginesHandlerMap {
  /** in-flight GPU downloads keyed `${engine}:${variant}` (single-flight per pack). */
  const gpuDownloadsInFlight = new Set<string>()

  const enginesStatus: IpcHandler = async (args) => {
    const parsed = validatePayload(enginesStatusSchema, args.length > 0 ? args[0] : {})
    if (!parsed.ok) return parsed
    // Fresh matrix: invalidate() first so a just-activated GPU pack (or a
    // manually-installed PATH binary) is reflected immediately. A disabled
    // resolver (explicit null) falls back to the last-spawn outcomes.
    const resolver = services.engineResolver
    let resolutions: ResolvedEngine[]
    if (resolver !== null) {
      resolver.invalidate()
      resolutions = await resolver.availability()
    } else {
      resolutions = services.getEngineResolutions()
    }
    const nvidia = await engines.detectNvidia().catch(() => null)
    const reply: EnginesStatusReply = {
      ok: true,
      platform: process.platform,
      resolutions,
      nvidia,
      manifest: summarizeManifest(engines.loadEngineManifest()),
    }
    return reply
  }

  const enginesGpuDownload: IpcHandler = async (args, ctx: HandlerContext) => {
    const parsed = validatePayload(enginesGpuDownloadSchema, args[0])
    if (!parsed.ok) return parsed
    const load = engines.loadEngineManifest()
    if (load.status !== 'ok') {
      const reply: EnginesGpuDownloadReply = { ok: false, error: 'manifest-missing' }
      return reply
    }
    const { engine, variant } = parsed.data
    if (load.manifest.engines[engine]?.gpu?.[variant] === undefined) {
      const reply: EnginesGpuDownloadReply = { ok: false, error: 'unknown-variant' }
      return reply
    }
    const key = `${engine}:${variant}`
    if (gpuDownloadsInFlight.has(key)) {
      const reply: EnginesGpuDownloadReply = { ok: false, error: 'already-downloading' }
      return reply
    }
    gpuDownloadsInFlight.add(key)
    let received = 0
    let total = 0
    const emit = (state: EngineProgressState, note?: string): void => {
      const event: EnginesProgressEvent = {
        engine,
        variant,
        received,
        total,
        state,
        ...(note === undefined ? {} : { note }),
      }
      ctx.send('engines:progress', event)
    }
    // Fire-and-track: the {ok:true} ack means "started"; every later outcome
    // (progress, terminal done/quarantined/error) streams on engines:progress.
    void engines
      .downloadPack({
        engine,
        variant,
        manifest: load.manifest,
        userDataDir: services.userDataDir,
        onProgress: (p) => {
          received = p.downloaded
          total = p.total ?? 0
          emit(p.stage)
        },
      })
      .then((result) => {
        if (result.ok) {
          emit('done')
          services.engineResolver?.invalidate()
        } else if (result.reason === 'sha256-mismatch') {
          // plan QA-fail: the corrupted pack was quarantined; the resolver
          // keeps the verified CPU binary. The UI toasts this note verbatim.
          emit('quarantined', 'GPU 包损坏，已回退 CPU')
        } else {
          emit('error', result.reason)
        }
      })
      .catch((error: unknown) => {
        emit('error', error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        gpuDownloadsInFlight.delete(key)
      })
    const ack: EnginesGpuDownloadReply = { ok: true }
    return ack
  }

  // Registry-driven llama relaunch with paired mmproj: the 21→30 wired hop.
  // Any services-side throw (not found / corrupted / non-gguf) is surfaced as
  // {ok:false,error} — the wire never carries a rejection.
  const modelsLaunch: IpcHandler = async (args) => {
    const parsed = validatePayload(modelsLaunchSchema, args[0])
    if (!parsed.ok) return parsed
    try {
      const status = await services.launchModel(parsed.data.modelId)
      const reply: ModelsLaunchReply = { ok: true, status }
      return reply
    } catch (error) {
      const reply: ModelsLaunchReply = { ok: false, error: error instanceof Error ? error.message : String(error) }
      return reply
    }
  }

  return {
    'engines:status': enginesStatus,
    'engines:gpuDownload': enginesGpuDownload,
    'models:launch': modelsLaunch,
  }
}
