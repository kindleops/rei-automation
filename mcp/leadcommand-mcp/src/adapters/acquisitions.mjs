// LeadCommand MCP 1.3 — Operation Hidden Gold read coverage: five per-thread acquisition reads.
//
// Each is a READ of one SECURITY DEFINER projection created by
// supabase/migrations/PROPOSED_20261027130000_lc_mcp_acquisition_reads.sql (fixture mode mirrors them in
// fixtures/acquisitions.mjs). The role holds no privilege on followup_intents, send_queue, seller_offers,
// automation_events / _suppressions, the holds registry, schema agent or schema action_gateway: it sees only
// what the functions return, and the functions never return a phone number, a thread key, a message body, a
// provider payload, a hold id / key / reason text or a work item's detail payload (digit runs in free text are
// withheld server-side; the gateway masks the result again). Free text (reason codes, queue keys, failed
// reasons, agent names, next actions, titles) is returned as UNTRUSTED data, sanitized and capped.
//
//   getThreadFollowups           public.followup_intents rows of one thread (lc_mcp_thread_followups)
//   getThreadExecutionLog        public.send_queue rows (+ the Action Gateway receipt when link #28 exists) and
//                                public.automation_events of one thread (lc_mcp_thread_execution_log)
//   getThreadOffers              public.seller_offers + public.acquisition_opportunities of one thread (lc_mcp_thread_offers)
//   getThreadContactEligibility  the send-time guard's INPUTS and eligible_for_outreach (lc_mcp_thread_contact_eligibility);
//                                a read, never a send authorization
//   searchOperatorTasks          open / acknowledged agent.ops_work_item rows (lc_mcp_operator_tasks), the
//                                operator's org only
//
// Nothing here plans, re-queues or cancels a follow-up, sends, offers, releases a hold or decides a work item.
import { err } from '../errors.mjs'
import { prov, missing } from '../provenance.mjs'
import { num, clean, bool, untrusted, isoOrNull, readRpc } from './common.mjs'

const rpc = (svc, fn, args, what) => readRpc(svc.db.rpc(fn, args), what)
const arr = (v) => (Array.isArray(v) ? v : [])
const strs = (v, max = 20) => arr(v).slice(0, max).map((x) => clean(x)).filter(Boolean)

export const FOLLOWUP_STATES = Object.freeze(['planned', 'materializing', 'ready', 'dispatched', 'provider_accepted', 'delivered', 'failed', 'not_executable', 'cancelled', 'superseded', 'held'])
export const TASK_STATES = Object.freeze(['open', 'acknowledged'])
export const TASK_SEVERITIES = Object.freeze(['info', 'warning', 'critical'])
export const ELIGIBILITY_BLOCKED_STATUSES = Object.freeze(['opted_out', 'do_not_text', 'do_not_contact', 'dnc', 'wrong_number', 'blocked', 'suppressed', 'not_contactable', 'unreachable'])
export const ELIGIBILITY_REASONS = Object.freeze(['no_thread_key', 'thread_suppressed', 'thread_opt_out', 'thread_wrong_number', 'suppression_list_active', 'automation_suppression_active', 'hold_blocks_ai_action', ...ELIGIBILITY_BLOCKED_STATUSES.map((s) => `contactability_${s}`)])

const READ_NOTES = Object.freeze([
  'Records as LeadCommand holds them, read at call time; nothing here changes a follow-up, a queue row, an offer, a hold or a work item.',
  'Phone numbers, thread keys, message text, provider payloads and hold / work-item detail never leave the database; digit runs inside free text are withheld.',
])

async function threadRead(svc, fn, args, what) {
  const r = await rpc(svc, fn, args, what)
  if (!r || typeof r !== 'object') throw err('data_unavailable', `${what}: empty answer`, { code: 'SOURCE_UNAVAILABLE' })
  if (r.thread_found !== true) throw err('not_found', 'no inbox thread with this id', { code: 'NOT_FOUND' })
  return r
}
const sources = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).map(([k, x]) => [k, x === true]))

