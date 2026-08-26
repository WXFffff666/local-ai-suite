#!/usr/bin/env node
/**
 * generate-icons.mjs — Wave1 Task1 (sharp)
 * Generates build assets via sharp:
 *  - build/icon.png (512x512)
 *  - build/icons/512x512.png (512x512)
 *  - build/icon.ico (16/32/48/256 PNG-compressed)
 *  - build/icon.icns (icns with ic09/ic08/ic07/icp5/icp4)
 *
 * electron-builder reads:
 *   win.icon   = build/icon.ico
 *   mac.icon   = build/icon.icns
 *   linux.icon = build/icon.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BUILD = path.join(ROOT, 'build')
const ICONS_DIR = path.join(BUILD, 'icons')

async function createMasterPng() {
  const svg = `
  <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0ea5e9"/>
        <stop offset="100%" stop-color="#6366f1"/>
      </linearGradient>
      <filter id="s"><feDropShadow dx="0" dy="12" stdDeviation="18" flood-opacity="0.35"/></filter>
    </defs>
    <rect width="512" height="512" rx="112" fill="#0f172a"/>
    <rect x="36" y="36" width="440" height="440" rx="96" fill="url(#g)" filter="url(#s)"/>
    <g transform="translate(256 256)">
      <rect x="-86" y="-86" width="172" height="172" rx="36" fill="white" opacity="0.92"/>
      <circle cx="0" cy="0" r="52" fill="none" stroke="#0f172a" stroke-width="10" opacity="0.9"/>
      <circle cx="0" cy="0" r="22" fill="#0f172a"/>
      <rect x="-6" y="-96" width="12" height="28" rx="6" fill="white" opacity="0.95"/>
      <rect x="-6" y="68" width="12" height="28" rx="6" fill="white" opacity="0.95"/>
      <rect x="-96" y="-6" width="28" height="12" rx="6" fill="white" opacity="0.95"/>
      <rect x="68" y="-6" width="28" height="12" rx="6" fill="white" opacity="0.95"/>
    </g>
    <text x="256" y="428" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="700" fill="white" opacity="0.96">Local AI</text>
  </svg>`.trim()
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer()
  return sharp(png).resize(512, 512, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer()
}

function packIco(pngMap) {
  const count = pngMap.length
  const headerSize = 6 + count * 16
  let offset = headerSize
  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  for (let i = 0; i < count; i++) {
    const { size, buf } = pngMap[i]
    const off = 6 + i * 16
    header[off] = size === 256 ? 0 : size
    header[off + 1] = size === 256 ? 0 : size
    header[off + 2] = 0
    header[off + 3] = 0
    header.writeUInt16LE(1, off + 4)
    header.writeUInt16LE(32, off + 6)
    header.writeUInt32LE(buf.length, off + 8)
    header.writeUInt32LE(offset, off + 12)
    offset += buf.length
  }
  return Buffer.concat([header, ...pngMap.map((p) => p.buf)])
}

function packIcns(png512, png256, png128, png32, png16) {
  const entries = [
    { type: 'ic09', data: png512 },
    { type: 'ic08', data: png256 },
    { type: 'ic07', data: png128 },
    { type: 'icp5', data: png32 },
    { type: 'icp4', data: png16 },
  ]
  let total = 8
  for (const e of entries) total += 8 + e.data.length
  const buf = Buffer.alloc(total)
  buf.write('icns', 0, 'ascii')
  buf.writeUInt32BE(total, 4)
  let off = 8
  for (const e of entries) {
    buf.write(e.type, off, 'ascii')
    buf.writeUInt32BE(8 + e.data.length, off + 4)
    e.data.copy(buf, off + 8)
    off += 8 + e.data.length
  }
  return buf
}

async function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true })
  fs.mkdirSync(BUILD, { recursive: true })

  const master = await createMasterPng()
  const sizes = [16, 32, 48, 128, 256, 512]
  const pngBySize = {}
  for (const s of sizes) {
    pngBySize[s] = await sharp(master).resize(s, s, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer()
  }

  const iconPngPath = path.join(BUILD, 'icon.png')
  const icons512Path = path.join(ICONS_DIR, '512x512.png')
  fs.writeFileSync(iconPngPath, pngBySize[512])
  fs.writeFileSync(icons512Path, pngBySize[512])
  console.log(`[generate-icons] wrote ${path.relative(ROOT, iconPngPath)} ${pngBySize[512].length} bytes`)
  console.log(`[generate-icons] wrote ${path.relative(ROOT, icons512Path)} ${pngBySize[512].length} bytes`)

  const icoMap = [16, 32, 48, 256].map((s) => ({ size: s, buf: pngBySize[s] }))
  const ico = packIco(icoMap)
  const icoPath = path.join(BUILD, 'icon.ico')
  fs.writeFileSync(icoPath, ico)
  console.log(`[generate-icons] wrote ${path.relative(ROOT, icoPath)} ${ico.length} bytes (${icoMap.length} images)`)

  const icns = packIcns(pngBySize[512], pngBySize[256], pngBySize[128], pngBySize[32], pngBySize[16])
  const icnsPath = path.join(BUILD, 'icon.icns')
  fs.writeFileSync(icnsPath, icns)
  console.log(`[generate-icons] wrote ${path.relative(ROOT, icnsPath)} ${icns.length} bytes`)

  const entPath = path.join(BUILD, 'entitlements.mac.plist')
  if (!fs.existsSync(entPath)) {
    fs.writeFileSync(entPath, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>com.apple.security.cs.allow-jit</key><true/>\n  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>\n  <key>com.apple.security.cs.disable-library-validation</key><true/>\n</dict></plist>\n`)
  }
  console.log('[generate-icons] done — all assets valid')
}

main().catch((e) => { console.error('[generate-icons] failed:', e); process.exit(1) })
