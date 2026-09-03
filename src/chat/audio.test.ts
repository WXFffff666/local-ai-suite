/**
 * audio.test.ts — pure integer math of the PTT encode path (todo36). The Web
 * Audio decode hop is injected; jsdom/Chromium coverage of decodeAudioData is
 * documented as e2e-only. Given/When/Then per the testing contract.
 */
import { describe, expect, it } from 'vitest'

import {
  WHISPER_SAMPLE_RATE,
  blobToWavDataURL,
  bytesToBase64,
  encodeWavMono16,
  floatToInt16,
  mixDownToMono,
  resampleLinear,
  wavFromAudioBuffer,
  type AudioBufferLike,
} from './audio'

function fakeBuffer(sampleRate: number, channels: Float32Array[]): AudioBufferLike {
  const length = channels[0]?.length ?? 0
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length,
    getChannelData: (ch: number) => channels[ch] ?? new Float32Array(length),
  }
}

describe('mixDownToMono', () => {
  it('averages stereo channels', () => {
    const out = mixDownToMono(fakeBuffer(48_000, [new Float32Array([1, -1]), new Float32Array([0, 0])]))
    expect(Array.from(out)).toEqual([0.5, -0.5])
  })
  it('mono passes through', () => {
    const out = mixDownToMono(fakeBuffer(48_000, [new Float32Array([0.25, 0.75])]))
    expect(Array.from(out)).toEqual([0.25, 0.75])
  })
})

describe('resampleLinear', () => {
  it('same rate is identity', () => {
    const s = new Float32Array([0.1, 0.2, 0.3])
    expect(resampleLinear(s, 16_000, 16_000)).toBe(s)
  })
  it('48k -> 16k halves the length', () => {
    const s = new Float32Array(480)
    expect(resampleLinear(s, 48_000, 16_000).length).toBe(160)
  })
  it('interpolates between neighbours', () => {
    const out = resampleLinear(new Float32Array([0, 1]), 2, 4)
    expect(out.length).toBe(4)
    expect(out[1]).toBeCloseTo(0.5, 1)
  })
})

describe('floatToInt16', () => {
  it('clips at full scale without wraparound', () => {
    const out = floatToInt16(new Float32Array([2, -2, 0]))
    expect(out[0]).toBe(32_767)
    expect(out[1]).toBe(-32_768)
    expect(out[2]).toBe(0)
  })
  it('NaN becomes silence', () => {
    expect(floatToInt16(new Float32Array([Number.NaN]))[0]).toBe(0)
  })
})

describe('encodeWavMono16 — canonical 44-byte PCM16 header', () => {
  const wav = encodeWavMono16(new Int16Array([0, 1, -1]), 16_000)
  const view = new DataView(wav.buffer)
  const ascii = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n))

  it('RIFF/WAVE magic + fmt size', () => {
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint32(4, true)).toBe(36 + wav.length - 44)
  })
  it('PCM=1, mono=1, 16000 Hz, 32000 byteRate, blockAlign 2, bits 16', () => {
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(WHISPER_SAMPLE_RATE)
    expect(view.getUint32(28, true)).toBe(32_000)
    expect(view.getUint16(32, true)).toBe(2)
    expect(view.getUint16(34, true)).toBe(16)
  })
  it('data chunk little-endian int16 samples', () => {
    expect(ascii(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(1)
    expect(view.getInt16(48, true)).toBe(-1)
  })
})

describe('wavFromAudioBuffer + blobToWavDataURL (injected decode)', () => {
  it('48k stereo one-second buffer lands as 16k mono ~32000 samples', async () => {
    const ch = new Float32Array(48_000).fill(0.1)
    const wav = await wavFromAudioBuffer(fakeBuffer(48_000, [ch, ch]))
    // 16k mono: 16000 samples x 2 bytes + 44-byte header
    expect(wav.length).toBe(44 + 32_000)
  })
  it('blob pipeline produces a data:audio/wav;base64 URL that decodes back', async () => {
    const bytes = new Uint8Array([82, 73, 70, 70]) // "RIFF"
    const blob = { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }
    const decode = async (): Promise<AudioBufferLike> =>
      fakeBuffer(16_000, [new Float32Array([0, 0.5, -0.5])])
    const dataURL = await blobToWavDataURL(blob, decode)
    expect(dataURL.startsWith('data:audio/wav;base64,')).toBe(true)
    const back = Buffer.from(dataURL.slice('data:audio/wav;base64,'.length), 'base64')
    expect(back.length).toBe(44 + 6)
    expect(String.fromCharCode(...back.subarray(0, 4))).toBe('RIFF')
  })
  it('bytesToBase64 round-trips 100k bytes (chunked btoa)', () => {
    const big = new Uint8Array(100_000)
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256
    expect(Buffer.from(bytesToBase64(big), 'base64')).toEqual(Buffer.from(big))
  })
})
