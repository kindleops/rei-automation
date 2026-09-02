/**
 * Regression guard for the iOS standalone-PWA fullscreen geometry contract.
 *
 * Locks the architecture that PASSED on a physical installed iPhone at SHA
 * 182f4b3bfa3bab64185aaf4eab6e54d891c1af4c (css main-Dt6KsIub.css):
 *
 *   html   owns the standalone screen extent (100lvh)
 *   body / #root / .nx-os / route shells consume 100% of it
 *   Map + top command dock + bottom pinned dock position:absolute against that
 *   shared root — NOT position:fixed, which resolves to the short layout
 *   viewport (probed 1163 of a 1242.66 screen) because nothing on the ancestor
 *   chain creates a fixed containing block.
 *
 * Scope is deliberately `@media (display-mode: standalone)` only. Browser and
 * desktop keep their own dvh contract and are not asserted here.
 *
 * Runs against BUILT css, not source.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist/assets')
const cssFile = readdirSync(dist).find((f) => /^main-.*\.css$/.test(f))
if (!cssFile) throw new Error('assert-fullscreen: no built main CSS found — run the build first')
const css = readFileSync(join(dist, cssFile), 'utf8')

/** Extract a media block by brace matching (regex can't nest). */
const mediaBlock = (needle) => {
  const at = css.indexOf(needle)
  if (at === -1) return null
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  return null
}

const standalone = mediaBlock('@media (display-mode:standalone)')
const fail = []
if (!standalone) {
  fail.push('no @media (display-mode: standalone) block — the standalone screen-root contract is missing')
}

/** Declarations for a selector INSIDE the standalone block. */
const inStandalone = (subject) => {
  if (!standalone) return null
  for (const m of standalone.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const sel of m[1].split(',').map((s) => s.trim())) {
      if (sel.endsWith(subject)) return m[2].replace(/\s/g, '')
    }
  }
  return null
}

if (standalone) {
  const flat = standalone.replace(/\s/g, '')

  // 1. html owns the standalone screen extent.
  if (!/html\.is-mobile-layout\{[^}]*height:100lvh/.test(flat)) {
    fail.push('html.is-mobile-layout must own the standalone extent via height:100lvh')
  }

  // 2. Descendants consume 100% of that root.
  if (!flat.includes('height:100%!important')) {
    fail.push('body/#root/.nx-os/route shells must consume height:100% of the root')
  }

  // 3. No viewport-unit sizing anywhere in the standalone fullscreen ancestry.
  for (const banned of ['height:100dvh', 'height:100vh', 'height:100svh',
                        'min-height:100dvh', 'max-height:100dvh']) {
    if (flat.includes(banned)) {
      fail.push(`standalone fullscreen ancestry must not size from ${banned}`)
    }
  }

  // 3b. Base stylesheets still carry dvh clamps (e.g. body{min-height:100dvh}).
  //     The standalone block must neutralise them on the root chain, otherwise a
  //     clamp survives in the ancestry even though this block itself is clean.
  for (const sel of ['body', '#root', '.nx-os.is-mobile-os']) {
    const d = inStandalone(sel)
    if (!d) { fail.push(`${sel} must be neutralised inside the standalone block`); continue }
    if (!d.includes('min-height:0')) fail.push(`${sel} must set min-height:0 to clear base dvh clamps`)
    if (!d.includes('max-height:none')) fail.push(`${sel} must set max-height:none to clear base dvh clamps`)
  }

  // 4. The three fullscreen layers anchor to the shared root, never to a viewport.
  const layers = {
    '.nx-icm.is-mobile-map': ['position:absolute', 'inset:0', 'width:100%', 'height:auto'],
    '.nx-mobile-command-dock': ['position:absolute'],
    '.nx-pinned-app-dock': ['position:absolute'],
  }
  for (const [sel, required] of Object.entries(layers)) {
    const decl = inStandalone(sel)
    if (!decl) { fail.push(`${sel} must be declared inside the standalone block`); continue }
    for (const req of required) {
      if (!decl.includes(req)) fail.push(`${sel} must emit ${req} — got: ${decl}`)
    }
    if (decl.includes('position:fixed')) {
      fail.push(`${sel} must not use position:fixed — it resolves to the short layout viewport`)
    }
    if (decl.includes('inset:00auto')) fail.push(`${sel} must not use inset: 0 0 auto`)
  }

  // 5. safe-area may pad controls but must never size the fullscreen root.
  if (/(?:height|min-height|max-height):[^;]*safe-area-inset/.test(flat)) {
    fail.push('safe-area must not size or shorten the fullscreen root — padding only')
  }
}

// 6. The document ancestors must never be fixed as a fullscreen workaround,
//    and no JS-published height variable may return. Checked across all CSS.
for (const subject of ['html.is-mobile-layout', 'html.is-mobile-layout body', 'html.is-mobile-layout #root']) {
  const re = new RegExp(escapeRe(subject) + '\\{([^}]*)\\}')
  const m = css.replace(/\s/g, '').match(new RegExp(escapeRe(subject.replace(/\s/g, '')) + '\\{([^}]*)\\}'))
  if (m && m[1].includes('position:fixed')) {
    fail.push(`${subject} must not be position:fixed as a fullscreen workaround`)
  }
  void re
}
if (/--nx-app-h\s*:/.test(css)) fail.push('--nx-app-h must not be published as a layout height')

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

if (fail.length) {
  console.error('✗ standalone fullscreen contract violated:\n  - ' + fail.join('\n  - '))
  process.exit(1)
}
console.log(`✓ standalone fullscreen contract intact (${cssFile})`)
