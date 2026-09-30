/**
 * SELLER CONVERSATION · INBOUND adapter.
 *
 * Run identity = seller_automation_executions.id (one inbound seller message).
 * Path = the run's ledger steps mapped through the topology's evidence keys,
 * plus facts other runtimes OWN:
 *   - the reply's send result comes from its send_queue row (queue owns it),
 *     including the canonical review hold (paused_operator_review);
 *   - "needs you" is true only while the conversation is still open in the
 *     Inbox's canonical buckets (v_inbox_thread_state_buckets);
 *   - negotiation is evidenced by the negotiation engine's own events.
 * A ledger label never overrules those owners.
 */
import { SELLER_INBOUND as T } from '../topologies/seller.js'
import { evidenceIndex, human, cap, DAY, iso } from '../core.js'
import { HELD_REASON, openThreads, sendOutcome } from '../../observatory-service.js'
import { clean, lower, nodeEvents, runRow, safe, sellerNames, subject } from './shared.js'

const KEY = 'seller_inbound'
const RT = 'seller-flow orchestrator'
const IDX = evidenceIndex(T)
const lab = (v) => cap(human(v))
const inbox = (tk) => (tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null)
const reasonText = (r) => HELD_REASON[lower(r)] || (r ? cap(lab(r)) : null)
const chunk = (arr, n = 150) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out }
const WAITING_Q = ['queued', 'scheduled', 'processing', 'sending', 'claimed', 'pending', 'retry', 'locked']

async function inChunks(db, table, cols, col, ids, degraded, extra = (q) => q) {
  const out = []
  for (const part of chunk([...new Set(ids.filter(Boolean).map(String))])) out.push(...await safe(extra(db.from(table).select(cols).in(col, part)), degraded, table))
  return out
}

const DATE = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' }) : null }

