/**
 * WORKFLOW OBSERVATORY — "I can see the company operating."
 *
 * Read-only. Renders the automations that actually run LeadCommand
 * (system-workflows.js) from each runtime's OWN ledger, plus the Workflow V2
 * studio definitions with an honest runtime status. Nothing here executes,
 * and nothing is inferred when a record can answer:
 *
 *   - a seller reply's send outcome comes from its send_queue row (delivered,
 *     failed, held by health guard, cancelled) — never from a step label;
 *   - a run is "needs you" only when the runtime created a review item;
 *   - "held" names the real policy that held it (auto-reply off, review-only
 *     mode, low confidence), because that is a setting, not a failure;
 *   - a runtime with no heartbeat says so rather than looking healthy.
 *
 * Bounded: every list is capped and windowed; nothing scans full history.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { SYSTEM_WORKFLOWS, outlineOf } from './system-workflows.js'

const clean = (v) => String(v ?? '').trim()
const lower = (v) => clean(v).toLowerCase()
const H = 3600e3
const DAY = 24 * H
const iso = (ms) => new Date(ms).toISOString()
const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }

export const HELD_REASON = {
  auto_reply_mode_disabled: 'Auto-reply is off — the reply waits for you',
  execution_gated: 'Review-only mode — nothing is sent automatically',
  unclear_low_confidence: 'Low confidence — needs a human read',
  opt_out: 'Seller opted out',
  suppressed: 'Contact is suppressed',
  wrong_number: 'Wrong number',
  quiet_hours: 'Outside the contact window',
}
HELD_REASON.automation_review = 'Automation flagged it for review'
const humanReason = (r) => HELD_REASON[lower(r)] || (r ? clean(r).replace(/_/g, ' ') : null)

/** Send truth from the queue row (the only place it lives). */
export function sendOutcome(row) {
  if (!row) return null
  const s = lower(row.queue_status)
  if (['delivered'].includes(s)) return { state: 'delivered', label: 'Reply delivered', tone: 'good', at: row.delivered_at || row.sent_at || null }
  if (['sent'].includes(s)) return { state: 'sent', label: 'Reply sent', tone: 'good', at: row.sent_at || null }
  if (['queued', 'scheduled', 'processing', 'sending', 'claimed'].includes(s)) return { state: 'waiting', label: s === 'scheduled' ? 'Reply scheduled' : 'Reply queued', tone: 'active', at: row.scheduled_for || null }
  if (s.startsWith('failed')) return { state: 'failed', label: 'Reply failed to send', tone: 'bad', reason: row.failed_reason || s }
  if (s.startsWith('blocked')) return { state: 'held', label: s === 'blocked_by_health_guard' ? 'Held by sender health guard' : 'Send blocked', tone: 'attention', reason: s }
  if (['cancelled', 'expired', 'superseded'].includes(s)) return { state: 'superseded', label: 'Reply withdrawn', tone: 'muted', reason: row.failed_reason || s }
  return { state: s || 'unknown', label: s.replace(/_/g, ' '), tone: 'muted' }
}

/** One operating state per seller run, from its steps + queue row. */
export function sellerRunState(steps = [], queueRow = null) {
  const has = (k) => steps.some((s) => s.action_key === k)
  const blockStep = steps.find((s) => s.action_key === 'automation_blocked' || (s.action_key === 'contactability_checked' && s.execution_status === 'blocked'))
  const review = steps.find((s) => s.action_key === 'needs_review_created')
  const failed = steps.find((s) => s.action_key === 'message_failed')
  const send = sendOutcome(queueRow)
  if (send?.state === 'failed' || failed) return { state: 'failed', label: send?.label || 'Reply failed', reason: send?.reason || failed?.block_reason || null }
  if (send) {
    if (send.state === 'waiting') return { state: 'waiting', label: send.label, reason: null }
    if (send.state === 'held') return { state: 'needs_operator', label: send.label, reason: send.reason }
    if (send.state === 'superseded') return { state: 'superseded', label: send.label, reason: send.reason }
    return { state: 'completed', label: send.label, reason: null }
  }
  if (review) return { state: 'needs_operator', label: 'Needs review', reason: humanReason(blockStep?.block_reason || review.block_reason) }
  if (blockStep) return { state: 'held', label: 'Held', reason: humanReason(blockStep.block_reason) }
  if (has('follow_up_scheduled')) return { state: 'waiting', label: 'Follow-up scheduled', reason: null }
  return { state: 'completed', label: 'Handled', reason: null }
}

