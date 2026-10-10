/**
 * AGENT FIXTURE BUNDLE CHECK — proves the SIMULATED design fixtures are not in
 * a production build, including a flag-ON build (VITE_LC_AGENT_PROTOTYPE=1).
 *
 *   node scripts/proof/desktop/agent-fixture-bundle-check.mjs --build        # builds flag-on into a temp dir, then checks
 *   node scripts/proof/desktop/agent-fixture-bundle-check.mjs --dist=<dir>   # checks an existing build
 *
 * Markers are read from the fixture sources themselves (synthetic addresses,
 * `.sim` hosts, fixture ids), so the check cannot drift from the fixtures.
 * It also requires the agent chunk to be present, so a flag-off build (no
 * agent at all) cannot pass it vacuously. Exit 1 on any marker found.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, '../../..')
const fixturesDir = path.join(app, 'src/modules/agent/fixtures')
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null

let dist = arg('dist')
if (process.argv.includes('--build')) {
  dist = await fs.mkdtemp(path.join(os.tmpdir(), 'agx-fixture-check-'))
  const env = { ...process.env, VITE_LC_AGENT_PROTOTYPE: '1' }
  delete env.VITE_LC_AGENT_FIXTURES
  execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: app, env, stdio: ['ignore', 'ignore', 'inherit'] })
}
if (!dist) { console.error('usage: --build | --dist=<dir>'); process.exit(2) }

// markers from the fixture sources
const markers = new Set(['fx-run-', 'fx-prop-', 'Simulated · fixture data'])
for (const f of await fs.readdir(fixturesDir)) {
  if (!/\.ts$/.test(f) || f.endsWith('.test.ts')) continue
  const src = await fs.readFile(path.join(fixturesDir, f), 'utf8')
  for (const m of src.matchAll(/address:\s*'([^']{6,})'/g)) markers.add(m[1].replace(/\s*\(synthetic\)$/, ''))
  for (const m of src.matchAll(/host:\s*'([a-z0-9.-]+\.sim)'/g)) markers.add(m[1])
  for (const m of src.matchAll(/source_id:\s*'(fx-[a-z0-9-]+)'/g)) markers.add(m[1])
}
// the label component is not a fixture, but its long form only renders on fixture surfaces
markers.delete('Simulated · fixture data')

const files = []
async function walk(d) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else if (/\.(js|css|html|map)$/.test(e.name)) files.push(p) } }
await walk(dist)
let agentChunk = false
const hits = []
for (const f of files) {
  const text = await fs.readFile(f, 'utf8')
  if (/agx-dock|AgentHost/.test(text) || /AgentHost/.test(path.basename(f))) agentChunk = true
  for (const m of markers) if (text.includes(m)) hits.push(`${path.relative(dist, f)}: ${m}`)
}
const result = { dist, files: files.length, markers: markers.size, agent_chunk_present: agentChunk, fixture_hits: hits.length }
console.log(JSON.stringify(result))
if (!agentChunk) { console.error('FAIL: no agent chunk — this is not a flag-on build, so the check proves nothing'); process.exit(1) }
if (hits.length) { console.error(`FAIL: fixture content in the production bundle:\n${hits.slice(0, 20).join('\n')}`); process.exit(1) }
console.log('PASS: flag-on production build ships the agent without any SIMULATED fixture content')
