/**
 * SYSTEM MAP — how LeadCommand's automation runtimes connect.
 *
 * Every edge here is a relationship the code wires today, named with the
 * ledger evidence that proves it and the traffic it carried in the window
 * (counted from that evidence, never estimated). Kinds keep the semantics
 * apart on the canvas:
 *
 *   event        a runtime reacts to something another runtime recorded
 *   action       a runtime asks another runtime's canonical interface to act
 *   subworkflow  a runtime invokes a nested workflow of its own
 *   external     a provider outside LeadCommand (TextGrid, Brevo)
 *   state        a runtime writes or reads canonical state another one honours
 *
 * An edge whose traffic cannot be attributed from a ledger says so
 * (`measure: null` + note) instead of borrowing a neighbour's number.
 * Nothing here writes.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { INTERNAL_TEST_PHONE_SET } from '@/lib/config/internal-phones.js'
import { DAY, iso } from './core.js'
import { countOf, safe, testPhoneList } from './adapters/shared.js'

const NOT_TEST = testPhoneList(INTERNAL_TEST_PHONE_SET)
const WINDOWS = Object.freeze({ '24h': DAY, '7d': 7 * DAY })
export const SYSTEM_EDGE_KINDS = Object.freeze(['event', 'action', 'subworkflow', 'external', 'state'])

const sys = (key, label, extra = {}) => ({ key, kind: 'system', workflow_key: key, label, ...extra })

/** The automation architecture: runtimes, the providers they talk to, and the canonical stores that couple them. */
export const SYSTEM_MAP_NODES = Object.freeze([
  sys('campaign_execution', 'Campaign Execution', { sub: 'activation · feeder', tier: 'spine' }),
  sys('queue_dispatch', 'Outbound Dispatch', { sub: 'the only SMS sender', tier: 'spine' }),
  { key: 'textgrid', kind: 'external', label: 'TextGrid', sub: 'SMS provider', family: 'DELIVERY', tier: 'spine', description: 'The SMS provider. Seller replies arrive through its inbound webhook; the queue runner dispatches through it; delivery outcomes come back as callbacks.' },
  sys('seller_inbound', 'Seller Conversation', { sub: 'inbound orchestrator', tier: 'spine' }),
  { key: 'pipeline', kind: 'domain', label: 'Pipeline', sub: 'canonical lifecycle', family: 'ACQUISITION', tier: 'spine', owner_app: 'Pipeline', owner_href: '/pipeline', description: 'Acquisition opportunities and their stage, owned by the lifecycle authority. The seller flow promotes a conversation into it; it writes pipeline events into the workflow inbox.' },
  sys('closing_execution', 'Closing Execution', { sub: 'title · buyer coordination', tier: 'spine' }),
  sys('email_dispatch', 'Email Dispatch', { sub: 'revalidate · send', tier: 'spine' }),
  { key: 'brevo', kind: 'external', label: 'Brevo', sub: 'email provider', family: 'EMAIL', tier: 'spine', description: 'The brand email sender. Email Command sends through it only when email_enabled is true and EMAIL_SEND_ENABLED is set.' },
  sys('delivery_reconcile', 'Delivery Reconciliation', { sub: 'missed outcomes', tier: 'support' }),
  sys('offer_negotiation', 'Offer Negotiation', { sub: 'S3–S6 · subworkflow', tier: 'support' }),
  sys('decision_engine', 'Acquisition Decision', { sub: 'comps · valuation · ceiling', tier: 'support' }),
  sys('dnc_opt_out', 'Opt-out & DNC', { sub: 'subworkflow', tier: 'support' }),
  { key: 'suppression', kind: 'domain', label: 'Suppression list', sub: 'opt-outs · carrier blocks', family: 'COMMUNICATION', tier: 'support', owner_app: 'Queue', owner_href: '/queue', description: 'sms_suppression_list. Opt-outs are written here; the queue runner re-checks it before every dispatch, so no workflow can send around it.' },
  sys('lead_state_reconcile', 'Lead-State Reconcile', { sub: 'repairs next action', tier: 'support' }),
  sys('event_bridge', 'Event Bridge', { sub: 'bus → workflow inbox', tier: 'support' }),
  { key: 'studio_orchestrator', kind: 'studio', label: 'Studio orchestrator', sub: 'Studio workflows', family: 'SYSTEM', tier: 'support', description: 'The wf_* runtime that runs workflows authored in Workflow Studio, on their pinned versions.' },
  sys('operator_notifications', 'Operator Notifications', { sub: 'one canonical notification', tier: 'support' }),
  sys('buyer_matching', 'Buyer Matching', { sub: 'operator-invoked', tier: 'support', note: 'Runs when an operator opens a property in Buyer Match — no automated edge leads into it.' }),
])