/** Map a run's steps onto graph nodes → the path it actually took. */
export function pathOf(wf, steps = []) {
  const byKey = new Map()
  // A queue step without a queue row never reached the outbound queue (old ledger rows).
  const hasQueueRow = steps.some((s) => s.action_key === 'message_queued' && s.queue_id)
  for (const s of steps) {
    if (!hasQueueRow && ['message_queued', 'duplicate_send_check', 'message_sent'].includes(s.action_key)) continue
    byKey.set(s.action_key, s)
  }
  const out = {}
  for (const node of wf.nodes) {
    const hit = (node.match || []).map((k) => byKey.get(k)).filter(Boolean)
    if (!hit.length) continue
    const worst = hit.find((s) => s.execution_status === 'failed') || hit.find((s) => s.execution_status === 'blocked') || hit.find((s) => s.execution_status === 'needs_review') || hit[0]
    out[node.id] = { status: worst.execution_status, at: worst.created_at || worst.started_at || null, reason: worst.block_reason || null }
  }
  return out
}

async function heartbeats(db) {
  const keys = ['closing_automation_heartbeat_at', 'campaign_feeder_heartbeat_at', 'queue_processor_heartbeat_at', 'seller_state_reconcile_heartbeat_at', 'email_dispatch_heartbeat_at', 'closing_automation_enabled', 'email_enabled', 'auto_reply_mode', 'followup_automation_mode', 'campaign_mode', 'queue_processor_mode']
  const { data } = await db.from('system_control').select('key, value').in('key', keys)
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]))
}

function beat(at, now, staleMs) {
  const t = ts(at)
  if (t === null) return { state: 'never', at: null }
  return { state: now - t > staleMs ? 'stale' : 'current', at }
}

/* ── seller inbound ─────────────────────────────────────────────────────── */

/**
 * A review item is only "needs you" while its conversation is still open in
 * the Inbox's canonical buckets (needs review / new reply). Once the operator
 * answered or cleared it, it is history, not attention.
 */
async function openThreads(db, threadKeys) {
  const keys = [...new Set(threadKeys.filter(Boolean))]
  if (!keys.length) return new Set()
  const { data, error } = await db.from('v_inbox_thread_state_buckets').select('thread_key, in_needs_review, in_new_replies').in('thread_key', keys.slice(0, 500))
  if (error) return new Set(keys) // unknown → do not hide attention
  return new Set((data || []).filter((r) => r.in_needs_review || r.in_new_replies).map((r) => r.thread_key))
}

async function sellerStats(db, now) {
  const { data } = await db.from('seller_automation_executions').select('id, status, started_at, thread_id').gte('started_at', iso(now - 7 * DAY)).limit(5000)
  const rows = data || []
  const ids = rows.map((r) => r.id)
  const { data: rev } = ids.length ? await db.from('seller_automation_execution_steps').select('execution_id').eq('action_key', 'needs_review_created').in('execution_id', ids.slice(0, 1000)) : { data: [] }
  const reviewIds = new Set((rev || []).map((r) => r.execution_id))
  const threadOf = new Map(rows.map((r) => [r.id, r.thread_id]))
  const reviewThreads = [...new Set([...reviewIds].map((id) => threadOf.get(id)).filter(Boolean))]
  const open = await openThreads(db, reviewThreads)
  const last = rows.map((r) => r.started_at).sort().pop() || null
  return {
    runs_24h: rows.filter((r) => ts(r.started_at) > now - DAY).length,
    runs_7d: rows.length,
    held_7d: rows.filter((r) => r.status === 'blocked').length,
    failed_7d: rows.filter((r) => r.status === 'failed').length,
    needs_review_7d: reviewIds.size,
    needs_you_open: reviewThreads.filter((t) => open.has(t)).length,
    last_run_at: last,
  }
}

