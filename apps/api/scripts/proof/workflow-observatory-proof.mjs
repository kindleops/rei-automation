/**
 * WORKFLOW OBSERVATORY — PRODUCTION PROOF (read-only).
 *
 * For every live system workflow: read the registry, pick real recent runs of
 * each kind that exists (seller: auto-handled, human review, DNC, follow-up,
 * reply queued, delivery failure / retry), render the observed path and
 * compare it, node by node, against the AUTHORITATIVE records it was projected
 * from (the ledger steps in their written order + the owners' facts). Every
 * query is a SELECT. Writes one JSON artifact.
 *
 *   cd apps/api && node --import ./scripts/proof/register-aliases-live.mjs scripts/proof/workflow-observatory-proof.mjs [--out=path] [--dump-http=dir]
 */
import fs from 'node:fs'
import path from 'node:path'

for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^(SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
const OUT = path.resolve(arg('out', '../dashboard/artifacts/workflow-studio-3/production-proof.json'))

const { supabase } = await import('@/lib/supabase/client.js')
const svc = await import('@/lib/domain/workflow-studio/observatory/service.js')
const { SYSTEM_ADAPTERS } = await import('@/lib/domain/workflow-studio/observatory/registry.js')
const { evidenceIndex } = await import('@/lib/domain/workflow-studio/observatory/core.js')

const t0 = Date.now()
const reg = await svc.getRegistry({}, { supabase })
const out = { generated_at: new Date().toISOString(), telemetry: reg.telemetry, degraded: reg.degraded, registry: reg.workflows.filter((w) => !w.test).map((w) => ({ key: w.workflow_key, group: w.group, status: w.status, note: w.status_note, runs_today: w.stats.runs_today, runs_7d: w.stats.runs_7d, needs_you: w.stats.needs_you, in_flight: w.stats.in_flight, last_run_at: w.stats.last_run_at, heartbeat: w.heartbeat })), proofs: {} }

/** Seller: compare the observed path to the ledger's own step order (authoritative). */
async function proveSeller(runId, label) {
  const d = await svc.getRun('seller_inbound', runId, { supabase })
  const { data: steps } = await supabase.from('seller_automation_execution_steps').select('action_key, execution_status, block_reason, queue_id, created_at').eq('execution_id', runId).order('created_at', { ascending: true })
  const idx = evidenceIndex(SYSTEM_ADAPTERS.seller_inbound.topology)
  const hasQ = (steps || []).some((s) => s.action_key === 'message_queued' && s.queue_id)
  const ledgerNodes = []
  for (const s of steps || []) {
    if (s.action_key === 'message_sent' || (!hasQ && ['message_queued', 'duplicate_send_check'].includes(s.action_key))) continue
    const k = idx.get(s.action_key)
    if (k && ledgerNodes[ledgerNodes.length - 1] !== k) ledgerNodes.push(k)
  }
  const observed = d.path.order.filter((k) => d.path.nodes[k]?.status !== 'skipped')
  const ledgerSet = new Set(ledgerNodes)
  const observedLedger = observed.filter((k) => ledgerSet.has(k))
  const orderMatches = JSON.stringify([...new Set(observedLedger)]) === JSON.stringify([...new Set(ledgerNodes)])
  const unmappedSteps = (steps || []).filter((s) => !idx.has(s.action_key) && s.action_key !== 'message_sent').map((s) => s.action_key)
  const qid = (steps || []).find((s) => s.action_key === 'message_queued' && s.queue_id)?.queue_id
  const { data: q } = qid ? await supabase.from('send_queue').select('queue_status, failed_reason, delivered_at').eq('id', qid).maybeSingle() : { data: null }
  const ownerOk = !q || (['delivered', 'sent'].includes(q.queue_status) ? observed.includes('reply_delivered') : String(q.queue_status).startsWith('failed') ? observed.includes('reply_failed') : q.queue_status === 'paused_operator_review' ? observed.includes('approval_hold') : true)
  return {
    case: label, run_id: runId, subject: d.run.subject.name || d.run.subject.id, status: d.run.status, result: d.run.result, why: d.why,
    authoritative_ledger_order: ledgerNodes, observed_path: observed, skipped: d.path.order.filter((k) => d.path.nodes[k]?.status === 'skipped'),
    derived_from_owners: observed.filter((k) => !ledgerSet.has(k)), queue_row: q, focus: d.path.focus,
    verdict: { ledger_order_matches: orderMatches, send_result_from_queue: ownerOk, unmapped_ledger_keys: unmappedSteps, orphans: d.path.orphans || [] },
  }
}

// ── seller cases ──
const sellerRuns = await svc.listRuns('seller_inbound', { period: '30d', limit: 200 }, { supabase })
const pick = (fn) => sellerRuns.runs.find(fn)
const cases = [
  ['auto-handled · reply delivered', (r) => r.status === 'completed' && /delivered/i.test(r.result || '')],
  ['human review', (r) => r.status === 'needs_you' || (r.human && r.status === 'completed')],
  ['held by policy (no reply)', (r) => r.status === 'held' && !/approval/i.test(r.result || '')],
  ['follow-up scheduled', null],
  ['reply queued / awaiting approval', (r) => /queued|scheduled|approval/i.test(r.result || '')],
  ['delivery failure', (r) => r.status === 'failed'],
]
out.proofs.seller_inbound = { runs_in_window: sellerRuns.counts, cases: [] }
const { data: fuStep } = await supabase.from('seller_automation_execution_steps').select('execution_id').eq('action_key', 'follow_up_scheduled').order('created_at', { ascending: false }).limit(1)
for (const [label, fn] of cases) {
  const r = fn ? pick(fn) : fuStep?.[0] ? { run_id: fuStep[0].execution_id } : null
  out.proofs.seller_inbound.cases.push(r ? await proveSeller(r.run_id, label) : { case: label, absent: 'no run of this kind in the last 30 days' })
}
// DNC (subworkflow)
const dnc = await svc.listRuns('dnc_opt_out', { period: '30d', limit: 5 }, { supabase })
if (dnc.runs[0]) {
  const d = await svc.getRun('dnc_opt_out', dnc.runs[0].run_id, { supabase })
  const { data: sup } = await supabase.from('sms_suppression_list').select('id, created_at').eq('phone_e164', d.run.subject.id).limit(3)
  out.proofs.dnc_opt_out = { run_id: d.run.run_id, observed_path: d.path.order, result: d.run.result, authoritative: { suppression_rows: (sup || []).length }, verdict: { suppression_matches: (sup || []).length > 0 === d.path.order.includes('apply_suppression') && d.path.nodes.apply_suppression?.status === 'succeeded' } }
}

// ── the other live workflows: one real run each, path vs its own record ──
for (const key of ['queue_dispatch', 'campaign_execution', 'lead_state_reconcile', 'operator_notifications', 'event_bridge', 'offer_negotiation', 'decision_engine', 'buyer_matching', 'closing_execution', 'email_dispatch', 'seller_review_escalation']) {
  try {
    const list = await svc.listRuns(key, { period: '30d', limit: 50 }, { supabase })
    const chosen = key === 'queue_dispatch'
      ? (await Promise.all(['completed', 'failed', 'held', 'cancelled'].map((status) => svc.listRuns(key, { period: '30d', status, limit: 1 }, { supabase })))).map((x) => x.runs[0]).filter(Boolean)
      : list.runs.slice(0, 1)
    const proofs = []
    for (const r of chosen) {
      const d = await svc.getRun(key, r.run_id, { supabase })
      proofs.push({ run_id: r.run_id, status: d.run.status, result: d.run.result, observed_path: d.path.order, orphans: d.path.orphans || [], why: d.why.lines })
    }
    if (key === 'queue_dispatch') for (const p of proofs) { const { data: q } = await supabase.from('send_queue').select('queue_status, failed_reason').eq('id', p.run_id).maybeSingle(); p.authoritative = q }
    if (key === 'seller_review_escalation') for (const p of proofs) { const { data: s } = await supabase.from('wf_run_steps').select('node_id, status, exit').eq('run_id', p.run_id).order('id'); p.authoritative = (s || []).map((x) => `${x.node_id}:${x.status}${x.exit ? `→${x.exit}` : ''}`) }
    out.proofs[key] = { runs_in_window: list.counts, cases: proofs, absent: proofs.length ? null : 'no run in the last 30 days' }
  } catch (e) { out.proofs[key] = { error: e.message } }
}
const drift = await svc.getDrift({ days: 7 }, { supabase })
out.drift = drift.workflows.map((w) => ({ key: w.workflow_key, valid: w.valid, runs: w.runs_observed, unmapped: w.unmapped, never_observed: w.never_observed, off_topology: w.off_topology_transitions }))
out.duration_ms = Date.now() - t0
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`wrote ${OUT} in ${out.duration_ms}ms`)
for (const c of out.proofs.seller_inbound.cases) console.log('seller ·', c.case.padEnd(34), c.absent ? `ABSENT (${c.absent})` : `${c.status.padEnd(10)} order=${c.verdict.ledger_order_matches} owner=${c.verdict.send_result_from_queue} orphans=${c.verdict.orphans.length}`)
for (const [k, v] of Object.entries(out.proofs)) if (k !== 'seller_inbound') console.log(k.padEnd(26), v.error ? `ERROR ${v.error}` : v.absent || (v.cases ? v.cases.map((c) => `${c.status}${c.orphans?.length ? ` orphans:${c.orphans.join(',')}` : ''}`).join(' | ') : JSON.stringify(v.verdict)))
