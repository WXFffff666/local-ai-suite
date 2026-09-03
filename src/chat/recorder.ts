/**
 * recorder.ts — default RecorderSurface for push-to-talk (todo36, extracted
 * from MicButton so the component stays a state machine). Wraps the three
 * browser globals (getUserMedia / MediaRecorder / AudioContext.decodeAudioData)
 * behind the seam the component tests fake. Web Audio decode is the only hop
 * that jsdom cannot exercise — the encode math beside it is pinned pure in
 * audio.test.ts; this wiring itself is e2e-only territory (documented).
 */
import { blobToWavDataURL, type RecorderSurface, type WavDecoder } from './audio'

function createWebAudioDecoder(): WavDecoder {
  return async (bytes) => {
    const Ctor: typeof AudioContext = window.AudioContext
    const ctx = new Ctor()
    try {
      return await ctx.decodeAudioData(bytes)
    } finally {
      void ctx.close()
    }
  }
}

/** null when the environment lacks any of the media APIs (plain browser preview, old Electron). */
export function defaultRecorderSurface(): RecorderSurface | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return null
  const nav = navigator as Navigator
  if (!nav.mediaDevices?.getUserMedia) return null
  const decode = createWebAudioDecoder()
  return {
    getUserMedia: (constraints) => nav.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream) => {
      const MR: typeof MediaRecorder = window.MediaRecorder
      const rec = new MR(stream, { mimeType: 'audio/webm' })
      return {
        start: () => rec.start(),
        stop: () => rec.stop(),
        onData: (cb) => {
          rec.ondataavailable = (e: BlobEvent) => {
            if (e.data.size > 0) cb(e.data)
          }
        },
        onStop: (cb) => {
          rec.onstop = () => cb()
        },
      }
    },
    toWavDataURL: (blob) => blobToWavDataURL(blob, decode),
  }
}