async function sellerNodeAggregates(db, wf, now, days = 7) {
  const { data } = await db.from('seller_automation_execution_steps').select('action_key, execution_status').gte('created_at', iso(now - days * DAY)).limit(20000)
  const counts = {}
  for (const node of wf.nodes) counts[node.id] = { passed: 0, blocked: 0, failed: 0, review: 0 }
  const nodeFor = new Map()
  for (const node of wf.nodes) for (const k of node.match || []) nodeFor.set(k, node.id)
  for (const s of data || []) {
    const id = nodeFor.get(s.action_key)
    if (!id) continue
    const c = counts[id]
    if (s.execution_status === 'failed') c.failed++
    else if (s.execution_status === 'blocked') c.blocked++
    else if (s.execution_status === 'needs_review') c.review++
    else c.passed++
  }
  // "Reply sent" is not a ledger fact — it is the queue outcome.
  delete counts.sent
  return counts
}

async function hydrateSellerRuns(db, execs) {
  if (!execs.length) return []
  const ids = execs.map((e) => e.id)
  const threads = [...new Set(execs.map((e) => e.thread_id).filter(Boolean))]
  const props = [...new Set(execs.map((e) => e.property_id).filter(Boolean))]
  const [{ data: steps }, { data: convs }, { data: ps }] = await Promise.all([
    db.from('seller_automation_execution_steps').select('execution_id, action_key, execution_status, block_reason, queue_id, created_at').in('execution_id', ids).limit(ids.length * 30),
    threads.length ? db.from('inbox_thread_state').select('thread_key, seller_display_name').in('thread_key', threads) : { data: [] },
    props.length ? db.from('properties').select('property_id, property_address_full, property_address').in('property_id', props) : { data: [] },
  ])
  const byExec = new Map()
  for (const s of steps || []) (byExec.get(s.execution_id) || byExec.set(s.execution_id, []).get(s.execution_id)).push(s)
  const qids = [...new Set((steps || []).filter((s) => s.action_key === 'message_queued' && s.queue_id).map((s) => s.queue_id))]
  const { data: qrows } = qids.length ? await db.from('send_queue').select('id, queue_status, sent_at, delivered_at, scheduled_for, failed_reason').in('id', qids) : { data: [] }
  const qBy = new Map((qrows || []).map((q) => [String(q.id), q]))
  const nameBy = new Map((convs || []).map((c) => [c.thread_key, c.seller_display_name]))
  const addrBy = new Map((ps || []).map((p) => [p.property_id, p.property_address_full || p.property_address]))
  return execs.map((e) => {
    const st = (byExec.get(e.id) || []).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    const qid = st.find((s) => s.action_key === 'message_queued' && s.queue_id)?.queue_id || null
    const state = sellerRunState(st, qid ? qBy.get(String(qid)) || null : null)
    return {
      id: e.id,
      workflow: 'seller_inbound',
      version: e.workflow_id,
      started_at: e.started_at,
      subject: { kind: 'seller', name: nameBy.get(e.thread_id) || null, property_id: e.property_id, address: addrBy.get(e.property_id) || null, thread_key: e.thread_id },
      stage: e.lifecycle_stage,
      ...state,
      steps: st.length,
    }
  })
}

