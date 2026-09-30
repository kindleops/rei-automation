/**
 * Seller subworkflows: Opt-out & DNC, and Offer Negotiation (S3–S6).
 *
 *  DNC          run = the seller run that recorded block reason `opt_out`; the
 *               suppression row (compliance), the SUPPRESSION_APPLIED event and
 *               the contactability change are joined by thread + time.
 *  Negotiation  run = one burst of seller_negotiation_engine events for one
 *               conversation (one orchestrator invocation, ≤ 3 min apart).
 */
import { DNC_OPT_OUT, OFFER_NEGOTIATION } from '../topologies/seller.js'
import { evidenceIndex, human } from '../core.js'
import { clean, nodeEvents, runRow, safe, sellerNames, subject, timestampSummary } from './shared.js'
import { DAY, iso } from '../core.js'

const inbox = (tk) => (tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null)
const near = (a, b, ms) => Math.abs(Date.parse(a) - Date.parse(b)) <= ms

/* ── DNC ─────────────────────────────────────────────────────────────────── */

function dncRun(ex, steps, { suppression = null, busEvent = null, notification = null, name = null, address = null } = {}) {
  const K = 'dnc_opt_out'
  const { push, events } = nodeEvents(K, ex.id, 'seller-flow orchestrator')
  const block = steps.find((s) => s.action_key === 'automation_blocked')
  const contact = steps.find((s) => s.action_key === 'contactability_changed')
  push('opt_out_received', 'succeeded', ex.started_at, { label: 'opt-out intent' })
  push('replies_blocked', 'succeeded', block?.created_at || ex.started_at, { label: 'no automatic reply' })
  if (suppression) push('apply_suppression', 'succeeded', suppression.created_at, { label: human(suppression.suppression_type || suppression.reason || 'suppressed') })
  else push('apply_suppression', 'waiting', block?.created_at || ex.started_at, { reason: 'no suppression row found for this number near the run' })
  if (busEvent) push('suppression_event', 'succeeded', busEvent.created_at)
  if (contact) push('mark_uncontactable', 'succeeded', contact.created_at, { label: human(contact.output_summary?.contactability || '') })
  if (notification) push('notify_opt_out', 'succeeded', notification.created_at)
  if (suppression) { push('send_recheck', 'succeeded', suppression.created_at, { label: 'enforced at dispatch' }); push('suppressed', 'succeeded', suppression.created_at) }
  return {
    run: runRow({ run_id: ex.id, workflow_key: K, version: ex.workflow_id || null, started_at: ex.started_at, finished_at: suppression?.created_at || ex.completed_at || null, subject: subject('seller', ex.thread_id, name, address, inbox(ex.thread_id)), trigger: 'Seller opted out', status: suppression ? 'completed' : 'held', final_node: suppression ? 'suppressed' : 'apply_suppression', result: suppression ? 'Number suppressed' : 'Opt-out recorded · suppression row not found', reason: suppression ? null : 'Check the suppression list for this number' }),
    events,
  }
}

