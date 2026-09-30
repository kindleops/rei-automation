/**
 * CLOSING AUTOMATION + EMAIL DISPATCH adapters.
 *
 * Closing: one run = one closing case. Loop progress is read from
 * closing_email_requests (the planner keeps no counts), escalations from
 * closing_cases.automation_state + closing_activity_events, milestones from
 * Closing Authority (PRECEDENCE.closing_milestone) — never inferred from email.
 *
 * Email: one run = one email_queue row. Outcome from email_queue.queue_status and
 * the append-only email_events; defer / reap / dispatch_error are only visible on
 * the queue row (the dispatcher writes no event for them).
 */
import { CLOSING_EXECUTION as CT, EMAIL_DISPATCH as ET } from '../topologies/campaign-closing-email.js'
import { human } from '../core.js'
import { clean, lower, nodeEvents, runRow, safe, subject, timestampSummary } from './shared.js'
import { DAY, iso } from '../core.js'

/* ── closing ─────────────────────────────────────────────────────────────── */

const CK = 'closing_execution'
const CRT = 'closing-automation.js'
const chref = (id) => `/closing-desk?case=${encodeURIComponent(id)}`
const LOOP_NODE = { title_open: 'title_open', title_ack: 'title_ack', title_commitment: 'title_commitment', clear_to_close: 'clear_to_close', settlement: 'settlement', buyer_emd: 'buyer_emd', buyer_agreement: 'buyer_agreement', closing_confirmation: 'closing_confirmation' }
const ACTIVITY_NODE = { title_acknowledged: 'title_ack', title_commitment_received: 'title_commitment', clear_to_close: 'clear_to_close', settlement_recorded: 'settlement', settlement_settled: 'settlement', emd_received: 'buyer_emd', emd_verified: 'buyer_emd', emd_waived: 'buyer_emd', buyer_agreement_status: 'buyer_agreement', automation_escalated: 'escalate', automation_paused: 'automation_paused', closing_finalized: 'operator_finalize' }

function closingRun(c, reqs = [], acts = []) {
  const { push, events } = nodeEvents(CK, c.closing_case_id, CRT)
  const start = c.created_at || c.updated_at
  push('contract_executed', lower(c.contract_status) === 'fully_executed' ? 'succeeded' : 'waiting', start, { label: human(c.contract_status || 'awaiting contract') })
  const voided = Boolean(c.provenance?.voided)
  const paused = Boolean(c.automation_paused_at)
  if (lower(c.contract_status) === 'fully_executed') push('automation_gate', paused || voided || c.terminal_outcome ? 'held' : 'succeeded', start, { reason: voided ? 'voided' : c.terminal_outcome ? `terminal: ${c.terminal_outcome}` : paused ? c.automation_paused_reason || 'paused' : null })
  if (paused) push('automation_paused', 'human', c.automation_paused_at, { reason: c.automation_paused_reason || null })
  for (const r of [...reqs].sort((a, b) => String(a.requested_at).localeCompare(String(b.requested_at)))) {
    const cat = String(r.category || '').split(':')[0]
    const nk = LOOP_NODE[cat]
    if (!nk) continue
    const st = r.status === 'failed' ? 'failed' : r.status === 'cancelled' ? 'succeeded' : r.status === 'sent' ? 'succeeded' : 'waiting'
    push(nk, st, r.requested_at, { id: r.id, label: `${human(r.action)} #${r.sequence || 1}`, reason: r.status_reason || null })
    if (['pending_transport', 'claimed', 'sent'].includes(r.status)) push('email_handoff', r.status === 'sent' ? 'succeeded' : 'waiting', r.sent_at || r.claimed_at || r.requested_at, { id: `${r.id}:h`, label: human(r.status) })
  }
  for (const a of acts) {
    const nk = ACTIVITY_NODE[a.event_type]
    if (nk) push(nk, nk === 'escalate' ? 'human' : 'succeeded', a.created_at, { id: a.id, label: human(a.event_type), reason: a.detail?.reason || null })
  }
  const escalations = Object.keys(c.automation_state?.escalations || {})
  if (escalations.length && !acts.some((a) => a.event_type === 'automation_escalated')) for (const k of escalations) push('escalate', 'human', c.automation_state.escalations[k]?.at || c.updated_at, { reason: `${human(k)} · ${human(c.automation_state.escalations[k]?.reason || '')}` })
  if (c.closed_at) push('closed', 'succeeded', c.closed_at)
  const status = voided || c.terminal_outcome ? 'cancelled' : c.closed_at ? 'completed' : escalations.length ? 'needs_you' : paused ? 'held' : lower(c.contract_status) !== 'fully_executed' ? 'waiting' : 'running'
  return {
    run: runRow({
      run_id: c.closing_case_id, workflow_key: CK, version: 'closing-automation-v1', started_at: start, finished_at: c.closed_at || (voided || c.terminal_outcome ? c.updated_at : null),
      subject: subject('closing', c.closing_case_id, null, c.property_address, chref(c.closing_case_id)), trigger: 'Contract fully executed',
      status, human: status === 'needs_you', current_node: status === 'running' ? (events[events.length - 1]?.node_key || null) : null, final_node: events[events.length - 1]?.node_key || null,
      result: voided ? 'Voided' : c.terminal_outcome ? `Closing ${c.terminal_outcome}` : c.closed_at ? 'Closed' : escalations.length ? `Escalated · ${escalations.map(human).join(', ')}` : paused ? 'Automation paused' : 'In progress',
      reason: escalations.length ? 'Counterparty silent — cadence exhausted' : paused ? c.automation_paused_reason || null : null,
    }),
    events,
    raw: c,
  }
}

