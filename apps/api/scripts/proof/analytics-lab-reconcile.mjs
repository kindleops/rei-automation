/**
 * ANALYTICS LAB — live reconciliation + latency proof (READ ONLY).
 *
 *   cd apps/api && node --env-file=.env.local --import ./scripts/proof/register-aliases-live.mjs scripts/proof/analytics-lab-reconcile.mjs
 *
 * 1. v1 reconciliation: the Lab's fact extraction, run through v1's OWN
 *    predicates and created_at basis (v1Compatible), must equal the
 *    analytics_performance RPC key-for-key on fixed closed windows. Agreement
 *    proves the extraction; every lab-v2 difference is then definitional.
 * 2. lab-v2 values next to v1 for the same window, with the reason for each gap.
 * 3. Latency of representative queries, cold and warm.
 *
 * Only select/rpc reads. Exit code 1 on any reconciliation mismatch.
 */
import { supabase } from '@/lib/supabase/client.js'
import { canaryPhones, POSITIVE_INTENTS, OPTOUT_INTENTS } from '@/lib/domain/analytics/lab/fact-classifiers.js'
import { createFactLoader } from '@/lib/domain/analytics/lab/fact-loader.js'
import { buildModel, evaluate, periodFacts, v1Compatible } from '@/lib/domain/analytics/lab/metric-engine.js'
import { normalizeContext } from '@/lib/domain/analytics/lab/query-contract.js'
import { getOverview, runQuery, getRecords } from '@/lib/domain/analytics/lab/lab-service.js'

const arg = (n, f) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : f }
const WINDOWS = [
  { name: 'Sep 1–30 vs Aug', cur: ['2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z'], prev: ['2026-08-03T00:00:00Z', '2026-09-01T00:00:00Z'] },
  { name: 'Jul 1–Aug 31 vs May–Jun', cur: ['2026-07-01T00:00:00Z', '2026-09-01T00:00:00Z'], prev: ['2026-05-01T00:00:00Z', '2026-07-01T00:00:00Z'] },
]
const KEYS = ['send_rows', 'sent', 'delivered', 'delivered_conversations', 'failed', 'failed_transport', 'health_guard_blocks', 'expired', 'cancelled', 'replied_conversations', 'positive_conversations', 'opt_out_conversations', 'opportunities_created', 'stage_advancements', 'automation_runs', 'automation_succeeded', 'automation_held_by_gate', 'automation_needs_review', 'automation_failed']

let failures = 0
const loader = createFactLoader()
console.log('\n══ 1. v1 reconciliation (lab extraction × v1 predicates vs analytics_performance RPC) ══')
for (const w of WINDOWS) {
  const [cs, ce] = w.cur.map(Date.parse)
  const [ps, pe] = w.prev.map(Date.parse)
  const t0 = Date.now()
  const facts = await loader.load({ start: Math.min(cs, ps), end: Math.max(ce, pe), basis: 'created', lookbackMs: 0 })
  const model = buildModel(facts, { basis: 'created' })
  const lab = { cur: v1Compatible(model, { start: cs, end: ce }), prev: v1Compatible(model, { start: ps, end: pe }) }
  const labMs = Date.now() - t0
  const t1 = Date.now()
  const { data, error } = await supabase.rpc('analytics_performance', {
    p_start: w.cur[0], p_end: w.cur[1], p_prev_start: w.prev[0], p_prev_end: w.prev[1],
    p_exclude: [...canaryPhones()], p_positive: [...POSITIVE_INTENTS], p_optout: [...OPTOUT_INTENTS], p_market: null, p_bucket: 'day',
  })
  if (error) { console.error('RPC failed', error); process.exit(2) }
  const rpcMs = Date.now() - t1
  console.log(`\n${w.name}   (lab load ${labMs} ms · rpc ${rpcMs} ms)`)
  console.log('metric'.padEnd(28), 'cur lab'.padStart(8), 'cur rpc'.padStart(8), 'prev lab'.padStart(9), 'prev rpc'.padStart(9), ' ')
  for (const k of KEYS) {
    const a = lab.cur[k]; const b = data.totals.cur[k]; const c = lab.prev[k]; const d = data.totals.prev[k]
    const ok = a === b && c === d
    if (!ok) failures += 1
    console.log(k.padEnd(28), String(a).padStart(8), String(b).padStart(8), String(c).padStart(9), String(d).padStart(9), ok ? ' ✓' : ' ✗ MISMATCH')
  }
}