/** Pure: one execution + its steps (+ owners' facts) → observed run. */
export function projectSellerRun(ex, steps, { queue = null, open = false, negotiation = [], name = null, address = null, intel = null } = {}) {
  const { push, events } = nodeEvents(KEY, ex.id, RT)
  const st = [...steps].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)))
  const has = (k) => st.find((s) => s.action_key === k)
  const decisionAt = has('decision_intelligence_evaluated')?.created_at || ex.started_at
  const hasQueueRow = st.some((s) => s.action_key === 'message_queued' && s.queue_id)
  for (const s of st) {
    // legacy ledger rows claimed "queued/sent" without a queue row — not a send
    if (!hasQueueRow && ['message_queued', 'duplicate_send_check', 'message_sent'].includes(s.action_key)) continue
    if (s.action_key === 'message_sent') continue // the ledger's label; send truth is the queue row
    const nk = IDX.get(s.action_key)
    if (!nk) continue
    const label = s.action_key === 'decision_intelligence_evaluated' && s.output_summary?.stage_after
      ? (s.output_summary.stage_before && s.output_summary.stage_before !== s.output_summary.stage_after ? `${lab(s.output_summary.stage_before)} → ${lab(s.output_summary.stage_after)}` : `stays ${lab(s.output_summary.stage_after)}`)
      : s.action_key === 'message_classified' && s.output_summary?.normalized_intent ? lab(s.output_summary.normalized_intent)
      : s.action_key === 'automatic_reply_selected' ? `YES · ${lab(s.selected_template || '')}`.trim()
      : s.action_key === 'follow_up_scheduled' && s.output_summary?.follow_up_at ? `for ${DATE(s.output_summary.follow_up_at)}`
      : s.action_key.startsWith('ownership_') ? lab(s.action_key)
      : null
    push(nk, s.execution_status, s.created_at, { id: `${ex.id}:${s.id || s.action_key}`, reason: s.block_reason || null, label, ref: s.action_key })
    if (s.action_key === 'decision_intelligence_evaluated') {
      for (const ev of negotiation) push('offer_negotiation', ev.status || 'succeeded', ev.created_at, { id: `neg:${ev.id}`, label: lab(ev.event_type), ref: `automation_events:${ev.event_type}` })
      if (!has('automatic_reply_selected')) push('reply_warranted', 'succeeded', s.created_at, { id: `${ex.id}:reply_decision`, label: 'NO · no reply this turn', ref: 'reply_decision' })
    }
    if (s.action_key === 'automation_blocked' && lower(s.block_reason) === 'opt_out') push('opt_out_dnc', 'succeeded', s.created_at, { id: `${ex.id}:opt_out`, label: 'suppression applied', ref: 'opt_out' })
  }
  let send = null
  if (queue) {
    send = sendOutcome(queue)
    const s = lower(queue.queue_status)
    const hand = queue.created_at || decisionAt
    if (s === 'paused_operator_review') {
      push('dispatch_handoff', 'succeeded', hand, { label: 'review hold', ref: 'send_queue:review_hold' })
      push('approval_hold', 'human', queue.held_at || hand, { reason: 'reply drafted — awaiting operator approval', ref: 'send_queue:review_hold' })
    } else {
      const released = Boolean(queue.approved_at || queue.held_at)
      if (send.state === 'failed') { push('dispatch_handoff', 'failed', queue.updated_at || hand, { reason: queue.failed_reason || s }); push('reply_failed', 'failed', queue.updated_at || hand, { reason: queue.failed_reason || s }) }
      else if (send.state === 'held') push('dispatch_handoff', 'held', queue.updated_at || hand, { reason: s === 'blocked_by_health_guard' ? `sender health guard${queue.failed_reason ? ` · ${lab(queue.failed_reason)}` : ''}` : lab(s) })
      else if (send.state === 'waiting') push('dispatch_handoff', 'waiting', hand, { label: send.label })
      else if (send.state === 'superseded') push('dispatch_handoff', 'succeeded', queue.updated_at || hand, { label: `withdrawn · ${lab(s)}` })
      else {
        push('dispatch_handoff', 'succeeded', hand, { label: send.label, duration_ms: queue.delivered_at && queue.created_at ? Date.parse(queue.delivered_at) - Date.parse(queue.created_at) : null })
        if (released) push('approval_hold', 'succeeded', queue.approved_at || queue.held_at, { label: 'released by operator' })
        push('reply_delivered', 'succeeded', queue.delivered_at || queue.sent_at || hand, { label: send.label })
      }
    }
  }
  const lastStep = st[st.length - 1]
  push('run_recorded', 'succeeded', ex.completed_at || lastStep?.created_at || ex.started_at, { id: `${ex.id}:end`, ref: 'run_completed' })

  // ── status (owners first) ──
  const review = has('needs_review_created')
  const block = st.find((s) => s.action_key === 'automation_blocked') || st.find((s) => s.action_key === 'contactability_checked' && s.execution_status === 'blocked')
  const failedStep = has('message_failed')
  const fu = has('follow_up_scheduled')?.output_summary?.follow_up_at || null
  const decision = has('decision_intelligence_evaluated')?.output_summary || {}
  const stageLine = decision.stage_after ? (decision.stage_before && decision.stage_before !== decision.stage_after ? `Stage ${lab(decision.stage_before)} → ${lab(decision.stage_after)}` : `Stage stayed ${lab(decision.stage_after)}`) : null
  let status = 'completed'; let result = 'Handled'; let reason = null; let current = null; let human_ = Boolean(review)
  const qs = lower(queue?.queue_status)
  if (review && open) { status = 'needs_you'; result = 'Needs your review'; reason = reasonText(block?.block_reason || review.block_reason); current = 'human_review' }
  else if (queue && qs === 'paused_operator_review') { status = open ? 'needs_you' : 'held'; result = 'Reply drafted — awaiting approval'; reason = reasonText(block?.block_reason) || 'Review hold'; current = 'approval_hold'; human_ = true }
  else if (send?.state === 'failed') { status = 'failed'; result = 'Reply failed to send'; reason = lab(queue.failed_reason || qs) }
  else if (send?.state === 'held') { status = 'held'; result = send.label; reason = lab(qs); current = 'dispatch_handoff' }
  else if (send?.state === 'waiting') { status = 'waiting'; result = send.label; current = 'dispatch_handoff' }
  else if (send?.state === 'superseded') { status = 'cancelled'; result = 'Reply withdrawn'; reason = lab(queue.failed_reason || qs) }
  else if (send) { status = 'completed'; result = send.label }
  else if (failedStep) { status = 'failed'; result = 'Reply could not be queued'; reason = lab(failedStep.error_details?.reason || 'enqueue failed') }
  else if (block) { status = review ? 'completed' : 'held'; result = review ? 'Held, then handled by a person' : 'Held by policy — no reply sent'; reason = reasonText(block.block_reason) }
  else if (fu && Date.parse(fu) > Date.now()) { status = 'waiting'; result = `Follow-up scheduled ${DATE(fu)}`; current = 'schedule_follow_up' }
  const facts = []
  if (intel?.intent) facts.push(`Intent ${lab(intel.intent)}${intel.confidence ? ` ${Math.round(Number(intel.confidence) * 100)}%` : ''}`)
  if (stageLine) facts.push(stageLine)
  if (queue) facts.push(result)
  else if (block) facts.push(`No reply · ${reasonText(block.block_reason)}`)
  if (fu) facts.push(`Follow-up ${DATE(fu)}`)
  if (review) facts.push(open ? 'Needs review' : 'Reviewed')
  return {
    run: runRow({
      run_id: ex.id, workflow_key: KEY, version: ex.workflow_id || null, started_at: ex.started_at, finished_at: ex.completed_at || lastStep?.created_at || null,
      subject: subject('seller', ex.thread_id, name, address, inbox(ex.thread_id)), trigger: 'Seller replied', status, human: human_,
      current_node: ['needs_you', 'waiting', 'held', 'running'].includes(status) ? current : null,
      final_node: queue ? (send?.state === 'failed' ? 'reply_failed' : send?.state === 'waiting' || send?.state === 'held' ? 'dispatch_handoff' : 'reply_delivered') : 'run_recorded',
      result, reason,
    }),
    events,
    facts,
    raw: ex,
  }
}