// ── follow-up intents of one thread ───────────────────────────────────────
function followupRow(x) {
  return {
    id: clean(x.id), kind: untrusted(x.kind, 60), intent: untrusted(x.intent, 60), use_case: untrusted(x.use_case, 60),
    state: FOLLOWUP_STATES.includes(x.state) ? x.state : clean(x.state),
    due_at: isoOrNull(x.due_at), next_attempt_at: isoOrNull(x.next_attempt_at),
    reason_code: untrusted(x.reason_code, 120), writer: untrusted(x.writer, 60),
    attempts: num(x.attempts), max_attempts: num(x.max_attempts), materialize_seq: num(x.materialize_seq), materialized: bool(x.materialized) === true,
    template_source: untrusted(x.template_source, 60), outcome: untrusted(x.outcome, 60), next_action: untrusted(x.next_action, 120),
    property_id: clean(x.property_id), this_property: bool(x.this_property),
    created_at: isoOrNull(x.created_at), updated_at: isoOrNull(x.updated_at), closed_at: isoOrNull(x.closed_at),
  }
}

export async function getThreadFollowups(input, svc, { now }) {
  const source = 'public.followup_intents via lc_mcp_thread_followups'
  const r = await threadRead(svc, 'lc_mcp_thread_followups', { p_thread_id: input.thread_id }, 'thread follow-ups')
  const available = r.sources?.followup_intents === true
  const rows = arr(r.rows).map(followupRow)
  const counts = Object.fromEntries(Object.entries(r.counts_by_state && typeof r.counts_by_state === 'object' ? r.counts_by_state : {}).map(([k, v]) => [k, num(v) ?? 0]))
  return {
    thread_id: input.thread_id, property_id: clean(r.property_id), available,
    rows, returned: rows.length, total: num(r.total) ?? rows.length, has_more: r.has_more === true, limit: 50,
    counts_by_state: counts,
    provenance: available ? prov({ kind: 'fact', source, as_of: isoOrNull(r.as_of) || now.toISOString(), rule: 'the thread\'s intents by thread key, newest first (created_at), ≤ 50', now }) : missing(source, 'followup_intents_not_in_database'),
    policy_notes: [...READ_NOTES, 'A follow-up is executable only after materialization (materialized = a send_queue row exists); the lifecycle health tool gives the fleet-wide counts.'],
  }
}

// ── execution log of one thread ───────────────────────────────────────────
function receipt(x) {
  return x && typeof x === 'object' ? { state: untrusted(x.state, 40), code: untrusted(x.code, 80), action: untrusted(x.action, 60), updated_at: isoOrNull(x.updated_at) } : null
}
function queueRow(x) {
  return {
    id: clean(x.id), queue_key: untrusted(x.queue_key, 120), queue_status: untrusted(x.queue_status, 40),
    scheduled_for: isoOrNull(x.scheduled_for), sent_at: isoOrNull(x.sent_at), delivered_at: isoOrNull(x.delivered_at),
    failed_reason: untrusted(x.failed_reason, 200), use_case_template: untrusted(x.use_case_template, 80), agent_name: untrusted(x.agent_name, 80),
    message_origin: untrusted(x.message_origin, 40), message_type: untrusted(x.message_type, 40), template_source: untrusted(x.template_source, 60),
    touch_number: num(x.touch_number), retry_count: num(x.retry_count), safety_status: untrusted(x.safety_status, 40), guard_status: untrusted(x.guard_status, 40),
    paused_reason: untrusted(x.paused_reason, 120), property_id: clean(x.property_id),
    created_at: isoOrNull(x.created_at), updated_at: isoOrNull(x.updated_at), receipt: receipt(x.receipt),
  }
}
function eventRow(x) {
  return {
    id: clean(x.id), event_type: untrusted(x.event_type, 60), status: untrusted(x.status, 40), source: untrusted(x.source, 40), error_code: untrusted(x.error_code, 80),
    property_id: clean(x.property_id), run_started_at: isoOrNull(x.run_started_at), run_completed_at: isoOrNull(x.run_completed_at), created_at: isoOrNull(x.created_at), updated_at: isoOrNull(x.updated_at),
  }
}