const E = (id, from, to, kind, label, extra = {}) => ({ id, from, to, kind, label, measure: null, ...extra })

/** Only real relationships. `measure` names the evidence query that counts the edge's traffic. */
export const SYSTEM_MAP_EDGES = Object.freeze([
  E('campaign__dispatch', 'campaign_execution', 'queue_dispatch', 'action', 'Queue plan', { evidence: 'send_queue.campaign_id (campaign_launch_execution)', measure: 'campaign_rows' }),
  E('dispatch__textgrid', 'queue_dispatch', 'textgrid', 'external', 'Dispatch', { evidence: 'send_queue.sent_at · seller_communication_attempts.queue_row_id', measure: 'sent_rows' }),
  E('textgrid__dispatch', 'textgrid', 'queue_dispatch', 'event', 'Delivery callbacks', { evidence: 'provider callback → send_queue.delivered_at', measure: 'delivered_rows' }),
  E('reconcile__dispatch', 'delivery_reconcile', 'queue_dispatch', 'state', 'Missed outcomes', { evidence: 'recover-delivery + queue/reconcile write send_queue', note: 'This runtime keeps no per-run ledger — its heartbeat and last-tick counters are the only record.' }),
  E('textgrid__seller', 'textgrid', 'seller_inbound', 'event', 'Seller replies', { evidence: 'TextGrid inbound webhook → seller_automation_executions', measure: 'seller_runs' }),
  E('seller__dispatch', 'seller_inbound', 'queue_dispatch', 'action', 'Replies · follow-ups', { evidence: 'message_queued.queue_id → send_queue (auto_reply · seller_inbound_orchestrator)', measure: 'seller_rows' }),
  E('seller__negotiation', 'seller_inbound', 'offer_negotiation', 'subworkflow', 'Offer stages', { evidence: 'seller_negotiation_engine events, one invocation per conversation burst (≤ 3 min apart)', measure: 'negotiation_runs' }),
  E('negotiation__dispatch', 'offer_negotiation', 'queue_dispatch', 'action', 'Offers', { evidence: 'offer_queued.queue_row_id → send_queue (row verified)', measure: 'offer_rows' }),
  E('seller__decision', 'seller_inbound', 'decision_engine', 'action', 'Ensure decision', { evidence: 'persist-seller-transition → ensurePropertyAcquisitionDecision', note: 'A decision snapshot does not record its caller — traffic shows on the decision engine, not on this edge.' }),
  E('reconcile_state__decision', 'lead_state_reconcile', 'decision_engine', 'action', 'Ensure decision', { evidence: 'recover-seller-execution-gaps → ensurePropertyAcquisitionDecision', note: 'Not attributable per call (no caller on the snapshot).' }),
  E('seller__dnc', 'seller_inbound', 'dnc_opt_out', 'subworkflow', 'Opt-out branch', { evidence: 'automation_blocked · block_reason opt_out', measure: 'optout_runs' }),
  E('dnc__suppression', 'dnc_opt_out', 'suppression', 'state', 'Suppress number', { evidence: 'sms_suppression_list (source inbound_opt_out)', measure: 'suppressions' }),
  E('suppression__dispatch', 'suppression', 'queue_dispatch', 'state', 'Checked before every send', { evidence: 'compliance gate · OUTBOUND_CANCELLED_COMPLIANCE', measure: 'compliance_cancels' }),
  E('seller__pipeline', 'seller_inbound', 'pipeline', 'action', 'Promote to opportunity', { evidence: 'persist-seller-transition → promoteThreadToOpportunity (opportunity_created)', measure: 'opportunities_created' }),
  E('lead_state__seller', 'lead_state_reconcile', 'seller_inbound', 'state', 'Repair next action', { evidence: 'universal_lead_state_events (seller_execution_gap_recovery)', measure: 'lead_state_repairs' }),
  E('seller__bridge', 'seller_inbound', 'event_bridge', 'event', 'Canonical events', { evidence: 'automation_events · seller_inbound_orchestrator', measure: 'seller_bus_events' }),
  E('dispatch__bridge', 'queue_dispatch', 'event_bridge', 'event', 'Send failures', { evidence: 'queue_item_failed → workflow_events message_failed', measure: 'message_failed_events' }),
  E('bridge__studio', 'event_bridge', 'studio_orchestrator', 'event', 'Workflow inbox', { evidence: 'workflow_events → wf_runs.trigger_event_id', measure: 'wf_runs_started' }),
  E('pipeline__studio', 'pipeline', 'studio_orchestrator', 'event', 'Pipeline events', { evidence: 'opportunity service → workflow_events (opportunity_*)', measure: 'pipeline_events' }),
  E('studio__notifications', 'studio_orchestrator', 'operator_notifications', 'action', 'notify.operator', { evidence: 'wf_run_steps · capability notify.operator', measure: 'wf_notify_steps' }),
  E('seller__notifications', 'seller_inbound', 'operator_notifications', 'event', 'Seller events', { evidence: 'notification_events · domain inbox', measure: 'notifications_inbox' }),
  E('campaign__notifications', 'campaign_execution', 'operator_notifications', 'event', 'Campaign events', { evidence: 'notification_events · domain campaigns', measure: 'notifications_campaigns' }),
  E('closing__email', 'closing_execution', 'email_dispatch', 'action', 'Closing emails', { evidence: 'closing_email_requests → email_queue', measure: 'closing_requests' }),
  E('closing__pipeline', 'closing_execution', 'pipeline', 'state', 'Stage via Closing Authority', { evidence: 'closing-authority → transitionOpportunityStage', measure: 'closing_transitions' }),
  E('closing__notifications', 'closing_execution', 'operator_notifications', 'event', 'At-risk · escalations', { evidence: 'notification_events · closing_* types', measure: 'notifications_closing' }),
  E('email__brevo', 'email_dispatch', 'brevo', 'external', 'Send email', { evidence: 'email_queue → Brevo (email_enabled ∧ EMAIL_SEND_ENABLED)', measure: 'emails_sent', switch: 'email_enabled' }),
])

