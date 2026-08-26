import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')
const ymlPath = join(root, 'electron-builder.yml')
const pkgPath = join(root, 'package.json')
const buildDir = join(root, 'build')

describe('builder config — P0 wire builder', () => {
  it('electron-builder.yml exists and defines required build icons', () => {
    expect(existsSync(ymlPath), `missing ${ymlPath}`).toBe(true)
    const yml = readFileSync(ymlPath, 'utf8')

    // productName MUST NOT be overridden — preserve original
    expect(yml).toMatch(/productName:\s*Local AI Suite/)
    expect(yml).toMatch(/appId:\s*com\.localaisuite\.app/)

    // directories.buildResources = build
    expect(yml).toMatch(/directories:\s*\n\s*output:\s*release\s*\n\s*buildResources:\s*build/)

    // build.win.icon = build/icon.ico
    expect(yml).toMatch(/win:\s*\n[\s\S]*?icon:\s*build\/icon\.ico/)

    // build.mac.icon = build/icon.icns
    expect(yml).toMatch(/mac:\s*\n[\s\S]*?icon:\s*build\/icon\.icns/)

    // build.linux.icon = build/icons/512x512.png  (NOT build/icon.png)
    expect(yml).toMatch(/linux:\s*\n[\s\S]*?icon:\s*build\/icons\/512x512\.png/)
    expect(yml, 'linux icon must NOT be build/icon.png').not.toMatch(/linux:\s*\n[\s\S]*?icon:\s*build\/icon\.png\s*\n/)
  })

  it('icon files exist on disk and are non-empty — validates path existence', () => {
    const icons = [
      join(buildDir, 'icon.ico'),
      join(buildDir, 'icon.icns'),
      join(buildDir, 'icons', '512x512.png'),
    ]
    for (const p of icons) {
      expect(existsSync(p), `missing icon ${p}`).toBe(true)
      const st = statSync(p)
      expect(st.isFile(), `${p} should be a file`).toBe(true)
      expect(st.size, `${p} should be non-empty`).toBeGreaterThan(1000)
    }
    // directories.buildResources must point to existing build dir
    expect(existsSync(buildDir), `missing buildResources dir ${buildDir}`).toBe(true)
    expect(statSync(buildDir).isDirectory()).toBe(true)
  })

  it('package.json must NOT contain duplicate build key — merged into electron-builder.yml', () => {
    expect(existsSync(pkgPath), `missing ${pkgPath}`).toBe(true)
    const raw = readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as Record<string, unknown>

    // The build config must live solely in electron-builder.yml.
    // package.json must not have a top-level "build" key (duplicate).
    expect(pkg, 'package.json must not have duplicate "build" key; config belongs in electron-builder.yml').not.toHaveProperty('build')

    // Ensure package.json still valid and productName source stays in yml, not duplicated incorrectly
    expect(pkg.name).toBe('local-ai-suite')

    // Raw string check: avoid accidental "build": { ... } fragment
    // Allow scripts like "build": "electron-vite build" but not top-level object key
    // We already checked parsed object; extra guard: top-level "build" object pattern
    const hasTopLevelBuildObject = /"build"\s*:\s*\{/.test(raw)
    expect(hasTopLevelBuildObject, 'package.json raw must not contain "build": { object — merge into yml').toBe(false)
  })

  it('yml linux icon target file is valid PNG 512x512', () => {
    const p = join(buildDir, 'icons', '512x512.png')
    const buf = readFileSync(p)
    // PNG signature
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(buf.subarray(0, 8).equals(sig), 'icons/512x512.png must be valid PNG').toBe(true)
    const w = buf.readUInt32BE(16)
    const h = buf.readUInt32BE(20)
    expect(w).toBe(512)
    expect(h).toBe(512)
  })
})
