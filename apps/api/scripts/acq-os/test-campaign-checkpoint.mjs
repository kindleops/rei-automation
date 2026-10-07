// ─── scripts/acq-os/test-campaign-checkpoint.mjs ─────────────────────────────
// Re-runnable, READ-ONLY checkpoint report for the v2.1 test campaign
// (test arm vs control arm). Uses the API's own service code
// (runTestCampaignCheckpoint) against DATABASE_URL with statement_timeout 30 s.
//
//   node --import ./tests/register-aliases.mjs scripts/acq-os/test-campaign-checkpoint.mjs \
//        --cohort=<test-cohort.json> --launched-at=<ISO of the first opener> --checkpoint=24h|72h|7d|14d|21d [--out=<file>]
//
// Pre-registered metrics/decision rule live in the cohort file
// (`preregistration`). Only the 21d checkpoint is a decision; earlier ones are
// informational except the guardrails.
import fs from 'node:fs'
import { runTestCampaignCheckpoint } from '@/lib/domain/campaigns/ranking-v2/screener-service.js'

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
if (!args.cohort || !args['launched-at']) { console.error('--cohort=<file> and --launched-at=<ISO> are required'); process.exit(2) }
const cohort = JSON.parse(fs.readFileSync(args.cohort, 'utf8'))
const checkpoints = args.checkpoint ? [args.checkpoint] : ['24h', '72h', '7d', '14d', '21d']
const out = []
for (const checkpoint of checkpoints) {
  const r = await runTestCampaignCheckpoint(cohort, { checkpoint, launched_at: args['launched-at'] }, { env: { SELLER_SCREENER: 'on' } })
  out.push(r)
  if (!r.ok) { console.error(checkpoint, r.error, r.message || ''); continue }
  const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`)
  console.log(`\n== ${checkpoint} · ${r.window.since} → ${r.window.until} · delivered test ${r.arms.test.delivered} / control ${r.arms.control.delivered}`)
  for (const m of ['replied', 'owner', 'interested', 'price', 'realistic', 'negotiation', 'contract', 'deal', 'opt_out', 'hostile']) {
    const d = r.test_minus_control[m]
    console.log(`${m.padEnd(12)} test ${String(r.arms.test[m].k).padStart(3)} ${pct(r.arms.test[m].rate).padStart(7)} · control ${String(r.arms.control[m].k).padStart(3)} ${pct(r.arms.control[m].rate).padStart(7)} · Δ ${pct(d.diff)} [${pct(d.ci95[0])}, ${pct(d.ci95[1])}]`)
  }
  console.log('north star contracts/1000:', r.arms.test.north_star.contracts_per_1000, 'vs', r.arms.control.north_star.contracts_per_1000)
  console.log('verdict:', JSON.stringify(r.verdict))
}
if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 1))
process.exit(0)