async function context(db, execs, steps, degraded, { since = null } = {}) {
  const qids = [...new Set(steps.filter((s) => s.action_key === 'message_queued' && s.queue_id).map((s) => String(s.queue_id)))]
  const queue = qids.length ? await inChunks(db, 'send_queue', 'id, queue_status, created_at, updated_at, sent_at, delivered_at, scheduled_for, failed_reason, held_at, approved_at, message_body, template_id', 'id', qids, degraded) : []
  const reviewThreads = [...new Set(execs.filter((e) => steps.some((s) => s.execution_id === e.id && (s.action_key === 'needs_review_created')) || queue.some((q) => lower(q.queue_status) === 'paused_operator_review')).map((e) => e.thread_id))]
  const open = reviewThreads.length ? await openThreads(db, reviewThreads) : new Set()
  const threads = [...new Set(execs.map((e) => e.thread_id).filter(Boolean))]
  const nm = await sellerNames(db, threads, execs.map((e) => e.property_id), degraded)
  const from = since || iso(Math.min(...execs.map((e) => Date.parse(e.started_at))) - 60e3)
  const neg = threads.length ? await inChunks(db, 'automation_events', 'id, event_type, conversation_thread_id, created_at, status', 'conversation_thread_id', threads, degraded, (q) => q.eq('source', 'seller_negotiation_engine').gte('created_at', from).limit(600)) : []
  const inbound = [...new Set(execs.map((e) => e.source_message_id).filter(Boolean))]
  const intel = inbound.length ? await inChunks(db, 'message_events', 'id, intent:metadata->>detected_intent, confidence:metadata->>classification_confidence, emotion:metadata->payload->metadata->>emotion, language:metadata->>language, next_action:metadata->automation_decision->>next_action, reply_mode:metadata->automation_decision->>reply_mode, message_body', 'id', inbound, degraded) : []
  return { queue: new Map(queue.map((q) => [String(q.id), q])), open, nm, neg, intel: new Map(intel.map((m) => [String(m.id), m])) }
}