const PIPELINE_EVENTS = ['opportunity_created', 'opportunity_stage_changed', 'opportunity_status_changed', 'opportunity_manual_override', 'stage_entered', 'opportunity_assigned', 'opportunity_paused', 'opportunity_resumed', 'opportunity_archived', 'contract_status_changed']

/** Evidence queries — each a bounded count over the window, from the owner of the fact. */
const head = (db, table) => db.from(table).select('id', { count: 'exact', head: true })
export const MEASURES = Object.freeze({
  seller_runs: (db, since, d) => countOf(head(db, 'seller_automation_executions').gte('started_at', since).not('thread_id', 'in', NOT_TEST), d, 'seller_automation_executions'),
  seller_rows: (db, since, d) => countOf(head(db, 'send_queue').in('source', ['auto_reply', 'seller_inbound_orchestrator']).gte('created_at', since), d, 'send_queue'),
  campaign_rows: (db, since, d) => countOf(head(db, 'send_queue').eq('source', 'campaign_launch_execution').gte('created_at', since), d, 'send_queue'),
  sent_rows: (db, since, d) => countOf(head(db, 'send_queue').gte('sent_at', since), d, 'send_queue'),
  delivered_rows: (db, since, d) => countOf(head(db, 'send_queue').gte('delivered_at', since), d, 'send_queue'),
  async negotiation_runs(db, since, d) {
    // the subworkflow's own run rule: one invocation = one burst of engine events for a conversation
    const rows = await safe(db.from('automation_events').select('conversation_thread_id, created_at').eq('source', 'seller_negotiation_engine').gte('created_at', since).order('created_at', { ascending: true }).limit(1000), d, 'automation_events')
    const last = new Map()
    let runs = 0
    for (const r of rows) { const p = last.get(r.conversation_thread_id); if (!p || Date.parse(r.created_at) - Date.parse(p) > 3 * 60e3) runs++; last.set(r.conversation_thread_id, r.created_at) }
    return runs
  },
  async offer_rows(db, since, d) {
    // "queued" requires the row: count offer_queued events whose queue_row_id is a real send_queue row
    const ev = await safe(db.from('automation_events').select('id, queue_row_id:payload->>queue_row_id').eq('source', 'seller_negotiation_engine').eq('event_type', 'offer_queued').gte('created_at', since).limit(1000), d, 'automation_events')
    const ids = [...new Set(ev.map((e) => e.queue_row_id).filter(Boolean))]
    if (!ids.length) return 0
    const rows = await safe(db.from('send_queue').select('id').in('id', ids.slice(0, 500)), d, 'send_queue')
    return rows.length
  },
  optout_runs: (db, since, d) => countOf(head(db, 'seller_automation_execution_steps').eq('action_key', 'automation_blocked').eq('block_reason', 'opt_out').gte('created_at', since), d, 'seller_automation_execution_steps'),
  suppressions: (db, since, d) => countOf(head(db, 'sms_suppression_list').eq('source', 'inbound_opt_out').gte('created_at', since), d, 'sms_suppression_list'),
  compliance_cancels: (db, since, d) => countOf(head(db, 'automation_events').eq('event_type', 'OUTBOUND_CANCELLED_COMPLIANCE').gte('created_at', since), d, 'automation_events'),
  opportunities_created: (db, since, d) => countOf(head(db, 'workflow_events').eq('event_type', 'opportunity_created').gte('created_at', since), d, 'workflow_events'),
  lead_state_repairs: (db, since, d) => countOf(head(db, 'universal_lead_state_events').eq('source_view', 'seller_execution_gap_recovery').gte('created_at', since), d, 'universal_lead_state_events'),
  seller_bus_events: (db, since, d) => countOf(head(db, 'automation_events').eq('source', 'seller_inbound_orchestrator').gte('created_at', since), d, 'automation_events'),
  message_failed_events: (db, since, d) => countOf(head(db, 'workflow_events').eq('event_type', 'message_failed').gte('created_at', since), d, 'workflow_events'),
  wf_runs_started: (db, since, d) => countOf(head(db, 'wf_runs').gte('started_at', since), d, 'wf_runs'),
  pipeline_events: (db, since, d) => countOf(head(db, 'workflow_events').in('event_type', PIPELINE_EVENTS).gte('created_at', since), d, 'workflow_events'),
  wf_notify_steps: (db, since, d) => countOf(head(db, 'wf_run_steps').eq('capability', 'notify.operator').eq('status', 'succeeded').gte('at', since), d, 'wf_run_steps'),
  notifications_inbox: (db, since, d) => countOf(head(db, 'notification_events').eq('domain', 'inbox').gte('created_at', since), d, 'notification_events'),
  notifications_campaigns: (db, since, d) => countOf(head(db, 'notification_events').eq('domain', 'campaigns').gte('created_at', since), d, 'notification_events'),
  notifications_closing: (db, since, d) => countOf(head(db, 'notification_events').ilike('event_type', 'closing_%').gte('created_at', since), d, 'notification_events'),
  closing_requests: (db, since, d) => countOf(head(db, 'closing_email_requests').gte('requested_at', since), d, 'closing_email_requests'),
  closing_transitions: (db, since, d) => countOf(head(db, 'closing_activity_events').eq('event_type', 'closing_finalized').gte('created_at', since), d, 'closing_activity_events'),
  emails_sent: (db, since, d) => countOf(head(db, 'email_queue').gte('sent_at', since), d, 'email_queue'),
})