export async function getSellerRun(db, id) {
  const { data: e } = await db.from('seller_automation_executions').select('*').eq('id', id).maybeSingle()
  if (!e) return null
  const [{ data: steps }] = await Promise.all([
    db.from('seller_automation_execution_steps').select('*').eq('execution_id', id).order('created_at', { ascending: true }).limit(200),
  ])
  const st = steps || []
  const [run] = await hydrateSellerRuns(db, [e])
  const qid = st.find((s) => s.action_key === 'message_queued' && s.queue_id)?.queue_id || null
  const { data: q } = qid ? await db.from('send_queue').select('id, queue_status, sent_at, delivered_at, scheduled_for, failed_reason, message_body, template_id').eq('id', qid).maybeSingle() : { data: null }
  const wf = SYSTEM_WORKFLOWS.seller_inbound
  const path = pathOf(wf, st)
  const send = sendOutcome(q)
  if (send) path.sent = { status: send.state === 'failed' ? 'failed' : send.state === 'held' ? 'blocked' : send.state === 'waiting' ? 'waiting' : send.state === 'superseded' ? 'skipped' : 'succeeded', at: send.at || null, reason: send.reason || null, label: send.label }
  const find = (k) => st.find((s) => s.action_key === k)
  const decision = find('decision_intelligence_evaluated')?.output_summary || {}
  const classified = find('message_classified')
  const facts = find('facts_extracted')?.output_summary?.extracted_facts || {}
  const block = find('automation_blocked') || st.find((s) => s.action_key === 'contactability_checked' && s.execution_status === 'blocked')
  const why = []
  if (classified?.output_summary?.normalized_intent) why.push({ k: 'Seller said', v: humanReason(classified.output_summary.normalized_intent) })
  for (const [k, v] of Object.entries(facts)) {
    const val = v?.value?.amount ?? v?.value ?? v
    if (val !== null && val !== undefined && typeof val !== 'object') why.push({ k: `Fact · ${k.replace(/_/g, ' ')}`, v: k === 'asking_price' ? `$${Number(val).toLocaleString('en-US')}` : String(val) })
  }
  if (decision.stage_before || decision.stage_after) why.push({ k: 'Seller stage', v: `${humanReason(decision.stage_before) || '—'} → ${humanReason(decision.stage_after) || '—'}` })
  const tpl = find('automatic_reply_selected')?.selected_template
  if (tpl) why.push({ k: 'Chosen reply', v: humanReason(tpl) })
  if (block) why.push({ k: 'Held because', v: humanReason(block.block_reason) })
  if (send) why.push({ k: 'Send outcome', v: `${send.label}${send.reason ? ` (${humanReason(send.reason)})` : ''}` })
  return {
    run,
    workflow: { key: wf.key, name: wf.name, version: e.workflow_id },
    path,
    why,
    preview: find('template_rendered')?.rendered_response_preview || q?.message_body || null,
    inbound: classified?.input_summary?.message_preview || null,
    timeline: st.map((s) => ({ at: s.created_at, key: s.action_key, status: s.execution_status, reason: s.block_reason || null, label: labelFor(wf, s.action_key) })).concat(send && send.at ? [{ at: send.at, key: 'send_outcome', status: send.state, label: send.label }] : []),
    links: {
      conversation: e.thread_id ? `/inbox?thread=${encodeURIComponent(e.thread_id)}` : null,
      deal: e.property_id ? `/deal-intelligence?property=${encodeURIComponent(e.property_id)}` : null,
    },
  }
}

function labelFor(wf, key) {
  const node = wf.nodes.find((x) => (x.match || []).includes(key))
  if (!node) return key.replace(/_/g, ' ')
  if (key === 'ownership_denied') return 'Ownership denied'
  if (key === 'ownership_inferred') return 'Ownership inferred'
  if (['temperature_changed', 'disposition_changed', 'contactability_changed', 'operational_status_changed'].includes(key)) return `Lead state · ${key.replace('_changed', '').replace(/_/g, ' ')}`
  return node.label
}

/* ── closing / campaign / email ─────────────────────────────────────────── */

async function closingStats(db) {
  const { data: cases } = await db.from('closing_cases').select('closing_case_id, property_address, terminal_outcome, closed_at, contract_status, automation_paused_at, automation_state, title_acknowledged_at, title_commitment_received_at, clear_to_close_at, updated_at, provenance').limit(500)
  const { data: reqs } = await db.from('closing_email_requests').select('closing_case_id, category, status').limit(2000)
  const live = (cases || []).filter((c) => !c.terminal_outcome && !c.closed_at && !c.provenance?.voided)
  const escalated = live.filter((c) => Object.keys(c.automation_state?.escalations || {}).length)
  return {
    cases: cases || [],
    requests: reqs || [],
    stats: {
      running: live.filter((c) => lower(c.contract_status) === 'fully_executed' && !c.automation_paused_at).length,
      waiting_contract: live.filter((c) => lower(c.contract_status) !== 'fully_executed').length,
      paused: live.filter((c) => c.automation_paused_at).length,
      needs_operator: escalated.length,
      requests_pending: (reqs || []).filter((r) => r.status === 'pending_transport').length,
      finished: (cases || []).length - live.length,
    },
  }
}

