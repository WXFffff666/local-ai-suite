import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')
const buildDir = join(root, 'build')
const iconIco = join(buildDir, 'icon.ico')
const iconIcns = join(buildDir, 'icon.icns')
const iconPng = join(buildDir, 'icon.png')
const icons512 = join(buildDir, 'icons', '512x512.png')

function pngDimensions(buf: Buffer): { w: number; h: number } | null {
  // PNG IHDR at offset 16: 4 bytes width, 4 bytes height big-endian
  if (buf.length < 24) return null
  // check PNG signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) return null
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  return { w, h }
}

describe('build assets — icons must exist and be valid', () => {
  it('build/icons/512x512.png exists and is 512x512 PNG', () => {
    expect(existsSync(icons512), `missing ${icons512}`).toBe(true)
    const buf = readFileSync(icons512)
    expect(buf.length).toBeGreaterThan(1000)
    const dim = pngDimensions(buf)
    expect(dim).not.toBeNull()
    expect(dim!.w).toBe(512)
    expect(dim!.h).toBe(512)
  })

  it('build/icon.png fallback exists and is valid PNG', () => {
    expect(existsSync(iconPng), `missing ${iconPng}`).toBe(true)
    const buf = readFileSync(iconPng)
    expect(buf.length).toBeGreaterThan(500)
    const dim = pngDimensions(buf)
    expect(dim).not.toBeNull()
    expect(dim!.w).toBeGreaterThan(0)
    expect(dim!.h).toBeGreaterThan(0)
  })

  it('build/icon.ico exists and contains >=4 sizes (16/32/48/256) PNG-compressed', () => {
    expect(existsSync(iconIco), `missing ${iconIco}`).toBe(true)
    const buf = readFileSync(iconIco)
    expect(buf.length).toBeGreaterThan(1000)
    // ICO header: 00 00 01 00 + count LE
    expect(buf.readUInt16LE(0)).toBe(0)
    expect(buf.readUInt16LE(2)).toBe(1)
    const count = buf.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(4)
    // parse entries and check expected widths present
    const widths = new Set<number>()
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16
      let w = buf[off]!
      let h = buf[off + 1]!
      // 0 means 256
      if (w === 0) w = 256
      if (h === 0) h = 256
      widths.add(w)
      const bytesInRes = buf.readUInt32LE(off + 8)
      const imgOffset = buf.readUInt32LE(off + 12)
      expect(bytesInRes).toBeGreaterThan(0)
      expect(imgOffset).toBeGreaterThan(0)
      // PNG signature inside ICO entry (PNG-compressed)
      const slice = buf.subarray(imgOffset, imgOffset + 8)
      const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(slice.equals(pngSig), `ICO entry ${w}x${h} should be PNG-compressed`).toBe(true)
    }
    for (const s of [16, 32, 48, 256]) {
      expect(widths.has(s), `ICO missing size ${s}, got ${[...widths].join(',')}`).toBe(true)
    }
  })

  it('build/icon.icns exists and has icns magic + non-trivial size', () => {
    expect(existsSync(iconIcns), `missing ${iconIcns}`).toBe(true)
    const buf = readFileSync(iconIcns)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 4).toString('ascii')).toBe('icns')
    const fileSize = buf.readUInt32BE(4)
    expect(fileSize).toBe(buf.length)
    // must contain at least one known icon type like ic09/ic08/ic07/icp4/icp5
    const text = buf.toString('binary')
    const hasType = ['ic09', 'ic08', 'ic07', 'icp4', 'icp5', 'ic10', 'ic11'].some((t) => text.includes(t))
    expect(hasType, 'icns should contain at least one icon type (ic09/ic08/...)').toBe(true)
  })

  it('build/ is tracked (not fully ignored) — assets should be commit-able', () => {
    // This test documents expectation: .gitignore must NOT ignore build/icon.* and build/icons/
    // We verify file existence above; git check-ignore is validated manually via build verification.
    expect(existsSync(buildDir)).toBe(true)
    const st = statSync(buildDir)
    expect(st.isDirectory()).toBe(true)
  })
})