export async function getThreadExecutionLog(input, svc, { now }) {
  const source = 'public.send_queue (+ action_gateway.seller_action_receipts) + public.automation_events via lc_mcp_thread_execution_log'
  const r = await threadRead(svc, 'lc_mcp_thread_execution_log', { p_thread_id: input.thread_id, p_limit: input.limit }, 'thread execution log')
  const src = sources(r.sources)
  const rows = arr(r.queue_rows).slice(0, input.limit).map(queueRow)
  const events = arr(r.events).slice(0, input.limit).map(eventRow)
  return {
    thread_id: input.thread_id, property_id: clean(r.property_id), limit: input.limit,
    rows, returned: rows.length, events, events_returned: events.length,
    sources: { send_queue: src.send_queue === true, seller_action_receipts: src.seller_action_receipts === true, automation_events: src.automation_events === true },
    provenance: src.send_queue ? prov({ kind: 'fact', source, as_of: isoOrNull(r.as_of) || now.toISOString(), rule: 'queue rows and events by thread key, newest first (created_at), ≤ limit each', now }) : missing(source, 'send_queue_not_in_database'),
    policy_notes: [...READ_NOTES, 'receipt is what the Action Gateway recorded for a handed-off intent whose queue row this is; null when link #28 is not applied or the row was not gateway-born.'],
  }
}

// ── offers and pipeline records of one thread ─────────────────────────────
function offerRow(x) {
  return {
    offer_id: untrusted(x.offer_id, 80), opportunity_id: clean(x.opportunity_id), property_id: clean(x.property_id), offer_version: num(x.offer_version),
    direction: untrusted(x.direction, 20), offer_type: untrusted(x.offer_type, 40),
    purchase_price: num(x.purchase_price), authorized_ceiling: num(x.authorized_ceiling), recommended_offer: num(x.recommended_offer), valuation_mid: num(x.valuation_mid), strategy: untrusted(x.strategy, 60),
    status: untrusted(x.status, 40), closing_date: isoOrNull(x.closing_date)?.slice(0, 10) ?? null, closing_term: untrusted(x.closing_term, 60), emd_amount: num(x.emd_amount), emd_term: untrusted(x.emd_term, 60),
    policy_version: untrusted(x.policy_version, 40), send_bound: bool(x.send_bound) === true,
    created_at: isoOrNull(x.created_at), sent_at: isoOrNull(x.sent_at), superseded_at: isoOrNull(x.superseded_at), accepted_at: isoOrNull(x.accepted_at), accepted_price: num(x.accepted_price),
  }
}
function opportunityRow(x) {
  return {
    id: clean(x.id), primary_property_id: clean(x.primary_property_id),
    acquisition_stage: untrusted(x.acquisition_stage, 60), opportunity_status: untrusted(x.opportunity_status, 40), automation_state: untrusted(x.automation_state, 40),
    priority: untrusted(x.priority, 40), temperature: untrusted(x.temperature, 40), approval_state: untrusted(x.approval_state, 40),
    next_action: untrusted(x.next_action, 160), next_action_due: isoOrNull(x.next_action_due), blocker: untrusted(x.blocker, 160), latest_intent: untrusted(x.latest_intent, 60),
    estimated_value: num(x.estimated_value), arv: num(x.arv), asking_price: num(x.asking_price), current_offer: num(x.current_offer),
    active_offer_id: untrusted(x.active_offer_id, 80), accepted_offer_id: untrusted(x.accepted_offer_id, 80), market: untrusted(x.market, 60),
    stage_entered_at: isoOrNull(x.stage_entered_at), last_activity_at: isoOrNull(x.last_activity_at), last_contact_at: isoOrNull(x.last_contact_at),
    created_at: isoOrNull(x.created_at), updated_at: isoOrNull(x.updated_at),
  }
}