function assemble(execs, steps, ctx) {
  const byExec = new Map()
  for (const s of steps) (byExec.get(s.execution_id) || byExec.set(s.execution_id, []).get(s.execution_id)).push(s)
  // an open conversation needs a person ONCE — on its latest run; earlier runs were carried forward by the next reply
  const latest = ctx.latest || new Map()
  if (!ctx.latest) for (const e of execs) { const cur = latest.get(e.thread_id); if (!cur || String(e.started_at) > String(cur.started_at)) latest.set(e.thread_id, e) }
  return execs.map((ex) => {
    const st = byExec.get(ex.id) || []
    const qid = st.find((s) => s.action_key === 'message_queued' && s.queue_id)?.queue_id
    const t0 = Date.parse(ex.started_at)
    const t1 = Date.parse(ex.completed_at || st[st.length - 1]?.created_at || ex.started_at)
    const negotiation = ctx.neg.filter((n) => n.conversation_thread_id === ex.thread_id && Date.parse(n.created_at) >= t0 - 90e3 && Date.parse(n.created_at) <= t1 + 90e3)
    return projectSellerRun(ex, st, { queue: qid ? ctx.queue.get(String(qid)) || null : null, open: ctx.open.has(ex.thread_id) && latest.get(ex.thread_id)?.id === ex.id, negotiation, name: ctx.nm.name(ex.thread_id), address: ctx.nm.address(ex.thread_id, ex.property_id), intel: ctx.intel.get(String(ex.source_message_id)) || null })
  })
}

const EXEC_COLS = 'id, workflow_id, status, thread_id, property_id, source_message_id, lifecycle_stage, started_at, completed_at'
const STEP_COLS = 'id, execution_id, action_key, execution_status, block_reason, queue_id, selected_template, output_summary, error_details, created_at'