async function loadDnc(db, { since, until = null, limit = 200, degraded = [], id = null }) {
  let q = db.from('seller_automation_execution_steps').select('execution_id, created_at').eq('action_key', 'automation_blocked').eq('block_reason', 'opt_out').order('created_at', { ascending: false }).limit(limit)
  if (id) q = q.eq('execution_id', id)
  else { q = q.gte('created_at', since); if (until) q = q.lt('created_at', until) }
  const hits = await safe(q, degraded, 'seller_automation_execution_steps')
  const ids = [...new Set(hits.map((h) => h.execution_id))]
  if (!ids.length) return []
  const [execs, steps] = await Promise.all([
    safe(db.from('seller_automation_executions').select('id, workflow_id, thread_id, property_id, started_at, completed_at').in('id', ids), degraded, 'seller_automation_executions'),
    safe(db.from('seller_automation_execution_steps').select('execution_id, action_key, execution_status, block_reason, output_summary, created_at').in('execution_id', ids).in('action_key', ['automation_blocked', 'contactability_changed']), degraded, 'seller_automation_execution_steps'),
  ])
  const threads = [...new Set(execs.map((e) => e.thread_id).filter(Boolean))]
  const [sup, bus, notes] = threads.length ? await Promise.all([
    safe(db.from('sms_suppression_list').select('id, phone_e164, suppression_type, reason, created_at').in('phone_e164', threads).limit(500), degraded, 'sms_suppression_list'),
    safe(db.from('automation_events').select('id, conversation_thread_id, created_at').eq('event_type', 'SUPPRESSION_APPLIED').in('conversation_thread_id', threads).limit(500), degraded, 'automation_events'),
    safe(db.from('notification_events').select('id, source_entity_id, created_at').eq('event_type', 'inbox_opt_out_received').in('source_entity_id', threads).limit(500), degraded, 'notification_events'),
  ]) : [[], [], []]
  const nm = await sellerNames(db, threads, execs.map((e) => e.property_id), degraded)
  const W = 10 * 60e3
  return execs.map((ex) => dncRun(ex, steps.filter((s) => s.execution_id === ex.id), {
    suppression: sup.find((s) => s.phone_e164 === ex.thread_id && near(s.created_at, ex.started_at, W)) || null,
    busEvent: bus.find((b) => b.conversation_thread_id === ex.thread_id && near(b.created_at, ex.started_at, W)) || null,
    notification: notes.find((n) => n.source_entity_id === ex.thread_id && near(n.created_at, ex.started_at, W)) || null,
    name: nm.name(ex.thread_id), address: nm.address(ex.thread_id, ex.property_id),
  })).sort((a, b) => String(b.run.started_at).localeCompare(String(a.run.started_at)))
}

export const dncAdapter = {
  key: 'dnc_opt_out',
  topology: DNC_OPT_OUT,
  source_runtime: 'seller-flow orchestrator',
  load: (db, opts) => loadDnc(db, opts),
  summary: (db, o) => timestampSummary(() => db.from('seller_automation_execution_steps').select('created_at').eq('action_key', 'automation_blocked').eq('block_reason', 'opt_out').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'seller_automation_execution_steps' }),
  async detail(db, id, { degraded = [] } = {}) {
    const [o] = await loadDnc(db, { id: clean(id), degraded })
    if (!o) return null
    return { ...o, facts: [{ k: 'Conversation', v: o.run.subject.id || '—', source: 'seller_automation_executions.thread_id' }], decisions: [{ k: 'Automatic replies', v: 'Blocked — opt_out', source: 'seller decision (block reason)' }], ai: [], inputs: [], outputs: [{ k: 'Suppression', v: o.run.result }], links: o.run.subject.href ? [{ label: 'Open conversation', href: o.run.subject.href, app: 'Inbox' }] : [], technical: { execution_id: o.run.run_id } }
  },
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}

/* ── Negotiation ─────────────────────────────────────────────────────────── */

const NIDX = evidenceIndex(OFFER_NEGOTIATION)

function negotiationRun(group, { name = null, address = null } = {}) {
  const K = 'offer_negotiation'
  const first = group[0]
  const { push, events } = nodeEvents(K, `neg:${first.id}`, 'seller negotiation engine')
  push('negotiation_turn', 'succeeded', first.created_at)
  for (const ev of group) {
    const nk = NIDX.get(ev.event_type)
    if (nk) push(nk, ev.event_type === 'review_required' ? 'human' : 'succeeded', ev.created_at, { id: `neg:${ev.id}`, label: human(ev.event_type), ref: `automation_events:${ev.event_type}` })
  }
  const review = group.some((e) => e.event_type === 'review_required')
  const offered = group.some((e) => e.event_type === 'offer_queued')
  push('turn_done', 'succeeded', group[group.length - 1].created_at)
  return {
    run: runRow({ run_id: `neg:${first.id}`, workflow_key: K, version: 'negotiation-v1', started_at: first.created_at, finished_at: group[group.length - 1].created_at, subject: subject('seller', first.conversation_thread_id, name, address, inbox(first.conversation_thread_id)), trigger: 'Seller turn in an offer stage', status: 'completed', human: review, final_node: 'turn_done', result: offered ? 'Offer queued' : review ? 'Asked for review' : group.map((e) => human(e.event_type)).slice(0, 3).join(' · '), reason: null }),
    events,
  }
}