async function campaignStats(db) {
  const { data } = await db.from('campaigns').select('id, name, status, updated_at').not('status', 'in', '("archived","deleted")').limit(500)
  const rows = data || []
  const by = (s) => rows.filter((r) => lower(r.status) === s).length
  return { rows, stats: { active: by('active'), scheduled: by('scheduled'), paused: by('paused'), draft: by('draft'), completed: by('completed') } }
}

async function emailStats(db) {
  const { data, error } = await db.from('email_queue').select('queue_status').limit(5000)
  if (error) return { available: false }
  const rows = data || []
  const by = (...s) => rows.filter((r) => s.includes(r.queue_status)).length
  return { available: true, stats: { waiting: by('pending_send', 'scheduled'), sent: by('sent', 'delivered'), needs_operator: by('failed'), superseded: by('superseded', 'cancelled') } }
}

async function studioDefinitions(db, now) {
  const { data: defs } = await db.from('workflow_definitions').select('id, name, definition_key, status, trigger_type, version, updated_at, is_locked, metadata').neq('status', 'archived').limit(200)
  const { data: runs } = await db.from('workflow_runs').select('workflow_definition_id, status, created_at').gte('created_at', iso(now - 30 * DAY)).limit(2000)
  const byDef = new Map()
  for (const r of runs || []) byDef.set(r.workflow_definition_id, (byDef.get(r.workflow_definition_id) || 0) + 1)
  return (defs || []).map((d) => {
    const runs30 = byDef.get(d.id) || 0
    const isTest = /^test[_ ]/i.test(d.name || d.definition_key || '')
    const status = d.status === 'active' ? (runs30 ? 'live' : 'armed_idle') : d.status === 'published' ? 'defined' : d.status
    return {
      id: d.id,
      key: d.definition_key,
      name: d.name,
      kind: 'studio',
      lock: d.is_locked ? 'template' : 'user',
      status,
      runtime_note: status === 'defined'
        ? 'Published but not armed — no production event starts it'
        : status === 'armed_idle' ? 'Armed, but no run in 30 days' : status === 'draft' ? 'Draft' : null,
      trigger: d.trigger_type,
      version: d.version,
      runs_30d: runs30,
      test: isTest,
      updated_at: d.updated_at,
    }
  })
}

/* ── public API ─────────────────────────────────────────────────────────── */