export const sellerAdapter = {
  key: KEY,
  topology: T,
  source_runtime: RT,
  notes: ['Seller steps are written by a recorder after each run, so per-step latency is not measured; the reply’s time to delivery is (send_queue).'],

  async load(db, { since, until = null, limit = 400, degraded = [] }) {
    let q = db.from('seller_automation_executions').select(EXEC_COLS).gte('started_at', since).order('started_at', { ascending: false }).limit(Math.min(limit, 1500))
    if (until) q = q.lt('started_at', until)
    const execs = await safe(q, degraded, 'seller_automation_executions')
    if (!execs.length) return []
    const steps = await inChunks(db, 'seller_automation_execution_steps', STEP_COLS, 'execution_id', execs.map((e) => e.id), degraded, (x) => x.limit(6000))
    const ctx = await context(db, execs, steps, degraded, { since })
    return assemble(execs, steps, ctx)
  },

  async summary(db, { now, dayStart, degraded = [] }) {
    const rows = await safe(db.from('seller_automation_executions').select('id, status, started_at').gte('started_at', iso(now - 7 * DAY)).order('started_at', { ascending: false }).limit(3000), degraded, 'seller_automation_executions')
    return {
      runs_today: rows.filter((r) => String(r.started_at) >= dayStart).length,
      runs_24h: rows.filter((r) => Date.parse(r.started_at) > now - DAY).length,
      runs_7d: rows.length,
      failed_24h: rows.filter((r) => r.status === 'failed' && Date.parse(r.started_at) > now - DAY).length,
      last_run_at: rows[0]?.started_at || null,
    }
  },

  latency(observed) {
    const d = []
    for (const o of observed) for (const e of o.events) if (e.node_key === 'dispatch_handoff' && Number.isFinite(e.duration_ms) && e.duration_ms >= 0) d.push(e.duration_ms)
    return { dispatch_handoff: d }
  },

  headline(o) {
    return { headline: `Seller conversation · ${o.run.subject.name || o.run.subject.address || o.run.subject.id || 'seller'}`, facts: o.facts }
  },

  async detail(db, id, { degraded = [] } = {}) {
    const { data: ex } = await db.from('seller_automation_executions').select(EXEC_COLS).eq('id', clean(id)).maybeSingle()
    if (!ex) return null
    const steps = await safe(db.from('seller_automation_execution_steps').select(`${STEP_COLS}, input_summary, rendered_response_preview`).eq('execution_id', ex.id).order('created_at', { ascending: true }).limit(200), degraded, 'seller_automation_execution_steps')
    const ctx = await context(db, [ex], steps, degraded)
    const newest = ex.thread_id ? await safe(db.from('seller_automation_executions').select('id, started_at').eq('thread_id', ex.thread_id).order('started_at', { ascending: false }).limit(1), degraded, 'seller_automation_executions') : []
    ctx.latest = new Map([[ex.thread_id, newest[0] || ex]])
    const [o] = assemble([ex], steps, ctx)
    const find = (k) => steps.find((s) => s.action_key === k)
    const intel = ctx.intel.get(String(ex.source_message_id)) || null
    const q = o.events.some((e) => e.node_key === 'dispatch_handoff') ? ctx.queue.get(String(find('message_queued')?.queue_id)) : null
    const cls = find('message_classified')?.output_summary || {}
    const factsRaw = find('facts_extracted')?.output_summary?.extracted_facts || {}
    const dec = find('decision_intelligence_evaluated')?.output_summary || {}
    const block = find('automation_blocked') || steps.find((s) => s.action_key === 'contactability_checked' && s.execution_status === 'blocked')
    const review = find('needs_review_created')
    const facts = []
    for (const [k, v] of Object.entries(factsRaw)) {
      const val = v?.value?.amount ?? v?.value ?? v
      if (val === null || val === undefined || val === false || typeof val === 'object') continue
      facts.push({ k: cap(lab(k)), v: k === 'asking_price' ? `$${Number(val).toLocaleString('en-US')}` : String(val), source: 'seller fact store (facts_extracted)' })
    }
    if (cls.ownership_signal) facts.push({ k: 'Ownership', v: lab(cls.ownership_signal), source: 'classification' })
    const decisions = []
    if (dec.stage_after) decisions.push({ k: 'Seller stage', v: dec.stage_before && dec.stage_before !== dec.stage_after ? `${lab(dec.stage_before)} → ${lab(dec.stage_after)}` : `Stayed ${lab(dec.stage_after)}`, source: 'canonical seller decision' })
    if (dec.operational_status) decisions.push({ k: 'Lead status', v: lab(dec.operational_status), source: 'canonical seller decision' })
    const tpl = find('automatic_reply_selected')?.selected_template
    decisions.push({ k: 'Reply', v: tpl ? `Template ${lab(tpl)}` : 'No reply this turn', source: 'decision → template selection' })
    decisions.push({ k: 'Contactable now', v: block ? `Held — ${reasonText(block.block_reason)}` : 'Clear', source: 'contactability / automation policy' })
    if (intel?.next_action) decisions.push({ k: 'Next action', v: lab(intel.next_action), source: 'automation_decision (planned)' })
    const fu = find('follow_up_scheduled')?.output_summary?.follow_up_at
    if (fu) decisions.push({ k: 'Follow-up', v: new Date(fu).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }), source: 'follow-up scheduler' })
    if (review) decisions.push({ k: 'Human review', v: `${o.run.status === 'needs_you' ? 'Open' : ctx.open.has(ex.thread_id) ? 'Carried to a later reply' : 'Handled'} · ${reasonText(review.block_reason) || 'automation review'}`, source: 'Inbox review bucket' })
    const ai = []
    if (intel?.intent || cls.normalized_intent) ai.push({ k: 'Intent', v: `${lab(intel?.intent || cls.normalized_intent)}${intel?.confidence ? ` · ${Math.round(Number(intel.confidence) * 100)}% confidence` : ''}` })
    if (intel?.emotion) ai.push({ k: 'Sentiment', v: lab(intel.emotion) })
    if (intel?.language) ai.push({ k: 'Language', v: intel.language })
    if (intel?.reply_mode) ai.push({ k: 'Reply mode', v: lab(intel.reply_mode) })
    const why = sellerWhy(o.run, { block, review, open: o.run.status === 'needs_you', dec, intel, queue: q, send: q ? sendOutcome(q) : null, tpl })
    return {
      ...o,
      why,
      facts,
      decisions,
      ai,
      inputs: [
        ...(intel?.message_body ? [{ k: 'Seller wrote', v: String(intel.message_body).slice(0, 280) }] : []),
        { k: 'Conversation', v: ex.thread_id || '—' },
      ],
      outputs: [
        ...(find('template_rendered')?.rendered_response_preview || q?.message_body ? [{ k: 'Reply', v: String(find('template_rendered')?.rendered_response_preview || q?.message_body).slice(0, 280) }] : []),
        ...(q ? [{ k: 'Queue row', v: `${lab(q.queue_status)}${q.failed_reason ? ` · ${lab(q.failed_reason)}` : ''}` }] : []),
        ...(find('notification_emitted')?.output_summary?.events?.length ? [{ k: 'Notifications', v: find('notification_emitted').output_summary.events.map(human).join(', ') }] : []),
      ],
      links: [
        ...(ex.thread_id ? [{ label: 'Open conversation', href: inbox(ex.thread_id), app: 'Inbox' }] : []),
        ...(ex.property_id ? [{ label: 'Open deal', href: `/deal-intelligence?property=${encodeURIComponent(ex.property_id)}`, app: 'Deal Intelligence' }] : []),
        ...(q ? [{ label: 'Open queue row', href: `/queue?row=${encodeURIComponent(q.id)}`, app: 'Queue' }] : []),
      ],
      technical: { execution_id: ex.id, workflow_id: ex.workflow_id, ledger_status: ex.status, steps: steps.length, queue_id: q?.id || null, source_message_id: ex.source_message_id, lifecycle_stage: ex.lifecycle_stage },
    }
  },

  /** Right now: open reviews and review-held replies need a person; queued replies are in flight. */
  async current(db, { now = Date.now(), degraded = [] } = {}) {
    const since = iso(now - 7 * DAY)
    const [rev, holds, pending] = await Promise.all([
      safe(db.from('seller_automation_execution_steps').select('execution_id, block_reason, created_at').eq('action_key', 'needs_review_created').gte('created_at', since).order('created_at', { ascending: false }).limit(200), degraded, 'seller_automation_execution_steps'),
      safe(db.from('send_queue').select('id, thread_key, created_at, held_at, seller_display_name, property_address').eq('queue_status', 'paused_operator_review').gte('created_at', since).limit(200), degraded, 'send_queue'),
      safe(db.from('send_queue').select('id, thread_key, queue_status, scheduled_for, created_at, source, seller_display_name').in('source', ['auto_reply', 'seller_inbound_orchestrator']).in('queue_status', WAITING_Q).limit(300), degraded, 'send_queue'),
    ])
    const execIds = [...new Set(rev.map((r) => r.execution_id))]
    const execs = execIds.length ? await inChunks(db, 'seller_automation_executions', 'id, thread_id, property_id, started_at', 'id', execIds, degraded) : []
    const threads = [...new Set([...execs.map((e) => e.thread_id), ...holds.map((h) => h.thread_key)].filter(Boolean))]
    const open = threads.length ? await openThreads(db, threads) : new Set()
    const nm = await sellerNames(db, [...threads, ...pending.map((p) => p.thread_key)], execs.map((e) => e.property_id), degraded)
    // a conversation needs a person when its LATEST run asked for review and it is still open —
    // exactly the rule the runs ledger applies, so the rail and the run never disagree
    const openThreadsList = [...new Set(execs.map((e) => e.thread_id).filter((t) => open.has(t)))]
    const recentOnOpen = openThreadsList.length ? await inChunks(db, 'seller_automation_executions', 'id, thread_id, property_id, started_at', 'thread_id', openThreadsList, degraded, (q) => q.gte('started_at', since)) : []
    const newest = new Map()
    for (const e of recentOnOpen) { const cur = newest.get(e.thread_id); if (!cur || String(e.started_at) > String(cur.started_at)) newest.set(e.thread_id, e) }
    const reviewed = new Set(rev.map((r) => r.execution_id))
    const latest = new Map()
    for (const [tk, e] of newest) if (reviewed.has(e.id)) latest.set(tk, e)
    const reason = new Map(rev.map((r) => [r.execution_id, r.block_reason]))
    const blockRows = latest.size ? await inChunks(db, 'seller_automation_execution_steps', 'execution_id, block_reason', 'execution_id', [...latest.values()].map((e) => e.id), degraded, (q) => q.eq('action_key', 'automation_blocked')) : []
    const blockBy = new Map(blockRows.map((b) => [b.execution_id, b.block_reason]))
    const needs = [...latest.values()].map((e) => ({ run_id: e.id, node_key: 'human_review', subject: subject('seller', e.thread_id, nm.name(e.thread_id), nm.address(e.thread_id, e.property_id), inbox(e.thread_id)), reason: reasonText(blockBy.get(e.id)) || reasonText(reason.get(e.id)) || 'Automation flagged it for review', since: e.started_at, href: inbox(e.thread_id) }))
    for (const h of holds) if (open.has(h.thread_key) && !latest.has(h.thread_key)) needs.push({ run_id: `queue:${h.id}`, node_key: 'approval_hold', subject: subject('seller', h.thread_key, h.seller_display_name || nm.name(h.thread_key), h.property_address || nm.address(h.thread_key), inbox(h.thread_key)), reason: 'Reply drafted — awaiting your approval', since: h.held_at || h.created_at, href: inbox(h.thread_key) })
    return {
      // pending replies/follow-ups are queue rows — the queue owns messages in flight; the seller flow owns its open reviews
      in_flight: needs.length,
      needs_you: needs,
      live: [
        ...pending.map((p) => ({ run_id: `queue:${p.id}`, node_key: p.source === 'seller_inbound_orchestrator' ? 'schedule_follow_up' : 'dispatch_handoff', status: 'waiting', subject: subject('seller', p.thread_key, p.seller_display_name || nm.name(p.thread_key), null, inbox(p.thread_key)), since: p.created_at, detail: p.source === 'seller_inbound_orchestrator' ? `follow-up due ${DATE(p.scheduled_for) || '—'}` : lab(p.queue_status) })),
        ...needs.map((n) => ({ run_id: n.run_id, node_key: n.node_key, status: 'needs_you', subject: n.subject, since: n.since, detail: n.reason })),
      ],
    }
  },

  /** Ledger keys this runtime wrote that no topology node claims (drift monitor). */
  async unmapped(db, { since, degraded = [] }) {
    const rows = await safe(db.from('seller_automation_execution_steps').select('action_key').gte('created_at', since).limit(20000), degraded, 'seller_automation_execution_steps')
    const counts = new Map()
    for (const r of rows) if (!IDX.has(r.action_key) && r.action_key !== 'message_sent') counts.set(r.action_key, (counts.get(r.action_key) || 0) + 1)
    return [...counts.entries()].map(([key, count]) => ({ source_key: key, count }))
  },
}

