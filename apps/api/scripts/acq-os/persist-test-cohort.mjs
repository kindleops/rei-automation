// ─── scripts/acq-os/persist-test-cohort.mjs ─────────────────────────────────
// PERSIST the frozen v2.1 test cohort (both arms + pair schedule) into
// campaign_test_cohorts / campaign_test_cohort_members (migration (a)).
// PRODUCTION WRITE — owner go required. Default is a DRY RUN that writes
// nothing and prints exactly what would be inserted.
//
//   node --import ./tests/register-aliases.mjs scripts/acq-os/persist-test-cohort.mjs \
//        --cohort=<test-cohort.json> --cohort-key=v2_1_dal_hou_sfr_20261007 [--confirm-write]
//
// One transaction, statement_timeout 30 s, lock_timeout 3 s; refuses if the
// key already exists (never overwrites a frozen cohort); verifies 310 + 310
// members and that no property is in both arms before COMMIT.
import fs from 'node:fs'
import { getPgPool } from '@/lib/postgres/client.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true] }))
if (!args.cohort || !args['cohort-key']) { console.error('--cohort and --cohort-key are required'); process.exit(2) }
const cohort = JSON.parse(fs.readFileSync(args.cohort, 'utf8'))
const key = String(args['cohort-key'])
const members = cohort.members || []
const test = members.filter((m) => m.arm === 'test')
const control = members.filter((m) => m.arm === 'control')
const overlap = test.filter((t) => control.some((c) => c.property_id === t.property_id)).length
const plan = { cohort_key: key, test: test.length, control: control.length, overlap, paired: members.filter((m) => m.pair_id).length, extract_as_of: cohort.extract_as_of }
console.log(JSON.stringify({ mode: args['confirm-write'] ? 'WRITE' : 'DRY RUN', ...plan }))
if (test.length !== 310 || control.length !== 310 || overlap) { console.error('refusing: expected 310 + 310 disjoint members'); process.exit(3) }
// Read-only freshness check against the live graph (the cohort came from a 04:24Z extract).
{
  const { rows } = await getPgPool().query(
    `select property_id, queue_eligible, sms_eligible, never_contacted, pending_prior_touch, true_post_contact_suppression, wrong_number, active_queue_item
       from public.campaign_target_graph where property_id = any($1::text[])`,
    [members.map((m) => m.property_id)],
  )
  const by = new Map(rows.map((r) => [r.property_id, r]))
  const stale = { test: [], control: [] }
  for (const m of members) {
    const r = by.get(m.property_id)
    const why = !r ? 'missing_from_graph' : !r.queue_eligible ? 'not_queue_eligible' : !r.sms_eligible ? 'not_sms_eligible' : !r.never_contacted ? 'contacted_since_extract' : r.pending_prior_touch ? 'pending_prior_touch' : r.true_post_contact_suppression ? 'suppressed' : r.wrong_number ? 'wrong_number' : r.active_queue_item ? 'active_queue_item' : null
    if (why) stale[m.arm].push({ property_id: m.property_id, why })
  }
  console.log(JSON.stringify({ freshness: { test_stale: stale.test.length, control_stale: stale.control.length, reasons: [...stale.test, ...stale.control].reduce((a, x) => ({ ...a, [x.why]: (a[x.why] || 0) + 1 }), {}) } }))
  if ((stale.test.length || stale.control.length) && args['confirm-write']) { console.error('refusing: stale members — rebuild the cohort from a fresh extract first'); process.exit(4) }
}
if (!args['confirm-write']) { console.log('dry run only — nothing written. Re-run with --confirm-write after the owner says go.'); await getPgPool().end(); process.exit(0) }

const client = await getPgPool().connect()
try {
  await client.query('begin')
  await client.query("set local statement_timeout = '30s'")
  await client.query("set local lock_timeout = '3s'")
  const exists = await client.query('select 1 from public.campaign_test_cohorts where cohort_key = $1', [key])
  if (exists.rows.length) throw new Error(`cohort ${key} already exists — frozen cohorts are never overwritten`)
  await client.query(
    `insert into public.campaign_test_cohorts (cohort_key, status, definition, preregistration, interleave, extract_as_of, created_by)
     values ($1, 'prepared', $2::jsonb, $3::jsonb, $4::jsonb, $5, 'agent:A2 (owner go)')`,
    [key, JSON.stringify({ test: cohort.definition, control: cohort.control_arm, counterfactual: cohort.counterfactual_old_selection_same_zips, mix: cohort.mix }), JSON.stringify(cohort.preregistration), JSON.stringify({ ...cohort.interleave, schedule: undefined }), '2026-10-07T04:24:00Z'],
  )
  for (let i = 0; i < members.length; i += 200) {
    const chunk = members.slice(i, i + 200)
    await client.query(
      `insert into public.campaign_test_cohort_members (cohort_key, property_id, arm, zip, pair_id, send_day, block_15m, first_in_pair, selection)
       select $1, x.property_id, x.arm, x.zip, x.pair_id, x.send_day, x.block_15m, x.first_in_pair, x.selection
         from jsonb_to_recordset($2::jsonb) as x(property_id text, arm text, zip text, pair_id int, send_day smallint, block_15m smallint, first_in_pair text, selection jsonb)`,
      [key, JSON.stringify(chunk)],
    )
  }
  const check = await client.query('select arm, count(*)::int n from public.campaign_test_cohort_members where cohort_key = $1 group by 1', [key])
  const n = Object.fromEntries(check.rows.map((r) => [r.arm, r.n]))
  if (n.test !== 310 || n.control !== 310) throw new Error(`verification failed: ${JSON.stringify(n)}`)
  await client.query('commit')
  console.log(JSON.stringify({ ok: true, written: n }))
} catch (error) {
  await client.query('rollback').catch(() => {})
  console.error('rolled back:', error.message)
  process.exitCode = 1
} finally {
  client.release()
  await getPgPool().end()
}
