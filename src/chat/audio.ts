/**
 * audio.ts — todo36 renderer-side audio pipeline (pure core, jsdom-testable).
 *
 * The whisper.cpp server reads in-memory WAV natively (b4938 common-whisper.h
 * read_audio_data buffer overload) but NOTHING else without ffmpeg, so the
 * composer records webm/opus, decodes it through the Web Audio stack (injected
 * — jsdom has no AudioContext, MicButton wires the real one), and encodes
 * 16 kHz mono PCM16 WAV here. encodeWavMono16 is pure integer math: the unit
 * tests pin the header bytes, sample conversion and resampling lengths without
 * any browser API; the decode hop is e2e-only territory (documented limitation).
 */

/** Target format whisper expects (16 kHz mono PCM16 — whisper.cpp's native rate). */
export const WHISPER_SAMPLE_RATE = 16_000

export type AudioBufferLike = {
  sampleRate: number
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}

/** Injectable decode hop (real impl: OfflineAudioContext/AudioContext.decodeAudioData). */
export type WavDecoder = (bytes: ArrayBuffer) => Promise<AudioBufferLike>

/**
 * Browser seam for push-to-talk (todo36): getUserMedia + MediaRecorder +
 * blob→WAV. MicButton drives it; recorder.ts wires the real globals; tests
 * hand in fakes. (Defined here — beside the pipeline it feeds — so the
 * component, the wiring and the tests share one source of truth.)
 */
export type RecorderSurface = {
  getUserMedia: (constraints: { audio: boolean }) => Promise<MediaStream>
  createRecorder: (stream: MediaStream) => {
    start(): void
    stop(): void
    onData(cb: (chunk: Blob) => void): void
    onStop(cb: () => void): void
  }
  /** Blob → mono-16k WAV dataURL (real: Web Audio decode + pure encode). */
  toWavDataURL: (blob: Blob) => Promise<string>
}

/** Mix all channels to mono (mean), skipping silent padding honestly. */
export function mixDownToMono(buffer: AudioBufferLike): Float32Array {
  const n = buffer.length
  const out = new Float32Array(n)
  if (buffer.numberOfChannels <= 1) {
    out.set(buffer.getChannelData(0))
    return out
  }
  const gain = 1 / buffer.numberOfChannels
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < n; i += 1) out[i] += (data[i] ?? 0) * gain
  }
  return out
}

/** Linear-interpolation resample to `targetRate` (recorder output is 44.1/48k). */
export function resampleLinear(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate || samples.length === 0) return samples
  const outLength = Math.max(0, Math.round((samples.length * targetRate) / sourceRate))
  const out = new Float32Array(outLength)
  if (outLength === 0) return out
  const ratio = sourceRate / targetRate
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const frac = src - i0
    out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i1] ?? 0) * frac
  }
  return out
}

/** [-1,1] float → int16 with clipping (no wraparound). */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0
    const v = Math.max(-1, Math.min(1, Number.isFinite(s) ? s : 0))
    out[i] = Math.round(v < 0 ? v * 32_768 : v * 32_767)
  }
  return out
}

/** PCM16 mono WAV (44-byte canonical header + data chunk). */
export function encodeWavMono16(mono16: Int16Array, sampleRate = WHISPER_SAMPLE_RATE): Uint8Array {
  const bytesPerSample = 2
  const byteRate = sampleRate * bytesPerSample
  const dataSize = mono16.length * bytesPerSample
  const out = new Uint8Array(44 + dataSize)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)
  for (let i = 0; i < mono16.length; i += 1) view.setInt16(44 + i * 2, mono16[i] ?? 0, true)
  return out
}

/** Blob → decoded → 16k mono PCM16 WAV. */
export async function wavFromAudioBuffer(buffer: AudioBufferLike): Promise<Uint8Array> {
  const mono = mixDownToMono(buffer)
  const resampled = resampleLinear(mono, buffer.sampleRate, WHISPER_SAMPLE_RATE)
  return encodeWavMono16(floatToInt16(resampled), WHISPER_SAMPLE_RATE)
}

/** Uint8Array → base64 (btoa in chunks; recursion-safe on large files). */
export function bytesToBase64(bytes: Uint8Array): string {
  const CH = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CH) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + CH, bytes.length)))
  }
  return btoa(binary)
}

/** Recorder blob → 'data:audio/wav;base64,...' through the injected decoder. */
export async function blobToWavDataURL(blob: { arrayBuffer(): Promise<ArrayBuffer> }, decode: WavDecoder): Promise<string> {
  const decoded = await decode(await blob.arrayBuffer())
  const wav = await wavFromAudioBuffer(decoded)
  return `data:audio/wav;base64,${bytesToBase64(wav)}`
}
