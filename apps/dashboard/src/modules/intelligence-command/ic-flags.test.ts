import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fixturesGate, IC_FIXTURES_ENABLED } from './ic-flags'

/**
 * NO FIXTURE IN PRODUCTION. Three proofs:
 *  1. the gate is false in any production build (DEV=false), even with the flag set;
 *  2. every import of the dev fixture module sits behind the inline
 *     `import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1'` guard
 *     (the form the bundler constant-folds), and no production module imports it statically;
 *  3. when a build exists in dist/, no emitted file carries the fixture marker
 *     (scripts/proof/desktop/ic-fixture-bundle-check.mjs runs the build itself).
 */
const ROOT = path.resolve(__dirname, '../../..')
const SRC = path.join(ROOT, 'src')
const GUARD = "import.meta.env.DEV && import.meta.env.VITE_LC_IC_FIXTURES === '1'"
const MARKER = 'lc-ic-dev-fixture-v1'

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'snapshots') walk(p, out) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('Intelligence Command dev fixtures never reach production', () => {
  it('the gate folds to false without DEV, whatever the flag says', () => {
    expect(fixturesGate({ DEV: false, VITE_LC_IC_FIXTURES: '1' })).toBe(false)
    expect(fixturesGate({ DEV: true, VITE_LC_IC_FIXTURES: undefined })).toBe(false)
    expect(fixturesGate({ DEV: true, VITE_LC_IC_FIXTURES: '0' })).toBe(false)
    expect(fixturesGate({ DEV: true, VITE_LC_IC_FIXTURES: '1' })).toBe(true)
    // this test process is not a fixture build
    expect(IC_FIXTURES_ENABLED).toBe(false)
  })

  it('every reference to the fixture module is a guarded dynamic import', () => {
    const offenders: string[] = []
    let guarded = 0
    for (const f of walk(SRC)) {
      if (f.endsWith(path.join('fixtures', 'ic-dev-fixtures.ts'))) continue
      const text = fs.readFileSync(f, 'utf8')
      if (!text.includes('ic-dev-fixtures')) continue
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!line.includes('ic-dev-fixtures') || /^\s*(\*|\/\/)/.test(line)) return
        if (/^\s*import\s/.test(line) || /from\s+['"][^'"]*ic-dev-fixtures/.test(line)) { offenders.push(`${f}:${i + 1} static import`); return }
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        if (/import\(['"][^'"]*ic-dev-fixtures['"]\)/.test(line) && window.includes(GUARD)) guarded += 1
        else offenders.push(`${f}:${i + 1} unguarded`)
      })
    }
    expect(offenders).toEqual([])
    expect(guarded).toBeGreaterThan(0)
  }, 180_000)

  it('a production build in dist/ (when present) carries no fixture marker', () => {
    const dist = path.join(ROOT, 'dist')
    if (!fs.existsSync(dist)) return
    const hits: string[] = []
    const scan = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) scan(p)
        else if (/\.(js|mjs|css|html)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(MARKER)) hits.push(path.relative(dist, p))
      }
    }
    scan(dist)
    expect(hits).toEqual([])
  }, 180_000)
})
