import type { WindowApi } from './index'
import type {
  AllowedChannel,
  AllowedEventChannel,
  AgentEventEvent,
  AgentTermEvent,
  AppNotificationEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  DownloadProgressEvent,
  EnginesGpuDownloadReply,
  EnginesProgressEvent,
  EnginesStatusReply,
  EventPayloads,
  ImageQueueStatusEvent,
  ModelsLaunchReply,
  // todo32: auto-update wire contracts
  UpdateStateEvent,
  UpdateCheckReply,
  UpdateDownloadInstallReply,
  // todo36: speech (whisper push-to-talk) wire contracts
  SpeechStatusReply,
  SpeechPickModelReply,
  SpeechSaveWavReply,
  SpeechTranscribeReply,
  SpeechEngineSource,
  // todo37: local OCR (PaddleOCR-json pipe-mode sidecar) wire contracts
  OcrStatusReply,
  OcrInstallReply,
  OcrRecognizeReply,
  OcrProgressEvent,
  OcrProgressState,
  OcrEngineSource
} from '../main/ipc/whitelist'

declare global {
  interface Window {
    api: WindowApi
  }
}

// Renderer-side re-exports: import event payload shapes from here
// (`import type { ChatDeltaEvent } from '@preload/index'`-style or relative)
// instead of reaching into src/main.
export type {
  WindowApi,
  AllowedChannel,
  AllowedEventChannel,
  EventPayloads,
  ChatDeltaEvent,
  ChatDoneEvent,
  ChatErrorEvent,
  DownloadProgressEvent,
  ImageQueueStatusEvent,
  AppNotificationEvent,
  AgentEventEvent,
  AgentTermEvent,
  // todo30b: engine status / GPU pack download wire contracts
  EnginesStatusReply,
  EnginesProgressEvent,
  EnginesGpuDownloadReply,
  ModelsLaunchReply,
  // todo32: auto-update wire contracts
  UpdateStateEvent,
  UpdateCheckReply,
  UpdateDownloadInstallReply,
  // todo36: speech (whisper push-to-talk) wire contracts
  SpeechStatusReply,
  SpeechPickModelReply,
  SpeechSaveWavReply,
  SpeechTranscribeReply,
  SpeechEngineSource,
  // todo37: local OCR (PaddleOCR-json pipe-mode sidecar) wire contracts
  OcrStatusReply,
  OcrInstallReply,
  OcrRecognizeReply,
  OcrProgressEvent,
  OcrProgressState,
  OcrEngineSource
}
