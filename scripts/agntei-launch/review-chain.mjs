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

// agntei reconciliation (2026-11-05): production may carry Package A (release/cloudflare-production 4362dcfa), whose
// PROPOSED_20261020120000_research_event_budget_ceilings re-creates agent.runtime_enqueue_event with PER-KIND ceilings
// and says, for the rc-8.5.21 integrator: with Package A applied, never apply
// PROPOSED_20261013161000_conversation_decide_event_budget (it would re-create the literal 0.05 clamp).
// Proven on PostgreSQL 17 (agntei-launch-chain-pg.test.mjs): from a Package A state the rest of the chain applies and
// the ceilings stay in force. So: Package A's body is a REVIEWED alternative (not drift), and the link it replaces
// reads SUPERSEDED (satisfied for the order, never applied) wherever Package A's ceiling function is live.
export const PACKAGE_A_CEILING_FN = 'function:agent.runtime_event_budget_ceiling(p_kind text)'
export const ALTERNATIVE_BODIES = Object.freeze({
  'agent.runtime_enqueue_event(p_kind text, p_event_key text, p_input jsonb, p_priority integer)': [
    { source: 'PROPOSED_20261020120000_research_event_budget_ceilings (Package A, production)', md5: '5d8d3c3c88987a43bf72d2929467a7f4' },
  ],
})
export const SUPERSEDED = Object.freeze({
  PROPOSED_20261013161000_conversation_decide_event_budget: { when: PACKAGE_A_CEILING_FN, by: 'PROPOSED_20261020120000_research_event_budget_ceilings (Package A)' },
})

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
      const alt = (ALTERNATIVE_BODIES[fn] ?? []).find((a) => a.md5 === cur)
      if (i < 0 && alt) return { fn, state: 'at-or-after', live: alt.source }
      if (i < 0) return { fn, state: 'drift' }
      return { fn, state: i >= mine ? 'at-or-after' : 'before', live: vs[i].migration }
    })
    const fnOk = fns.filter((f) => f.state === 'at-or-after').length
    const total = objs.length + fns.length; const ok = present.length + fnOk
    const drift = fns.filter((f) => f.state === 'drift').map((f) => f.fn)
    let status = total === 0 ? 'nothing-to-check' : ok === total ? 'applied' : ok === 0 ? 'absent' : 'partial'
    const sup = SUPERSEDED[m.name]
    if (sup && live.has(sup.when)) status = 'superseded'
    return { name: m.name, status, checked: total, present: ok, drift, missing: [...objs.filter((k) => !live.has(k)), ...fns.filter((f) => f.state !== 'at-or-after').map((f) => `function:${f.fn} (${f.state}${f.live ? `, live version from ${f.live}` : ''})`)].slice(0, 12), roles: m.roles, rollback: m.rollback }
  })
  const done = (r) => r.status === 'applied' || r.status === 'superseded'
  const firstGap = rows.findIndex((r) => !done(r))
  const orderBroken = firstGap >= 0 && rows.slice(firstGap + 1).some((r) => r.status === 'applied' || r.status === 'partial')
  return { rows, next: firstGap >= 0 ? rows[firstGap].name : null, pending: rows.filter((r) => !done(r)).map((r) => r.name), superseded: rows.filter((r) => r.status === 'superseded').map((r) => r.name), orderBroken, drift: rows.flatMap((r) => r.drift.map((d) => `${r.name}: ${d}`)) }
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