export const closingAdapter = {
  key: CK,
  topology: CT,
  source_runtime: CRT,
  async load(db, { since, limit = 200, degraded = [] }) {
    const cases = await safe(db.from('closing_cases').select('closing_case_id, property_address, contract_status, terminal_outcome, closed_at, automation_paused_at, automation_paused_reason, automation_state, created_at, updated_at, provenance').gte('updated_at', since).order('updated_at', { ascending: false }).limit(limit), degraded, 'closing_cases')
    if (!cases.length) return []
    const ids = cases.map((c) => c.closing_case_id)
    const [reqs, acts] = await Promise.all([
      safe(db.from('closing_email_requests').select('id, closing_case_id, category, action, sequence, status, status_reason, requested_at, claimed_at, sent_at').in('closing_case_id', ids).limit(2000), degraded, 'closing_email_requests'),
      safe(db.from('closing_activity_events').select('id, closing_case_id, event_type, detail, created_at').in('closing_case_id', ids).limit(2000), degraded, 'closing_activity_events'),
    ])
    const by = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.closing_case_id) || m.set(r.closing_case_id, []).get(r.closing_case_id)).push(r); return m }
    const R = by(reqs); const A = by(acts)
    return cases.map((c) => closingRun(c, R.get(c.closing_case_id), A.get(c.closing_case_id)))
  },
  async detail(db, id, { degraded = [] } = {}) {
    const { data: c } = await db.from('closing_cases').select('*').eq('closing_case_id', clean(id)).maybeSingle()
    if (!c) return null
    const [reqs, acts] = await Promise.all([
      safe(db.from('closing_email_requests').select('*').eq('closing_case_id', c.closing_case_id).limit(500), degraded, 'closing_email_requests'),
      safe(db.from('closing_activity_events').select('*').eq('closing_case_id', c.closing_case_id).limit(500), degraded, 'closing_activity_events'),
    ])
    const r = closingRun(c, reqs, acts)
    return {
      ...r,
      facts: [
        { k: 'Contract', v: human(c.contract_status || '—'), source: 'closing_cases.contract_status' },
        ...(c.title_acknowledged_at ? [{ k: 'Title acknowledged', v: String(c.title_acknowledged_at).slice(0, 10), source: 'Closing Authority' }] : []),
        ...(c.clear_to_close_at ? [{ k: 'Clear to close', v: String(c.clear_to_close_at).slice(0, 10), source: 'Closing Authority' }] : []),
        ...(c.provenance?.voided ? [{ k: 'Voided', v: 'yes', source: 'closing_cases.provenance' }] : []),
      ],
      decisions: Object.entries(c.automation_state?.escalations || {}).map(([k, v]) => ({ k: `Escalated · ${human(k)}`, v: human(v?.reason || ''), source: 'planClosingAutomation' })),
      ai: [], inputs: [], outputs: reqs.map((q) => ({ k: `${human(q.category)} #${q.sequence || 1}`, v: human(q.status) })),
      links: [{ label: 'Open on Closing Desk', href: chref(c.closing_case_id), app: 'Closing Desk' }],
      technical: { closing_case_id: c.closing_case_id, requests: reqs.length, activity: acts.length },
    }
  },
  summary: (db, o) => timestampSummary(() => db.from('closing_email_requests').select('at:requested_at').gte('requested_at', iso(o.now - 7 * DAY)).order('requested_at', { ascending: false }), { ...o, source: 'closing_email_requests' }),
  async current(db, { degraded = [] } = {}) {
    const cases = await safe(db.from('closing_cases').select('closing_case_id, property_address, contract_status, terminal_outcome, closed_at, automation_paused_at, automation_state, updated_at, provenance').is('closed_at', null).is('terminal_outcome', null).limit(300), degraded, 'closing_cases')
    const open = cases.filter((c) => !c.provenance?.voided)
    const needs = open.filter((c) => Object.keys(c.automation_state?.escalations || {}).length).map((c) => ({ run_id: c.closing_case_id, node_key: 'escalate', subject: subject('closing', c.closing_case_id, null, c.property_address, chref(c.closing_case_id)), reason: `Counterparty silent — ${Object.keys(c.automation_state.escalations).map(human).join(', ')}`, since: Object.values(c.automation_state.escalations)[0]?.at || c.updated_at, href: chref(c.closing_case_id) }))
    return { in_flight: open.filter((c) => lower(c.contract_status) === 'fully_executed' && !c.automation_paused_at).length, needs_you: needs, live: [] }
  },
}