const CONTROL_KEYS = ['email_enabled', 'webhook_live_inbound_last_at', 'webhook_live_delivery_last_at', 'workflow_orchestrator_heartbeat_at', 'workflow_orchestrator_enabled']

let cache = null

/**
 * The map for a window. `traffic.count` is null when the evidence could not be
 * read (the edge is still drawn — it is wired — and the read is reported).
 */
export async function getSystemMap({ window = '24h' } = {}, deps = {}) {
  const w = WINDOWS[window] ? window : '24h'
  const now = deps.now ? deps.now() : Date.now()
  if (!deps.supabase && !deps.noCache && cache && cache.window === w && now - cache.at < 30_000) return cache.value
  const db = deps.supabase || defaultSupabase
  const degraded = []
  const since = iso(now - WINDOWS[w])
  const [ctlRows, studio] = await Promise.all([
    safe(db.from('system_control').select('key, value').in('key', CONTROL_KEYS), degraded, 'system_control'),
    safe(db.from('wf_workflows').select('workflow_key, name, status, live_version').in('status', ['armed', 'paused']), degraded, 'wf_workflows'),
  ])
  const ctl = Object.fromEntries(ctlRows.map((r) => [r.key, r.value]))
  const measured = new Map()
  await Promise.all([...new Set(SYSTEM_MAP_EDGES.map((e) => e.measure).filter(Boolean))].map(async (m) => {
    try { measured.set(m, await MEASURES[m](db, since, degraded)) } catch { degraded.push(m); measured.set(m, null) }
  }))
  const realStudio = studio.filter((s) => !/^test[_ ]/i.test(s.workflow_key) && !/^test\b/i.test(s.name || ''))
  const nodes = SYSTEM_MAP_NODES.map((n) => {
    if (n.key === 'studio_orchestrator') {
      return { ...n, members: realStudio.map((s) => ({ workflow_key: s.workflow_key, name: s.name, status: s.status, version: s.live_version })), heartbeat_at: ctl.workflow_orchestrator_heartbeat_at || null, switched_off: String(ctl.workflow_orchestrator_enabled ?? '').toLowerCase() === 'false' }
    }
    if (n.key === 'textgrid') return { ...n, last_inbound_at: ctl.webhook_live_inbound_last_at || null, last_callback_at: ctl.webhook_live_delivery_last_at || null }
    if (n.key === 'brevo') return { ...n, sending: String(ctl.email_enabled ?? '').toLowerCase() === 'true' }
    return { ...n }
  })
  const edges = SYSTEM_MAP_EDGES.map((e) => {
    const count = e.measure ? measured.get(e.measure) ?? null : null
    const off = e.switch === 'email_enabled' && String(ctl.email_enabled ?? '').toLowerCase() !== 'true'
    const state = off ? 'off' : !e.measure ? 'unmeasured' : count === null ? 'unread' : count > 0 ? 'carrying' : 'quiet'
    return { ...e, traffic: { window: w, count }, state }
  })
  const value = { ok: true, window: w, since, generated_at: iso(now), nodes, edges, degraded: [...new Set(degraded)] }
  if (!deps.supabase) cache = { window: w, at: now, value }
  return value
}

/** Upstream and downstream of a system (for "show dependencies / downstream effects"). */
export function neighboursOf(key, edges = SYSTEM_MAP_EDGES) {
  return {
    upstream: edges.filter((e) => e.to === key).map((e) => e.from),
    downstream: edges.filter((e) => e.from === key).map((e) => e.to),
  }
}

export const SYSTEM_MAP_WINDOWS = Object.keys(WINDOWS)
