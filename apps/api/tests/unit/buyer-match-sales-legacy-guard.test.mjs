/**
 * LEGACY GUARD — public.recently_sold_properties (55,893 rows, frozen at
 * 2026-02-06) and its *_computed view are not a sales source. Buyer Match reads
 * current canonical sales through lib/domain/buyer-match/buyer-match-sales.js.
 * Any new reference in dashboard or API source fails this test.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
const ROOTS = ['apps/api/src', 'apps/dashboard/src']
const EXT = /\.(m?js|jsx|tsx?)$/
const LEGACY = /recently_sold_properties/

// path -> why it may still reference the legacy table
const ALLOWLIST = new Map([
  [
    'apps/api/src/lib/acquisition/acquisitionDecisionEngine.js',
    // TODO(buyer-match-sales): underwriting's recently_sold_properties fallback stays until the
    // planned side-by-side comparison (legacy vs mv_map_market_sales comps on the same subjects)
    // is run and owner-approved. Do not switch it without that comparison.
    'underwriting fallback pending side-by-side comparison',
  ],
])

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (EXT.test(name)) out.push(p)
  }
  return out
}

test('no source file outside the allowlist references recently_sold_properties', () => {
  const offenders = []
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root), [])) {
      const rel = relative(REPO, file)
      if (ALLOWLIST.has(rel)) continue
      if (LEGACY.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
  }
  assert.deepEqual(offenders, [], `legacy sales table referenced; read sales via buyer-match-sales.js instead:\n${offenders.join('\n')}`)
})

test('every allowlisted file still exists and still needs the exemption', () => {
  for (const rel of ALLOWLIST.keys()) {
    assert.ok(LEGACY.test(readFileSync(join(REPO, rel), 'utf8')), `${rel} no longer references the legacy table: drop it from the allowlist`)
  }
})