export async function getThreadOffers(input, svc, { now }) {
  const source = 'public.seller_offers + public.acquisition_opportunities via lc_mcp_thread_offers'
  const r = await threadRead(svc, 'lc_mcp_thread_offers', { p_thread_id: input.thread_id }, 'thread offers')
  const src = sources(r.sources)
  const offers = arr(r.offers).slice(0, 50).map(offerRow)
  const opportunities = arr(r.opportunities).slice(0, 10).map(opportunityRow)
  const active = offers.find((o) => o.status === 'active') || null
  return {
    thread_id: input.thread_id, property_id: clean(r.property_id),
    offers, offers_returned: offers.length, offers_total: num(r.offers_total) ?? offers.length, offers_has_more: (num(r.offers_total) ?? 0) > offers.length,
    active_offer: active ? { offer_id: active.offer_id, direction: active.direction, purchase_price: active.purchase_price, authorized_ceiling: active.authorized_ceiling } : null,
    opportunities, opportunities_returned: opportunities.length,
    sources: { seller_offers: src.seller_offers === true, acquisition_opportunities: src.acquisition_opportunities === true },
    provenance: src.seller_offers || src.acquisition_opportunities ? prov({ kind: 'fact', source, as_of: isoOrNull(r.as_of) || now.toISOString(), rule: 'offers (≤ 50) and opportunities (≤ 10) by thread key, newest first', now }) : missing(source, 'offer_tables_not_in_database'),
    policy_notes: [...READ_NOTES, 'An inbound offer is the seller\'s counter as recorded; an outbound one is what LeadCommand sent. authorized_ceiling is the frozen ceiling of record, not an authorization to offer.'],
  }
}

// ── contact eligibility of one thread ─────────────────────────────────────
const ELIGIBILITY_NOTES = Object.freeze([
  'eligible_for_outreach is a READ of the send-time guard\'s inputs, computed at call time; the send path keeps its own guard. It is never an authorization to send.',
  'A hold is an internal automation stop (category only, never a hold id / key / reason text). Suppression rows are reported as counts, types and capped reasons; the number itself never leaves the database.',
])
function holdRow(h) {
  return { hold_type: untrusted(h.hold_type, 40), reason_category: untrusted(h.reason_category, 60), matched_on: untrusted(h.matched_on, 20), blocked_capabilities: strs(h.blocked_capabilities, 20), blocks_ai_action: bool(h.blocks_ai_action) === true, set_at: isoOrNull(h.set_at) }
}

export async function getThreadContactEligibility(input, svc, { now }) {
  const source = 'inbox_thread_state flags + sms_suppression_list + automation_suppressions + automation_hold_for + contact_property_resolution + phones via lc_mcp_thread_contact_eligibility'
  const r = await threadRead(svc, 'lc_mcp_thread_contact_eligibility', { p_thread_id: input.thread_id }, 'thread contact eligibility')
  const f = r.thread_flags && typeof r.thread_flags === 'object' ? r.thread_flags : {}
  const reasons = strs(r.blocking_reasons, 20)
  const eligible = r.eligible_for_outreach === true && reasons.length === 0
  const sl = r.suppression_list && typeof r.suppression_list === 'object' ? r.suppression_list : {}
  const as = r.automation_suppressions && typeof r.automation_suppressions === 'object' ? r.automation_suppressions : null
  const hl = r.holds && typeof r.holds === 'object' ? r.holds : null
  const cp = r.contact_property && typeof r.contact_property === 'object' ? r.contact_property : null
  return {
    thread_id: input.thread_id, property_id: clean(r.property_id),
    eligible_for_outreach: eligible, blocking_reasons: reasons,
    thread_flags: {
      is_suppressed: bool(f.is_suppressed), contactability_status: untrusted(f.contactability_status, 40), opt_out: bool(f.opt_out), wrong_number: bool(f.wrong_number),
      status: untrusted(f.status, 40), disposition: untrusted(f.disposition, 40), automation_state: untrusted(f.automation_state, 40), paused: bool(f.paused) === true, has_thread_key: bool(f.has_thread_key) === true,
    },
    suppression_list: { active: num(sl.active) ?? 0, rows: arr(sl.rows).slice(0, 20).map((x) => ({ type: untrusted(x.type, 40), reason: untrusted(x.reason, 80), sender_scoped: bool(x.sender_scoped) === true, created_at: isoOrNull(x.created_at) })) },
    automation_suppressions: as ? { active: num(as.active) ?? 0, rows: arr(as.rows).slice(0, 10).map((x) => ({ type: untrusted(x.type, 40), rule_key: untrusted(x.rule_key, 60), event_type: untrusted(x.event_type, 60), action_type: untrusted(x.action_type, 40), reason: untrusted(x.reason, 80), suppressed_at: isoOrNull(x.suppressed_at), expires_at: isoOrNull(x.expires_at), created_at: isoOrNull(x.created_at) })) } : null,
    holds: hl ? { active: num(hl.active) ?? 0, blocks_ai_action: bool(hl.blocks_ai_action) === true, rows: arr(hl.rows).slice(0, 20).map(holdRow) } : null,
    contact_property: cp ? { role: untrusted(cp.role, 40), rejected: bool(cp.rejected) === true, suppression_scope: untrusted(cp.suppression_scope, 40), updated_at: isoOrNull(cp.updated_at) } : null,
    phone_rows: arr(r.phone_rows).slice(0, 3).map((p) => ({ phone_type: untrusted(p.phone_type, 20), contact_status: untrusted(p.contact_status, 40), activity_status: untrusted(p.activity_status, 40), wrong_number_at: isoOrNull(p.wrong_number_at) })),
    rule: clean(r.rule) || 'eligible = no blocking reason (see blocking_reasons)',
    sources: sources(r.sources),
    provenance: prov({ kind: 'derived', source, as_of: isoOrNull(r.as_of) || now.toISOString(), rule: 'eligible = no blocking input (flags, suppression list, automation suppression, hold on ai_action)', now }),
    policy_notes: [...ELIGIBILITY_NOTES],
  }
}