/* ── email ───────────────────────────────────────────────────────────────── */

const EK = 'email_dispatch'
const ERT = 'email-dispatch.js'

function emailRun(q, evs = []) {
  const { push, events } = nodeEvents(EK, q.id, ERT)
  const s = lower(q.queue_status)
  const at = q.created_at
  push('dispatch_tick', 'succeeded', at)
  if (q.source === 'closing') push('bridge_closing', 'succeeded', at, { label: 'from Closing Authority' })
  const has = (t) => evs.find((e) => e.event_type === t)
  if (['sending', 'sent', 'delivered', 'bounced', 'failed', 'superseded', 'cancelled'].includes(s) || evs.length) {
    push('send_gate', 'succeeded', q.attempt_started_at || at)
    push('claim_once', 'succeeded', q.attempt_started_at || at)
  }
  if (q.failed_reason === 'transport_outcome_unknown') push('reap_stuck', 'failed', q.updated_at, { reason: 'outcome unknown — never re-sent' })
  if (has('escalated')) { push('revalidate', 'held', has('escalated').created_at, { reason: has('escalated').reason }); push('escalate', 'human', has('escalated').created_at, { reason: has('escalated').reason }) }
  else if (['superseded', 'cancelled'].includes(s)) { push('revalidate', 'succeeded', q.updated_at, { label: human(s) }); push('superseded', 'succeeded', q.updated_at, { reason: q.cancel_reason || null }) }
  else if (['sent', 'delivered', 'bounced'].includes(s)) { push('revalidate', 'succeeded', q.revalidated_at || q.sent_at); push('send_brand', 'succeeded', q.sent_at, { label: 'accepted' }); push('email_sent', s === 'bounced' ? 'failed' : 'succeeded', q.delivered_at || q.sent_at, { label: human(s) }) }
  else if (s === 'failed') { push('send_brand', 'failed', q.updated_at, { reason: q.failed_reason }); if (Number(q.retry_count) > 0) push('retry_backoff', 'failed', q.updated_at, { label: `${q.retry_count} retries` }); push('transport_failed', 'failed', q.updated_at, { reason: q.failed_reason }) }
  else if (['pending_send', 'scheduled'].includes(s) && q.next_retry_at) push('defer', 'waiting', q.updated_at, { reason: q.reason || 'deferred' })
  const status = ['sent', 'delivered'].includes(s) ? 'completed' : ['superseded', 'cancelled', 'no_send', 'skipped'].includes(s) ? 'cancelled' : s === 'failed' ? (has('escalated') ? 'needs_you' : 'failed') : s === 'awaiting_approval' ? 'needs_you' : s === 'sending' ? 'running' : s === 'bounced' ? 'failed' : 'waiting'
  return {
    run: runRow({ run_id: q.id, workflow_key: EK, version: 'email-dispatch-v1', started_at: at, finished_at: ['sent', 'delivered', 'failed', 'superseded', 'cancelled', 'bounced'].includes(s) ? q.updated_at : null, subject: subject('email', q.id, q.to_email, q.subject, '/email-command'), trigger: q.source ? `${human(q.source)} email` : 'Email due', status, human: status === 'needs_you', final_node: events[events.length - 1]?.node_key || null, result: human(s), reason: q.failed_reason || q.cancel_reason || null }),
    events,
    raw: q,
  }
}

