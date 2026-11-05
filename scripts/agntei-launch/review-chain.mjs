// READ-ONLY review of where a database stands on the agntei gateway chain (gateway-chain.manifest.json).
// Runs every query inside BEGIN TRANSACTION READ ONLY ... ROLLBACK: PostgreSQL itself refuses any write. Prints, per
// migration in apply order: applied | partial | absent, which reviewed version of each function body is live, and DRIFT
// (a body no reviewed migration produced: production carries a change this branch has not seen). Nothing is changed.
//   LC_REVIEW_DB_URL_FILE=<0600 file holding the connection string> node scripts/agntei-launch/review-chain.mjs [--json]
// The connection string is read from a file (never an argument, never printed).
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { SNAPSHOT_SQL } from './chain.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
export function review(manifest, live) {
  const versions = new Map() // function -> [{ migration, md5 }] in chain order
  for (const m of manifest.migrations) for (const [fn, md5] of Object.entries(m.bodies ?? {})) { if (!versions.has(fn)) versions.set(fn, []); versions.get(fn).push({ migration: m.name, md5 }) }
  const rows = manifest.migrations.map((m) => {
    const objs = m.adds.filter((k) => !k.startsWith('function:'))
    const present = objs.filter((k) => live.has(k))
    const fns = Object.entries(m.bodies ?? {}).map(([fn, md5]) => {
      const cur = live.get(`function:${fn}`)
      if (cur === undefined) return { fn, state: 'missing' }
      const vs = versions.get(fn) ?? []; const i = vs.findIndex((v) => v.md5 === cur); const mine = vs.findIndex((v) => v.migration === m.name)
      if (i < 0) return { fn, state: 'drift' }
      return { fn, state: i >= mine ? 'at-or-after' : 'before', live: vs[i].migration }
    })
    const fnOk = fns.filter((f) => f.state === 'at-or-after').length
    const total = objs.length + fns.length; const ok = present.length + fnOk
    const drift = fns.filter((f) => f.state === 'drift').map((f) => f.fn)
    const status = total === 0 ? 'nothing-to-check' : ok === total ? 'applied' : ok === 0 ? 'absent' : 'partial'
    return { name: m.name, status, checked: total, present: ok, drift, missing: [...objs.filter((k) => !live.has(k)), ...fns.filter((f) => f.state !== 'at-or-after').map((f) => `function:${f.fn} (${f.state}${f.live ? `, live version from ${f.live}` : ''})`)].slice(0, 12), roles: m.roles, rollback: m.rollback }
  })
  const firstGap = rows.findIndex((r) => r.status !== 'applied')
  const orderBroken = firstGap >= 0 && rows.slice(firstGap + 1).some((r) => r.status === 'applied' || r.status === 'partial')
  return { rows, next: firstGap >= 0 ? rows[firstGap].name : null, pending: rows.filter((r) => r.status !== 'applied').map((r) => r.name), orderBroken, drift: rows.flatMap((r) => r.drift.map((d) => `${r.name}: ${d}`)) }
}
export async function liveCatalog(connectionString) {
  const c = new pg.Client({ connectionString }); await c.connect()
  try {
    await c.query('begin transaction read only')
    const rows = (await c.query(SNAPSHOT_SQL)).rows
    const roles = new Set(rows.filter((r) => r.kind === 'role').map((r) => r.name))
    const live = new Map(rows.filter((r) => r.kind !== 'role').map((r) => [`${r.kind}:${r.name}`, r.detail]))
    const ver = (await c.query('show server_version')).rows[0].server_version
    await c.query('rollback')
    return { live, roles, server: ver }
  } finally { await c.end() }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.env.LC_REVIEW_DB_URL_FILE
  if (!f) { console.error('Set LC_REVIEW_DB_URL_FILE to a 0600 file that holds the connection string (it is never printed).'); process.exit(2) }
  const st = fs.statSync(f); if ((st.mode & 0o077) !== 0) { console.error(`${f} must be readable by its owner only (chmod 600).`); process.exit(2) }
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/agntei-launch/gateway-chain.manifest.json'), 'utf8'))
  const { live, roles, server } = await liveCatalog(fs.readFileSync(f, 'utf8').trim())
  const r = review(manifest, live)
  for (const row of r.rows) row.rolesPresent = row.roles.filter((x) => roles.has(x))
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ server, manifest_commit: manifest.commit, ...r }, null, 1)); process.exit(0) }
  console.log(`Read-only review against PostgreSQL ${server}; reference: manifest from LeadCommand ${manifest.commit.slice(0, 8)}`)
  for (const row of r.rows) console.log(`${row.status.padEnd(9)} ${row.name}  (${row.present}/${row.checked})${row.drift.length ? `  DRIFT: ${row.drift.join(', ')}` : ''}${row.status === 'partial' ? `  missing: ${row.missing.join('; ')}` : ''}`)
  console.log(r.next ? `Next to apply, in order: ${r.pending.join(' -> ')}` : 'Every migration of the chain is applied.')
  if (r.orderBroken) console.log('WARNING: a later migration is applied while an earlier one is not: stop and review before applying anything.')
  if (r.drift.length) console.log('WARNING: production carries function bodies no reviewed migration produced (DRIFT): review them before applying.')
}
