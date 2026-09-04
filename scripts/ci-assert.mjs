#!/usr/bin/env node
// todo33 CI-v2 gate: string + byte assertions over .github/workflows/release.yml.
// Runs locally and in CI (pnpm check:ci). js-yaml is only a transitive pnpm
// store package, so YAML parse sanity is best-effort; regex/string assertions
// are the contract (noted in the plan's acceptance criteria).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wfPath = path.join(root, '.github', 'workflows', 'release.yml')
const bytes = readFileSync(wfPath)
const yml = bytes.toString('utf8')

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
  if (!ok) failures += 1
}

// --- UTF-8 hygiene (the :103 mojibake regression class) -------------------
check('no UTF-8 BOM', !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf))
check('no U+FFFD replacement chars', !yml.includes('\uFFFD'))
check('no "??????" mojibake runs', !/\?{4,}/.test(yml))

// --- trigger / publish semantics kept --------------------------------------
check('push branches main+master', /branches:\s*\n\s*-\s*main\n\s*-\s*master/.test(yml))
check('tags v*', /tags:\s*\n\s*-\s*'v\*'/.test(yml))
check('tag -> publish always', /refs\/tags\/v\* \]\]; then\n\s*pnpm exec electron-builder --win --x64 --publish always/.test(yml))
check('push -> publish never', /--publish never/.test(yml))
check('permissions contents: write', /permissions:\n\s*contents: write/.test(yml))

// --- verify-gated chain -----------------------------------------------------
const jobHeaders = [...yml.matchAll(/^  (verify|build|smoke-install|release-mac):$/gm)]
const jobOrder = jobHeaders.map(m => m[1])
check('jobs declared verify->build->smoke-install->release-mac', jobOrder.join('>') === 'verify>build>smoke-install>release-mac')
const jobs = Object.fromEntries(jobHeaders.map((h, i) => {
  const end = i + 1 < jobHeaders.length ? jobHeaders[i + 1].index : yml.length
  return [h[1], yml.slice(h.index, end)]
}))
check('build needs verify', /^ {4}needs: verify$/m.test(jobs.build))
check('smoke-install needs build', /^ {4}needs: build$/m.test(jobs['smoke-install']))
check('verify runs install+typecheck+vitest+e2e',
  /pnpm install --frozen-lockfile/.test(jobs.verify) &&
  /pnpm typecheck/.test(jobs.verify) &&
  /vitest run -c vitest\.config\.ci\.ts/.test(jobs.verify) &&
  /pnpm test:e2e/.test(jobs.verify))
check('verify gates e2e with update kill-switch', /LAS_DISABLE_UPDATE_CHECK: '1'/.test(jobs.verify))
check('verify runs actionlint', /download-actionlint\.bash/.test(jobs.verify))
check('mac job keeps continue-on-error', /release-mac:[\s\S]*continue-on-error: true/.test(yml))

// --- caches ------------------------------------------------------------------
check('pnpm/action-setup v4 present', /uses: pnpm\/action-setup@v4/.test(yml))
check('setup-node cache: pnpm present', /cache: pnpm/.test(yml))
check('win eb cache path is real LOCALAPPDATA path',
  yml.includes('~/AppData/Local/electron-builder/Cache') && !/^\s*ELECTRON_CACHE\s*:/m.test(yml))
check('linux eb cache path', yml.includes('~/.cache/electron-builder'))
check('cache restore/save split via actions/cache v4',
  /uses: actions\/cache\/restore@v4/.test(yml) && /uses: actions\/cache\/save@v4/.test(yml))
check('save runs with if: always()', /if: always\(\)\n\s*uses: actions\/cache\/save@v4/.test(yml))

// --- smoke-install contract ---------------------------------------------------
const smoke = jobs['smoke-install']
check('downloads NSIS artifact by unique name', /name: LocalAISuite-win-\$\{\{ github\.sha \}\}/.test(smoke))
check('silent install /S + -Wait', /-ArgumentList '\/S' -Wait/.test(smoke))
check('install dir mirrors perMachine:false', /\$env:LOCALAPPDATA 'Programs\\Local AI Suite'/.test(smoke))
check('process-alive 8s poll is mandatory', /not \$alive\) \{ throw/.test(smoke))
check('HTTP 11434 probe is best-effort warn', /Write-Warning 'models endpoint never answered/.test(smoke))
  check('silent uninstall via Uninstall*.exe glob (electron-builder names it "Uninstall <productName>.exe")', /Filter 'Uninstall\*\.exe'/.test(smoke) && /no Uninstall\*\.exe found in install dir/.test(smoke) && /-ArgumentList '\/S' -Wait/.test(smoke))
check('install-dir removal asserted (20s poll)', /left \$installDir in place/.test(smoke))
check('smoke sets update kill-switch env', /LAS_DISABLE_UPDATE_CHECK: '1'/.test(smoke))

// --- artifact policy ------------------------------------------------------------
check('upload-artifact v4', /uses: actions\/upload-artifact@v4/.test(yml))
check('artifact names include platform+sha', /name: LocalAISuite-\$\{\{ matrix\.platform \}\}-\$\{\{ github\.sha \}\}/.test(yml))
check('retention push 14 / tag 90', /retention-days: \$\{\{ github\.ref_type == 'tag' && 90 \|\| 14 \}\}/.test(yml))

// --- optional YAML parse sanity (js-yaml transitive in pnpm store) ---------------
let parsed = null
try {
  const req = createRequire(import.meta.url)
  const storeJs = path.join(root, 'node_modules', '.pnpm', 'js-yaml@4.3.1', 'node_modules', 'js-yaml')
  const yaml = req(storeJs)
  parsed = yaml.load(yml)
  check('yaml parses + has 4 jobs', Object.keys(parsed.jobs).length === 4)
} catch (e) {
  console.log(`note js-yaml parse sanity skipped (${e.code || e.message}) — string assertions are the contract`)
}

console.log(failures === 0 ? '\nci-assert: ALL GREEN' : `\nci-assert: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
