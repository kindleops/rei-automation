// Build the gateway chain's catalog fingerprint on a DISPOSABLE local PostgreSQL (loopback only; refuses anything else):
// apply each file of CHAIN in order on a fresh database, snapshot the catalog after each, and record for every
// production migration exactly what it adds (tables, columns, functions with body hash, policies, triggers, indexes,
// schemas) plus the roles it creates, and the final body hash of every function. The result is the reference that
// review-chain.mjs compares production against, read-only.
//   AGENT_PG_TEST_DB_URL=postgres://postgres@127.0.0.1:55432/postgres node scripts/agntei-launch/build-chain-manifest.mjs
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { CHAIN, SNAPSHOT_SQL } from './chain.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const url = new URL(process.env.AGENT_PG_TEST_DB_URL ?? '')
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) { console.error('Refusing: AGENT_PG_TEST_DB_URL must be a LOCAL disposable PostgreSQL.'); process.exit(2) }
const db = `chain_manifest_${process.pid}`
const admin = new pg.Client({ connectionString: url.toString() }); await admin.connect()
await admin.query(`create database ${db}`)
const u2 = new URL(url); u2.pathname = `/${db}`
const c = new pg.Client({ connectionString: u2.toString() }); await c.connect()
const snap = async () => new Map((await c.query(SNAPSHOT_SQL)).rows.filter((r) => r.kind !== 'role').map((r) => [`${r.kind}:${r.name}`, r.detail]))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const out = { generated_at: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(), postgres: (await c.query('show server_version')).rows[0].server_version, migrations: [], final_functions: {} }
let before = await snap()
try {
  for (const step of CHAIN) {
    const file = path.join(ROOT, step.file)
    const sql = fs.readFileSync(file, 'utf8')
    await c.query('begin'); try { await c.query(sql); await c.query('commit') } catch (e) { await c.query('rollback'); throw new Error(`${step.file}: ${e.message}`) }
    const after = await snap()
    if (step.kind === 'migration') {
      const adds = []; const replaces = []
      for (const [k, v] of after) { if (!before.has(k)) adds.push(k); else if (k.startsWith('function:') && before.get(k) !== v) replaces.push(k) }
      const roles = [...sql.matchAll(/create\s+role\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1])
      const bodies = Object.fromEntries([...adds, ...replaces].filter((k) => k.startsWith('function:')).map((k) => [k.slice(9), after.get(k)]))
      out.migrations.push({ file: step.file, name: path.basename(step.file, '.sql'), sha256: sha(file), adds: adds.sort(), replaces: replaces.sort(), bodies, roles: [...new Set(roles)], rollback: fs.existsSync(file.replace(/\.sql$/, '_rollback.sql')) ? step.file.replace(/\.sql$/, '_rollback.sql') : null, pretest: fs.existsSync(file.replace(/\.sql$/, '_pretest.sql')) ? step.file.replace(/\.sql$/, '_pretest.sql') : null })
    }
    before = after
  }
  for (const [k, v] of before) if (k.startsWith('function:')) out.final_functions[k.slice(9)] = v
} finally { await c.end(); await admin.query(`drop database if exists ${db}`); await admin.end() }
// keep only the final hashes of functions some migration of the chain added or replaced
const touched = new Set(out.migrations.flatMap((m) => [...m.adds, ...m.replaces]).filter((k) => k.startsWith('function:')).map((k) => k.slice(9)))
out.final_functions = Object.fromEntries(Object.entries(out.final_functions).filter(([k]) => touched.has(k)))
const dest = path.join(ROOT, 'scripts/agntei-launch/gateway-chain.manifest.json')
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n')
console.log(`${out.migrations.length} migrations fingerprinted; ${Object.keys(out.final_functions).length} function bodies; written to ${path.relative(ROOT, dest)}`)
for (const m of out.migrations) console.log(`  ${m.name}: +${m.adds.length} objects, ${m.replaces.length} function bodies replaced${m.roles.length ? `, roles ${m.roles.join(',')}` : ''}`)