export async function getWorkflowOverview(deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const [hb, seller, closing, campaign, email, studio] = await Promise.all([
    heartbeats(db), sellerStats(db, now), closingStats(db), campaignStats(db), emailStats(db), studioDefinitions(db, now),
  ])
  const system = [
    {
      ...pick(SYSTEM_WORKFLOWS.seller_inbound),
      status: 'live',
      live: { running: 0, waiting: 0, needs_you: seller.needs_you_open, reviewed_7d: seller.needs_review_7d, runs_24h: seller.runs_24h, runs_7d: seller.runs_7d, held_7d: seller.held_7d, failed_7d: seller.failed_7d },
      health: { state: seller.last_run_at ? 'event_driven' : 'idle', last_run_at: seller.last_run_at, note: 'Runs on every seller reply', policy: { auto_reply_mode: hb.auto_reply_mode || null, followup_automation_mode: hb.followup_automation_mode || null } },
    },
    {
      ...pick(SYSTEM_WORKFLOWS.closing_execution),
      status: lower(hb.closing_automation_enabled) === 'false' ? 'paused' : 'live',
      live: { running: closing.stats.running, waiting: closing.stats.waiting_contract, needs_you: closing.stats.needs_operator, paused: closing.stats.paused, pending_requests: closing.stats.requests_pending, finished: closing.stats.finished },
      health: { ...beat(hb.closing_automation_heartbeat_at, now, 15 * 60e3), cadence: 'every 5 min' },
    },
    {
      ...pick(SYSTEM_WORKFLOWS.campaign_execution),
      status: lower(hb.campaign_mode) === 'paused' ? 'paused' : 'live',
      live: { running: campaign.stats.active, waiting: campaign.stats.scheduled, needs_you: 0, paused: campaign.stats.paused },
      health: { ...beat(hb.campaign_feeder_heartbeat_at, now, 15 * 60e3), cadence: 'every 5 min', policy: { campaign_mode: hb.campaign_mode || null } },
    },
    {
      ...pick(SYSTEM_WORKFLOWS.email_dispatch),
      status: !email.available ? 'not_deployed' : lower(hb.email_enabled) === 'true' ? 'live' : 'off',
      live: email.available ? { running: 0, waiting: email.stats.waiting, needs_you: email.stats.needs_operator, sent: email.stats.sent } : null,
      health: { ...beat(hb.email_dispatch_heartbeat_at, now, 5 * 60e3), cadence: 'every minute' },
    },
  ]
  const needsYou = system.reduce((a, w) => a + (w.live?.needs_you || 0), 0)
  return {
    ok: true,
    counts: {
      live: system.filter((w) => w.status === 'live').length + studio.filter((w) => w.status === 'live' && !w.test).length,
      running: system.reduce((a, w) => a + (w.live?.running || 0), 0),
      waiting: system.reduce((a, w) => a + (w.live?.waiting || 0), 0),
      needs_you: needsYou,
    },
    system,
    studio,
    runtime: {
      studio_engine: { state: 'idle', armed: studio.filter((w) => ['live', 'armed_idle'].includes(w.status)).map((w) => ({ name: w.name, test: w.test })), note: 'The Workflow V2 engine carries no production automation; system workflows run in their own runtimes. Armed definitions are test fixtures.' },
      queue_runner: beat(hb.queue_processor_heartbeat_at, now, 5 * 60e3),
      seller_reconcile: beat(hb.seller_state_reconcile_heartbeat_at, now, 15 * 60e3),
    },
    generated_at: iso(now),
  }
}

function pick(wf) {
  return { key: wf.key, name: wf.name, domain: wf.domain, kind: wf.kind, lock: wf.lock, owner: wf.owner, version: wf.version, trigger: wf.trigger, runtime: wf.runtime }
}