export const emailAdapter = {
  key: EK,
  topology: ET,
  source_runtime: ERT,
  async load(db, { since, limit = 300, degraded = [] }) {
    const rows = await safe(db.from('email_queue').select('id, queue_status, source, to_email, subject, created_at, updated_at, sent_at, delivered_at, failed_reason, cancel_reason, retry_count, next_retry_at, attempt_started_at, revalidated_at, reason').gte('created_at', since).order('created_at', { ascending: false }).limit(limit), degraded, 'email_queue')
    if (!rows.length) return []
    const evs = await safe(db.from('email_events').select('id, queue_id, event_type, reason, created_at').in('queue_id', rows.map((r) => r.id)).limit(3000), degraded, 'email_events')
    const by = new Map()
    for (const e of evs) (by.get(e.queue_id) || by.set(e.queue_id, []).get(e.queue_id)).push(e)
    return rows.map((q) => emailRun(q, by.get(q.id)))
  },
  async detail(db, id, { degraded = [] } = {}) {
    const { data: q } = await db.from('email_queue').select('*').eq('id', clean(id)).maybeSingle()
    if (!q) return null
    const evs = await safe(db.from('email_events').select('id, queue_id, event_type, reason, created_at').eq('queue_id', q.id).limit(200), degraded, 'email_events')
    return { ...emailRun(q, evs), facts: [{ k: 'Status', v: human(q.queue_status), source: 'email_queue.queue_status' }], decisions: [], ai: [], inputs: [{ k: 'Subject', v: q.subject || '—' }], outputs: [], links: [{ label: 'Open Email Command', href: '/email-command', app: 'Email Command' }], technical: { queue_key: q.queue_key, source: q.source } }
  },
  summary: (db, o) => timestampSummary(() => db.from('email_queue').select('created_at, queue_status').gte('created_at', iso(o.now - 7 * DAY)).order('created_at', { ascending: false }), { ...o, source: 'email_queue', failed: (r) => r.queue_status === 'failed' }),
  async current(db, { degraded = [] } = {}) {
    const rows = await safe(db.from('email_queue').select('id, queue_status, to_email, subject, failed_reason, updated_at').in('queue_status', ['pending_send', 'scheduled', 'sending', 'awaiting_approval']).limit(200), degraded, 'email_queue')
    return { in_flight: rows.length, needs_you: rows.filter((r) => r.queue_status === 'awaiting_approval').map((r) => ({ run_id: r.id, node_key: 'revalidate', subject: subject('email', r.id, r.to_email, r.subject, '/email-command'), reason: 'Awaiting your approval', since: r.updated_at, href: '/email-command' })), live: [] }
  },
}