/** WHY, in business language, from the owners' facts. */
export function sellerWhy(run, { block, review, open, dec, intel, queue, send, tpl }) {
  const lines = []
  const stage = dec?.stage_after ? (dec.stage_before && dec.stage_before !== dec.stage_after ? `stage ${lab(dec.stage_before)} → ${lab(dec.stage_after)}` : `stage remained ${lab(dec.stage_after)}`) : null
  if (run.status === 'needs_you' || run.status === 'held') {
    if (block) lines.push(reasonText(block.block_reason))
    if (intel?.intent) lines.push(`seller said ${human(intel.intent)}${intel.confidence ? ` (${Math.round(Number(intel.confidence) * 100)}% confidence)` : ''}`)
    if (stage) lines.push(stage)
    lines.push(queue && lower(queue.queue_status) === 'paused_operator_review' ? 'reply drafted — waiting for approval' : 'no reply sent')
    if (review) lines.push(open ? 'human review required' : 'reviewed by a person')
    return { headline: run.status === 'needs_you' ? 'WHY IT NEEDS YOU' : 'WHY HELD', tone: run.status === 'needs_you' ? 'human' : 'held', lines: lines.filter(Boolean) }
  }
  if (run.status === 'failed') {
    lines.push(send?.reason ? `reply failed — ${human(send.reason)}` : 'reply could not be sent')
    if (stage) lines.push(stage)
    return { headline: 'WHY IT FAILED', tone: 'bad', lines }
  }
  if (intel?.intent) lines.push(`seller said ${human(intel.intent)}${intel.confidence ? ` (${Math.round(Number(intel.confidence) * 100)}%)` : ''}`)
  if (stage) lines.push(stage)
  if (tpl) lines.push(`reply “${lab(tpl)}” ${send ? send.label.toLowerCase() : 'chosen'}`)
  else lines.push('no reply needed this turn')
  if (review) lines.push('a person reviewed it')
  return { headline: run.status === 'waiting' ? 'WHY IT IS WAITING' : run.status === 'cancelled' ? 'WHY IT STOPPED' : 'WHY IT COMPLETED', tone: run.status === 'waiting' ? 'active' : run.status === 'cancelled' ? 'muted' : 'good', lines }
}