export async function getWorkflowDetail(key, { status = null, limit = 40, cursor = null } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const wf = SYSTEM_WORKFLOWS[key]
  if (!wf) return { ok: false, status: 404, error: 'not_found' }
  const base = { ok: true, workflow: { ...pick(wf), description: wf.description, sections: wf.sections || [], nodes: wf.nodes, edges: wf.edges, outline: outlineOf(wf), heartbeat: wf.heartbeat || null, killSwitch: wf.killSwitch || null } }
  if (key === 'seller_inbound') {
    let q = db.from('seller_automation_executions').select('id, workflow_id, status, thread_id, property_id, lifecycle_stage, started_at').order('started_at', { ascending: false }).limit(Math.min(Number(limit) || 40, 100))
    if (cursor) q = q.lt('started_at', cursor)
    const [{ data: execs }, aggregates] = await Promise.all([q, sellerNodeAggregates(db, wf, now)])
    let runs = await hydrateSellerRuns(db, execs || [])
    if (status) runs = runs.filter((r) => r.state === status)
    return { ...base, window_days: 7, aggregates, runs, next_cursor: (execs || []).length ? execs[execs.length - 1].started_at : null }
  }
  if (key === 'closing_execution') {
    const c = await closingStats(db)
    const agg = {}
    for (const node of wf.nodes) agg[node.id] = { passed: 0, waiting: 0, failed: 0, review: 0 }
    for (const r of c.requests) {
      const node = wf.nodes.find((x) => (x.match || []).some((m) => r.category.startsWith(m)))
      if (!node) continue
      if (r.status === 'sent') agg[node.id].passed++
      else if (r.status === 'pending_transport' || r.status === 'claimed') agg[node.id].waiting++
      else if (r.status === 'failed') agg[node.id].failed++
    }
    const runs = c.cases.map((x) => ({
      id: x.closing_case_id,
      workflow: 'closing_execution',
      started_at: x.updated_at,
      subject: { kind: 'closing', address: x.property_address, closing_case_id: x.closing_case_id },
      state: x.terminal_outcome || x.provenance?.voided ? 'cancelled' : x.closed_at ? 'completed' : x.automation_paused_at ? 'paused' : Object.keys(x.automation_state?.escalations || {}).length ? 'needs_operator' : lower(x.contract_status) !== 'fully_executed' ? 'waiting' : 'running',
      label: x.terminal_outcome ? `Closing ${x.terminal_outcome}` : x.closed_at ? 'Closed' : x.automation_paused_at ? 'Automation paused' : lower(x.contract_status) !== 'fully_executed' ? 'Waiting for executed contract' : !x.title_acknowledged_at ? 'Waiting for title acknowledgement' : !x.title_commitment_received_at ? 'Waiting for title commitment' : !x.clear_to_close_at ? 'Waiting for clear to close' : 'Waiting for settlement',
      link: `/closing-desk?case=${encodeURIComponent(x.closing_case_id)}`,
    }))
    return { ...base, aggregates: agg, runs }
  }
  if (key === 'campaign_execution') {
    const c = await campaignStats(db)
    return { ...base, aggregates: {}, runs: c.rows.slice(0, 60).map((r) => ({ id: r.id, workflow: 'campaign_execution', started_at: r.updated_at, subject: { kind: 'campaign', name: r.name }, state: lower(r.status) === 'active' ? 'running' : lower(r.status) === 'scheduled' ? 'waiting' : lower(r.status) === 'paused' ? 'paused' : lower(r.status), label: clean(r.status), link: `/campaigns?campaign=${encodeURIComponent(r.id)}` })) }
  }
  if (key === 'email_dispatch') {
    const e = await emailStats(db)
    return { ...base, aggregates: {}, runs: [], available: e.available, note: e.available ? null : 'Email Command is built but its migrations are not applied yet — nothing has run.' }
  }
  return base
}

export async function getWorkflowRun(key, id, deps = {}) {
  const db = deps.supabase || defaultSupabase
  if (key === 'seller_inbound') {
    const r = await getSellerRun(db, id)
    return r ? { ok: true, ...r } : { ok: false, status: 404, error: 'not_found' }
  }
  return { ok: false, status: 404, error: 'not_inspectable', message: 'Open this run in its own app (Closing Desk / Campaign Command).' }
}

/** Runs that need a human, across system workflows (bounded). */
export async function getWorkflowAttention(deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const { data: rev } = await db.from('seller_automation_execution_steps').select('execution_id, created_at').eq('action_key', 'needs_review_created').gte('created_at', iso(now - 7 * DAY)).order('created_at', { ascending: false }).limit(40)
  const ids = [...new Set((rev || []).map((r) => r.execution_id))]
  const { data: execs } = ids.length ? await db.from('seller_automation_executions').select('id, workflow_id, status, thread_id, property_id, lifecycle_stage, started_at').in('id', ids) : { data: [] }
  const open = await openThreads(db, (execs || []).map((e) => e.thread_id))
  const latest = new Map()
  for (const e of (execs || []).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))) if (open.has(e.thread_id) && !latest.has(e.thread_id)) latest.set(e.thread_id, e)
  const runs = (await hydrateSellerRuns(db, [...latest.values()])).filter((r) => r.state === 'needs_operator' || r.state === 'failed')
  const c = await closingStats(db)
  const closing = c.cases.filter((x) => Object.keys(x.automation_state?.escalations || {}).length && !x.terminal_outcome && !x.closed_at).map((x) => ({ id: x.closing_case_id, workflow: 'closing_execution', subject: { kind: 'closing', address: x.property_address }, state: 'needs_operator', label: 'Title/buyer went silent — escalated', link: `/closing-desk?case=${encodeURIComponent(x.closing_case_id)}` }))
  return { ok: true, items: [...closing, ...runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))] }
}