async function loadNegotiation(db, { since, until = null, limit = 600, degraded = [], anchorId = null }) {
  let q = db.from('automation_events').select('id, event_type, conversation_thread_id, property_id, created_at').eq('source', 'seller_negotiation_engine').order('created_at', { ascending: true }).limit(limit)
  if (anchorId) {
    const { data: a } = await db.from('automation_events').select('id, conversation_thread_id, created_at').eq('id', anchorId).maybeSingle()
    if (!a) return []
    q = q.eq('conversation_thread_id', a.conversation_thread_id).gte('created_at', a.created_at).lte('created_at', new Date(Date.parse(a.created_at) + 3 * 60e3).toISOString())
  } else { q = q.gte('created_at', since); if (until) q = q.lt('created_at', until) }
  const rows = await safe(q, degraded, 'automation_events')
  const groups = []
  const open = new Map()
  for (const r of rows) {
    const g = open.get(r.conversation_thread_id)
    if (g && Date.parse(r.created_at) - Date.parse(g[g.length - 1].created_at) <= 3 * 60e3) g.push(r)
    else { const ng = [r]; groups.push(ng); open.set(r.conversation_thread_id, ng) }
  }
  const nm = await sellerNames(db, groups.map((g) => g[0].conversation_thread_id), groups.map((g) => g[0].property_id), degraded)
  return groups.map((g) => negotiationRun(g, { name: nm.name(g[0].conversation_thread_id), address: nm.address(g[0].conversation_thread_id, g[0].property_id) })).sort((a, b) => String(b.run.started_at).localeCompare(String(a.run.started_at)))
}

export const negotiationAdapter = {
  key: 'offer_negotiation',
  topology: OFFER_NEGOTIATION,
  source_runtime: 'seller negotiation engine',
  load: (db, opts) => loadNegotiation(db, opts),
  async summary(db, { now, dayStart, degraded = [] }) {
    const rows = await safe(db.from('automation_events').select('conversation_thread_id, created_at').eq('source', 'seller_negotiation_engine').gte('created_at', iso(now - 7 * DAY)).order('created_at', { ascending: true }).limit(1000), degraded, 'automation_events')
    const starts = []
    const last = new Map()
    for (const r of rows) { const p = last.get(r.conversation_thread_id); if (!p || Date.parse(r.created_at) - Date.parse(p) > 3 * 60e3) starts.push(r.created_at); last.set(r.conversation_thread_id, r.created_at) }
    return { runs_today: starts.filter((t) => t >= dayStart).length, runs_24h: starts.filter((t) => Date.parse(t) > now - DAY).length, runs_7d: starts.length, failed_24h: 0, last_run_at: starts[starts.length - 1] || null }
  },
  async detail(db, id, { degraded = [] } = {}) {
    const anchor = clean(id).replace(/^neg:/, '')
    const [o] = await loadNegotiation(db, { anchorId: anchor, degraded })
    if (!o) return null
    return { ...o, facts: [], decisions: o.events.filter((e) => e.node_key !== 'negotiation_turn' && e.node_key !== 'turn_done').map((e) => ({ k: human(e.node_key), v: e.label || e.status, source: 'seller negotiation engine' })), ai: [], inputs: [], outputs: [], links: o.run.subject.href ? [{ label: 'Open conversation', href: o.run.subject.href, app: 'Inbox' }] : [], technical: { anchor_event: anchor } }
  },
  async current() { return { in_flight: 0, needs_you: [], live: [] } },
}
