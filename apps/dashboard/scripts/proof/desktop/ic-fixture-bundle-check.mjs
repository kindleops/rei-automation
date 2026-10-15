/**
 * INTELLIGENCE COMMAND FIXTURE BUNDLE CHECK — proves the dev fetch double
 * (src/modules/intelligence-command/fixtures/ic-dev-fixtures.ts) is not in a
 * production build, EVEN WITH VITE_LC_IC_FIXTURES=1 and the agent flag on.
 *
 *   node scripts/proof/desktop/ic-fixture-bundle-check.mjs --build        # builds into a temp dir, then checks
 *   node scripts/proof/desktop/ic-fixture-bundle-check.mjs --dist=<dir>   # checks an existing build
 *
 * Markers come from the fixture source itself (its marker constant, the
 * synthetic addresses / ids), so the check cannot drift from the fixture.
 * It requires the Intelligence Command chunk to be present, so a build
 * without the app cannot pass vacuously. Exit 1 on any marker found.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '../../..')
const fixture = path.join(app, 'src/modules/intelligence-command/fixtures/ic-dev-fixtures.ts')
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null

let dist = arg('dist')
if (process.argv.includes('--build')) {
  dist = await fs.mkdtemp(path.join(os.tmpdir(), 'ic-fixture-check-'))
  const env = { ...process.env, VITE_LC_AGENT_PROTOTYPE: '1', VITE_LC_IC_FIXTURES: '1' }
  execFileSync(path.join(app, '../../node_modules/.bin/vite'), ['build', '--outDir', dist, '--emptyOutDir'], { cwd: app, env, stdio: ['ignore', 'ignore', 'inherit'] })
}
if (!dist) { console.error('usage: --build | --dist=<dir>'); process.exit(2) }

const src = await fs.readFile(fixture, 'utf8')
const markers = new Set(['installIcDevFixtures', '__icDev'])
for (const m of src.matchAll(/IC_DEV_FIXTURE_MARKER = '([^']+)'/g)) markers.add(m[1])
for (const m of src.matchAll(/'(\d{4} [A-Z][a-z]+ (?:Ct|Row|Way) · synthetic)'/g)) markers.add(m[1])
for (const m of src.matchAll(/'(apr_dev|mjob_0000dev1|ask_dev|qs_dev0001)/g)) markers.add(m[1])

const files = []
async function walk(d) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.(js|css|html|map)$/.test(e.name)) files.push(p) } }
await walk(dist)
let icChunk = false
const hits = []
for (const f of files) {
  const text = await fs.readFile(f, 'utf8')
  if (/ic-composer/.test(text)) icChunk = true
  for (const m of markers) if (text.includes(m)) hits.push(`${path.relative(dist, f)}: ${m}`)
}
const result = { dist, files: files.length, markers: [...markers], ic_chunk_present: icChunk, fixture_hits: hits.length }
console.log(JSON.stringify(result))
if (!icChunk) { console.error('FAIL: no Intelligence Command chunk — the check proves nothing'); process.exit(1) }
if (hits.length) { console.error(`FAIL: fixture content in the production bundle:\n${hits.slice(0, 20).join('\n')}`); process.exit(1) }
console.log('PASS: production build (VITE_LC_IC_FIXTURES=1, agent flag on) ships Intelligence Command without the dev fixture')