// ── open operator tasks ───────────────────────────────────────────────────
function taskRow(x) {
  return {
    id: clean(x.id), scope: untrusted(x.scope, 40), kind: untrusted(x.kind, 60), severity: TASK_SEVERITIES.includes(x.severity) ? x.severity : untrusted(x.severity, 20),
    title: untrusted(x.title, 200), subject_type: untrusted(x.subject_type, 40), subject_id: untrusted(x.subject_id, 80),
    state: TASK_STATES.includes(x.state) ? x.state : clean(x.state), escalated: bool(x.escalated) === true, priority: num(x.priority), due_at: isoOrNull(x.due_at),
    first_seen_at: isoOrNull(x.first_seen_at), last_seen_at: isoOrNull(x.last_seen_at), seen_count: num(x.seen_count), acknowledged_at: isoOrNull(x.acknowledged_at),
    source_job_id: untrusted(x.source_job_id, 80), created_at: isoOrNull(x.created_at), updated_at: isoOrNull(x.updated_at),
  }
}

export async function searchOperatorTasks(input, svc, { now, principal }) {
  const org = principal?.org_id
  if (!org) throw err('unauthorized', 'no org', { code: 'NO_ORG' })
  const source = 'agent.ops_work_item via lc_mcp_operator_tasks'
  const r = await rpc(svc, 'lc_mcp_operator_tasks', { p_limit: input.limit }, 'operator tasks')
  const available = r?.sources?.ops_work_item === true
  const all = arr(r?.rows).slice(0, input.limit)
  // the projection is not org-scoped: only the operator's own org's items are returned, the rest counted
  const mine = all.filter((x) => String(x?.org_id || '') === org).map(taskRow)
  const c = r?.counts && typeof r.counts === 'object' ? r.counts : null
  if (!available) {
    return { rows: [], returned: 0, has_more: false, limit: input.limit, available: false, code: 'OPS_WORK_ITEMS_NOT_IN_DATABASE', other_org_rows_withheld: 0, counts: null, provenance: missing(source, 'ops_work_item_not_in_database'), policy_notes: [...READ_NOTES] }
  }
  return {
    rows: mine, returned: mine.length, has_more: r?.has_more === true, limit: input.limit, available: true,
    other_org_rows_withheld: all.length - mine.length,
    counts: c ? Object.fromEntries(['open', 'acknowledged', 'critical', 'warning', 'info', 'escalated', 'total'].map((k) => [k, num(c[k]) ?? 0])) : null,
    provenance: prov({ kind: 'fact', source, as_of: isoOrNull(r?.as_of) || now.toISOString(), rule: 'open / acknowledged items newest first (created_at), ≤ limit; rows filtered to the operator\'s org', now }),
    policy_notes: [...READ_NOTES, 'counts span every org on this database; rows are the operator\'s org only. Acknowledging, resolving or dismissing an item is not possible here.'],
  }
}