console.log('\n══ 2. lab-v2 vs v1, last 30 days ══')
{
  const ctx = normalizeContext({ range: { preset: '30d' }, compare: { mode: 'previous' }, tz: 'America/Chicago' })
  const facts = await loader.load({ start: ctx.compare.start, end: ctx.period.end })
  const model = buildModel(facts)
  const pf = periodFacts(model, { start: ctx.period.start, end: ctx.period.end })
  const created = await loader.load({ start: ctx.compare.start, end: ctx.period.end, basis: 'created', lookbackMs: 0 })
  const v1 = v1Compatible(buildModel(created, { basis: 'created' }), { start: ctx.period.start, end: ctx.period.end })
  const show = (id) => { const r = evaluate(id, pf); return r.kind === 'rate' ? `${(r.value * 100).toFixed(1)}%  (${r.num}/${r.den})` : r.kind === 'duration' ? `${r.value?.toFixed(1)} min (n=${r.n})` : String(r.value) }
  const rows = [
    ['sellers_reached', show('sellers_reached'), v1.delivered_conversations],
    ['sellers_replied (all)', show('sellers_replied'), v1.replied_conversations],
    ['reached_replied', show('reached_replied'), '—'],
    ['reply_rate', show('reply_rate'), `${((v1.replied_conversations / v1.delivered_conversations) * 100).toFixed(1)}%  (${v1.replied_conversations}/${v1.delivered_conversations})`],
    ['interested_sellers', show('interested_sellers'), v1.positive_conversations],
    ['opted_out_sellers', show('opted_out_sellers'), v1.opt_out_conversations],
    ['messages_sent', show('messages_sent'), v1.sent],
    ['delivery_rate', show('delivery_rate'), `${((v1.delivered / v1.sent) * 100).toFixed(1)}%`],
    ['transport_failures', show('transport_failures'), `${v1.failed} (v1 "failed" incl. provider rejections)`],
    ['content_filtered', show('content_filtered'), '(v1 "content blocks": regex, see registry)'],
    ['provider_rejections', show('provider_rejections'), '—'],
    ['sender_health_blocks', show('sender_health_blocks'), `${v1.health_guard_blocks} (v1 incl. template blocks)`],
    ['template_health_blocks', show('template_health_blocks'), '—'],
    ['stage_advancements', show('stage_advancements'), `${v1.stage_advancements} (v1 incl. backward)`],
    ['stage_regressions', show('stage_regressions'), '—'],
    ['opportunities_created', show('opportunities_created'), v1.opportunities_created],
    ['median_reply_latency', show('median_reply_latency'), '—'],
    ['human_intervention_rate', show('human_intervention_rate'), `${v1.automation_needs_review}/${v1.automation_runs}`],
  ]
  console.log('metric'.padEnd(26), 'lab-v2'.padEnd(34), 'v1')
  for (const [k, a, b] of rows) console.log(k.padEnd(26), String(a).padEnd(34), String(b))
  console.log('excluded:', JSON.stringify(model.excluded))
}

console.log('\n══ 3. latency (fresh process cache; cold = first call) ══')
const timed = async (label, fn) => { const t = Date.now(); await fn(); const cold = Date.now() - t; const t2 = Date.now(); await fn(); const warm = Date.now() - t2; console.log(label.padEnd(44), `cold ${String(cold).padStart(5)} ms   warm ${String(warm).padStart(4)} ms`); return { label, cold, warm } }
const ctxOf = (raw) => normalizeContext({ tz: 'America/Chicago', ...raw })
const out = []
if (arg('latency', '1') === '1') {
  out.push(await timed('Overview 30D', () => getOverview(ctxOf({ range: { preset: '30d' } }))))
  out.push(await timed('Overview 7D', () => getOverview(ctxOf({ range: { preset: '7d' } }))))
  out.push(await timed('Overview today', () => getOverview(ctxOf({ range: { preset: 'today' } }))))
  out.push(await timed('Overview 90D', () => getOverview(ctxOf({ range: { preset: '90d' } }))))
  out.push(await timed('Overview YTD', () => getOverview(ctxOf({ range: { preset: 'ytd' } }))))
  out.push(await timed('Campaign compare (reply rate × campaign, 90D)', () => runQuery(ctxOf({ range: { preset: '90d' }, metric: 'reply_rate', groupBy: 'campaign' }), 'breakdown')))
  out.push(await timed('Market reply rate (30D)', () => runQuery(ctxOf({ range: { preset: '30d' }, metric: 'reply_rate', groupBy: 'market' }), 'breakdown')))
  out.push(await timed('ZIP map (sellers reached × zip, 90D)', () => runQuery(ctxOf({ range: { preset: '90d' }, metric: 'sellers_reached', groupBy: 'zip', limit: 500 }), 'breakdown')))
  out.push(await timed('Sender failures (transport failures × sender)', () => runQuery(ctxOf({ range: { preset: '30d' }, metric: 'transport_failures', groupBy: 'sender' }), 'breakdown')))
  out.push(await timed('High-equity SFR cohort reply rate (90D)', () => runQuery(ctxOf({ range: { preset: '90d' }, metric: 'reply_rate', filters: [{ field: 'property_type', op: 'in', value: ['Single Family'] }, { field: 'equity_percent', op: 'gt', value: 50 }] }), 'series')))
  out.push(await timed('Records: reply-rate numerator, page 1 (30D)', () => getRecords(ctxOf({ range: { preset: '30d' } }), { metric: 'reply_rate', part: 'numerator' }, { page: 1, pageSize: 50 })))
  out.push(await timed('Heatmap reply rate hour×weekday (90D)', () => runQuery(ctxOf({ range: { preset: '90d' }, metric: 'reply_rate' }), 'heatmap')))
  console.log('loader stats', JSON.stringify(loader.stats))
}
if (failures) { console.error(`\n${failures} reconciliation mismatch(es)`); process.exit(1) }
console.log('\nreconciliation: all keys match')
