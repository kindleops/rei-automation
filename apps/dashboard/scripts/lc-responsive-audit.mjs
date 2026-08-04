#!/usr/bin/env node
/**
 * LC responsive + typography static gate — Constitution §15 / §2 / §17.
 * Owner: Lane G.
 *
 *   node scripts/lc-responsive-audit.mjs          # assert, exit 1 on violation
 *   node scripts/lc-responsive-audit.mjs --list   # print every violation
 *
 * Static counterpart to tests/a11y/responsive-a11y.spec.ts. It catches the
 * classes of defect that are cheaper to see in source than in a browser:
 *
 *   1. §15.1  Breakpoint drift — only the five bands may appear in a width
 *             media query, in CSS *and* in JS `matchMedia`.
 *   2. §15.2  `100vw` includes the scrollbar. Bare `100vw` (or `min(x, 100vw)`)
 *             guarantees overflow wherever a classic scrollbar exists.
 *   3. §2.1   11px is the type floor. Nothing below it may be declared.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const LIST = process.argv.includes('--list')

/* Must stay identical to src/modules/mobile/breakpoints.ts */
const ALLOWED = new Set([479.98, 767.98, 1023.98, 1439.98, 480, 768, 1024, 1440])

/**
 * Documented, deliberate deviations. Ultra-wide (>1600px) `min-width` queries
 * are progressive refinements *inside* the xl band; §15 defines no band above
 * 1440, and collapsing all three onto 1440 would make them overwrite each
 * other. Recorded here so the deviation is visible rather than silent.
 */
const ULTRAWIDE_EXEMPT = new Set([1800, 2200, 2800])

/**
 * Files another lane owns and is editing on its own branch. Lane G reports the
 * remaining §2.1 violations in them but does not rewrite them, because a
 * value-level edit to the same declaration is a merge conflict for no benefit.
 * Lane H should run with `--strict` AFTER integration, when these are one tree.
 */
const OTHER_LANE_FILES = new Set([
  'styles/nexus-theme.css',
  'styles/lc-tokens.css',
  'modules/shell/shell-rail.css',
  'shared/ui/lc-ui.css',
  'modules/inbox/inbox-density-25.css',
  'modules/inbox/inbox-elite-ui.css',
  'modules/inbox/inbox-workspace-layout.css',
  'dossier.css',
  'modules/deal-intelligence/deal-verdict.css',
  'shared/media/property-media.css',
  'modules/inbox/components/IntelligencePanel.tsx',
  'modules/inbox/components/SystemHealthOpsPanel.tsx',
])
const STRICT = process.argv.includes('--strict')

const TYPE_FLOOR_PX = 11
/** rem below this is under the 11px floor at the app's 16px root. */
const TYPE_FLOOR_REM = TYPE_FLOOR_PX / 16

const files = []
;(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(css|tsx|ts)$/.test(entry.name)) files.push(full)
  }
})(SRC)

const violations = { breakpoints: [], viewportWidth: [], typeFloor: [] }
const deferred = []
const rel = (f) => path.relative(SRC, f)

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')

  lines.forEach((line, i) => {
    const at = `${rel(file)}:${i + 1}`

    // 1. breakpoint drift — CSS @media and JS matchMedia are both width contracts
    if (/@media|matchMedia/.test(line)) {
      for (const m of line.matchAll(/(?:max|min)-width:\s*([0-9.]+)px/g)) {
        const value = parseFloat(m[1])
        if (ALLOWED.has(value) || ULTRAWIDE_EXEMPT.has(value)) continue
        violations.breakpoints.push(`${at}  ${m[0]}`)
      }
    }

    // 2. bare 100vw (scrollbar-inclusive). `calc(100vw - Npx)` with N >= 16 is
    //    tolerated: it already subtracts more than any classic scrollbar.
    if (/100vw/.test(line) && !/^\s*\/?\*/.test(line)) {
      const subtractions = [...line.matchAll(/100vw\s*-\s*([0-9.]+)px/g)].map((m) => parseFloat(m[1]))
      const bare = line.replace(/100vw\s*-\s*[0-9.]+px/g, '')
      if (/100vw/.test(bare)) violations.viewportWidth.push(`${at}  ${line.trim().slice(0, 100)}`)
      else if (subtractions.some((n) => n < 16)) {
        violations.viewportWidth.push(`${at}  subtracts only ${Math.min(...subtractions)}px  ${line.trim().slice(0, 80)}`)
      }
    }

    // 3. §2.1 type floor
    for (const m of line.matchAll(/font-size:\s*([0-9.]+)(px|rem)/g)) {
      const value = parseFloat(m[1])
      const belowFloor = m[2] === 'px' ? value < TYPE_FLOOR_PX : value < TYPE_FLOOR_REM
      if (!belowFloor) continue
      if (!STRICT && OTHER_LANE_FILES.has(rel(file))) deferred.push(`${at}  ${m[0]}`)
      else violations.typeFloor.push(`${at}  ${m[0]}`)
    }
  })
}

const sections = [
  ['§15.1  breakpoints outside the five bands', violations.breakpoints],
  ['§15.2  scrollbar-inclusive viewport width', violations.viewportWidth],
  ['§2.1   font-size below the 11px floor', violations.typeFloor],
]

let failed = false
console.log(`lc-responsive-audit — ${files.length} source files\n`)
for (const [title, list] of sections) {
  const status = list.length === 0 ? 'PASS' : 'FAIL'
  if (list.length) failed = true
  console.log(`${status}  ${title}: ${list.length}`)
  if (LIST && list.length) for (const v of list.slice(0, 400)) console.log(`        ${v}`)
}
console.log(
  `\nexempt (documented deviation): ultra-wide min-width ${[...ULTRAWIDE_EXEMPT].join(', ')}px`,
)
if (deferred.length) {
  const byFile = new Map()
  for (const d of deferred) {
    const f = d.split(':')[0]
    byFile.set(f, (byFile.get(f) || 0) + 1)
  }
  console.log(`\nDEFERRED — §2.1 violations inside files another lane owns: ${deferred.length}`)
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`        ${String(n).padStart(3)}  ${f}`)
  console.log('        run with --strict after integration to make these fail')
}
process.exit(failed ? 1 : 0)
