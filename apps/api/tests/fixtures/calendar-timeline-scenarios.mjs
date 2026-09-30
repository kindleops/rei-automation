/**
 * CALENDAR TIMELINE SCENARIOS — raw canonical rows (campaigns, campaign_targets,
 * send_queue, inbox_thread_state, acquisition_opportunities, properties,
 * wf_runs/wf_versions, email_queue, system_control) for the calendar states
 * production does not hold today: a live closing, a running workflow timer,
 * a manual scheduled message, a follow-up cluster.
 *
 * RAW ROWS, run through the real loader (getCalendarTimeline, view=desk) by
 * scripts/gen-calendar-demo.mjs into the dashboard's ?demo=1 data. Always
 * labelled DEMO in the UI; never served by the API.
 */
import { deriveClosingExecution } from '../../src/lib/domain/closings/closing-execution-model.js'
import { closingScenarios } from './closing-execution-scenarios.mjs'

export const DEMO_NOW = Date.parse('2026-09-30T14:20:00Z') // 9:20 AM CDT
const iso = (ms) => new Date(ms).toISOString()
const M = 60_000
const H = 60 * M

export const DEMO_GRAPH = {
  name: 'Seller review escalation',
  nodes: [
    { id: 'grace', kind: 'wait', label: 'Give the team 4 hours', config: { mode: 'duration', anchor: 'trigger', duration_hours: 4 } },
    { id: 'still_open', kind: 'condition', label: 'Still needs a human?', config: { condition: 'seller.conversation_open' } },
    { id: 'escalate', kind: 'action', label: 'Escalate to operator', config: { capability: 'notify.operator' } },
    { id: 'escalated', kind: 'terminate', label: 'Escalated' },
    { id: 'handled', kind: 'terminate', label: 'Handled in time' },
  ],
  edges: [{ from: 'trigger', to: 'grace' }, { from: 'grace', to: 'still_open' }, { from: 'still_open', to: 'escalate', exit: 'Open' }, { from: 'still_open', to: 'handled', exit: 'Handled' }, { from: 'escalate', to: 'escalated' }],
}

export function calendarScenarioTables(now = DEMO_NOW) {
  const MPLS = 'demo-campaign-mpls'
  const ATL = 'demo-campaign-atl'
  const campaigns = [
    { id: MPLS, name: 'Map area · Minneapolis, MN · 944 properties', status: 'active', scheduled_for: iso(now - 2 * 24 * H), contact_window_start: '08:00', contact_window_end: '21:00', daily_cap: 750, per_sender_cap: 800, updated_at: iso(now - 5 * M),
      metadata: { timezone: 'America/Chicago', feeder_last: { at: iso(now - 5 * M), bound: 'buffer', reason: 'refilled', stalled: false, sent_today: 212, ready_remaining: 291, active_live_rows: 150, last_refill_at: iso(now - 10 * M), held_targets: 60 } } },
    { id: ATL, name: 'Map area · Atlanta, GA · 220 properties', status: 'scheduled', scheduled_for: '2026-10-01T12:00:00.000Z', contact_window_start: '08:00', contact_window_end: '21:00', daily_cap: 250, per_sender_cap: 800, updated_at: iso(now - 20 * H),
      metadata: { timezone: 'America/New_York' } },
  ]
  const campaign_targets = [
    ...Array.from({ length: 291 }, () => ({ campaign_id: MPLS, target_status: 'ready' })),
    ...Array.from({ length: 212 }, () => ({ campaign_id: MPLS, target_status: 'planned' })),
    ...Array.from({ length: 60 }, () => ({ campaign_id: MPLS, target_status: 'blocked' })),
    ...Array.from({ length: 220 }, () => ({ campaign_id: ATL, target_status: 'ready' })),
  ]
  const t0 = Date.parse('2026-09-30T13:00:00Z')
  const campaignRows = [
    ...Array.from({ length: 212 }, (_, i) => ({ id: `mpls-sent-${i}`, campaign_id: MPLS, queue_status: i % 9 === 0 ? 'failed_transport' : 'delivered', failed_reason: i % 9 === 0 ? 'delivery_failed' : null, scheduled_for: iso(t0 + i * 21_000), sent_at: iso(t0 + i * 21_000 + 4000), from_phone_number: '+16125092382' })),
    ...Array.from({ length: 150 }, (_, i) => ({ id: `mpls-q-${i}`, campaign_id: MPLS, queue_status: 'queued', scheduled_for: iso(now + 5 * M + i * 45_000), from_phone_number: '+16125092382' })),
  ]
  const tomorrow8 = Date.parse('2026-10-01T13:00:00Z')
  const followups = Array.from({ length: 37 }, (_, i) => ({
    id: `fu-${i}`, thread_key: `+1612555${String(2000 + i).padStart(4, '0')}`, queue_status: 'scheduled', message_type: 'followup', source: 'seller_inbound_orchestrator',
    followup_reason: 'nurture_followup:condition_signal', scheduled_for: iso(tomorrow8 + (i % 6) * 2 * M), property_address_state: 'MN', property_address_zip: '55408',
    seller_display_name: ['Dana Whitfield', 'Marcus Lee', 'Priya Natarajan', 'Tom Brennan', 'Alicia Gomez', 'Ron Castillo'][i % 6], property_address: `${3100 + i * 7} Bryant Ave S, Minneapolis, MN 55408`, execution_policy_version: 'seller_conversation_v8',
  }))
  const singles = [
    { id: 'manual-1', thread_key: '+13055550131', queue_status: 'scheduled', message_type: 'manual_scheduled_reply', source: 'inbox_bulk_follow_up', scheduled_for: '2026-09-30T20:30:00.000Z', property_address_state: 'FL', property_address_zip: '33133', seller_display_name: 'Evelyn Brooks', property_address: '2840 SW 27th Ave, Miami, FL 33133' },
    { id: 'early-1', thread_key: '+16125550177', queue_status: 'scheduled', message_type: 'followup', source: 'seller_inbound_orchestrator', followup_reason: 'nurture_followup:asking_price_value', scheduled_for: '2026-10-01T12:15:00.000Z', property_address_state: 'MN', property_address_zip: '55406', seller_display_name: 'Gary Olson', property_address: '3342 42nd Ave S, Minneapolis, MN 55406', execution_policy_version: 'seller_conversation_v8' },
    { id: 'blocked-1', thread_key: '+14045550190', queue_status: 'blocked_sender_number', blocked_reason: 'blocked_sender_number', message_type: 'Follow-Up', source: 'auto_reply', scheduled_for: '2026-09-29T16:05:00.000Z', property_address_state: 'GA', property_address_zip: '30310', seller_display_name: 'Paul Carter', property_address: '1187 Lawton St SW, Atlanta, GA 30310' },
    { id: 'cancel-1', thread_key: '+16125550188', queue_status: 'cancelled', message_type: 'followup', source: 'seller_inbound_orchestrator', followup_reason: 'nurture_followup:not_interested', cancellation_reason: 'cancelled_followup_on_inbound_reply', cancelled_by: 'inbound_takeover', scheduled_for: '2026-10-06T15:00:00.000Z', property_address_state: 'MN', property_address_zip: '55407', seller_display_name: 'Janet Ruiz', property_address: '3808 Chicago Ave, Minneapolis, MN 55407' },
    { id: 'auto-ok-1', thread_key: '+16125550166', queue_status: 'delivered', message_type: 'Follow-Up', source: 'auto_reply', scheduled_for: '2026-09-30T13:31:40.000Z', sent_at: '2026-09-30T13:31:44.000Z', seller_display_name: 'Kevin Tran', property_address: '4521 Nicollet Ave, Minneapolis, MN 55419' },
  ]
  const inbox_thread_state = [
    // answered reply marker → completed history
    { thread_key: '+16125550166', property_id: 'demo-prop-166', next_action: '', next_action_at: '2026-09-30T13:31:10.000Z', last_inbound_at: '2026-09-30T13:31:14.000Z', last_outbound_at: '2026-09-30T13:31:44.000Z', inbox_bucket: 'waiting', status: 'waiting_on_seller' },
    // seller wrote again → superseded history
    { thread_key: '+16125550155', property_id: 'demo-prop-155', next_action: 'schedule_follow_up', follow_up_at: '2026-09-29T22:00:00.000Z', next_action_at: '2026-09-29T22:00:00.000Z', last_inbound_at: '2026-09-30T14:59:00.000Z', last_outbound_at: '2026-09-29T15:02:00.000Z', inbox_bucket: 'new_replies', status: 'new_reply' },
    // a review that is yours, due 2 PM CT today
    { thread_key: '+16125550144', property_id: 'demo-prop-144', next_action: 'human_review', next_action_at: '2026-09-30T19:00:00.000Z', last_inbound_at: '2026-09-30T12:40:00.000Z', last_outbound_at: '2026-09-30T12:31:00.000Z', inbox_bucket: 'needs_review', status: 'needs_review' },
    // seller replied, nothing went out → stale
    { thread_key: '+16125550133', property_id: 'demo-prop-133', next_action: '', next_action_at: '2026-09-29T20:33:29.000Z', last_inbound_at: '2026-09-29T20:33:34.000Z', last_outbound_at: '2026-09-29T20:20:00.000Z', inbox_bucket: 'priority', status: 'new_reply' },
  ]
  const acquisition_opportunities = [
    { id: '10000000-0000-4000-8000-000000000166', primary_thread_key: '+16125550166', seller_display_name: 'Kevin Tran', property_address_full: '4521 Nicollet Ave, Minneapolis, MN 55419', acquisition_stage: 'ownership_confirmation', opportunity_status: 'active' },
    { id: '10000000-0000-4000-8000-000000000155', primary_thread_key: '6125550155', seller_display_name: 'Maria Sandoval', property_address_full: '2215 E 24th St, Minneapolis, MN 55404', acquisition_stage: 'asking_price', opportunity_status: 'active' },
    { id: '10000000-0000-4000-8000-000000000144', primary_thread_key: '+16125550144', seller_display_name: 'Harold Jensen', property_address_full: '5012 Penn Ave N, Minneapolis, MN 55430', acquisition_stage: 'offer_interest', opportunity_status: 'active' },
    { id: '10000000-0000-4000-8000-000000000133', primary_thread_key: '+16125550133', seller_display_name: 'Denise Walker', property_address_full: '1409 Russell Ave N, Minneapolis, MN 55411', acquisition_stage: 'property_condition', opportunity_status: 'active' },
  ]
  const properties = ['166', '155', '144', '133'].map((n) => ({ property_id: `demo-prop-${n}`, property_address_full: null, property_address_state: 'MN', property_address_zip: '55411' }))
  const wf_runs = [
    { id: 'demo-run-waiting', workflow_key: 'seller_review_escalation', version: 1, subject_kind: 'thread_key', subject_id: '+16125550144', trigger_event_type: 'human_review_requested', state: 'waiting', cursor: 'grace',
      wake_at: iso(Date.parse('2026-09-30T12:45:00Z') + 4 * H), context: { event: { at: '2026-09-30T12:45:00.000Z', type: 'human_review_requested' }, trigger: { thread_key: '+16125550144', property_id: 'demo-prop-144', opportunity_id: '+16125550144' }, timers: { grace: iso(Date.parse('2026-09-30T12:45:00Z') + 4 * H) } },
      started_at: '2026-09-30T12:45:30.000Z', updated_at: '2026-09-30T12:45:30.000Z' },
    { id: 'demo-run-done', workflow_key: 'seller_review_escalation', version: 1, subject_kind: 'thread_key', subject_id: '+16125550133', trigger_event_type: 'human_review_requested', state: 'completed', cursor: 'escalated', outcome: 'escalated',
      context: { event: { at: '2026-09-29T18:15:56.000Z' }, trigger: { thread_key: '+16125550133' } }, started_at: '2026-09-29T18:20:54.000Z', updated_at: '2026-09-29T22:20:45.000Z', finished_at: '2026-09-29T22:20:45.000Z' },
  ]
  const wf_run_steps = [
    { run_id: 'demo-run-waiting', node_id: 'grace', kind: 'wait', status: 'waiting', reason: 'until 2026-09-30T16:45:00.000Z', at: '2026-09-30T12:45:30.000Z' },
    { run_id: 'demo-run-done', node_id: 'grace', kind: 'wait', status: 'waiting', reason: 'until 2026-09-29T22:15:56.000Z', at: '2026-09-29T18:20:54.000Z' },
    { run_id: 'demo-run-done', node_id: 'still_open', kind: 'condition', status: 'resolved', exit: 'Open', reason: 'v_inbox_thread_state_buckets.in_needs_review / in_new_replies', at: '2026-09-29T22:20:45.000Z' },
    { run_id: 'demo-run-done', node_id: 'escalate', kind: 'action', status: 'succeeded', at: '2026-09-29T22:20:45.000Z' },
  ]
  const email_queue = [
    { id: 'demo-email-1', queue_status: 'scheduled', scheduled_for: '2026-09-30T15:00:00.000Z', subject: 'Title order — 4410 Xerxes Ave S', to_email: 'orders@westline-title.example', source: 'closing_automation', approval_status: 'approved', closing_case_id: 'closing:00000000-0000-4000-8000-000000000003', updated_at: iso(now - 2 * H) },
  ]
  const system_control = [
    { key: 'queue_processor_mode', value: 'live' }, { key: 'queue_execution_mode', value: 'normal' }, { key: 'queue_emergency_stop_at', value: '' },
    { key: 'queue_contact_window_start', value: '08:00' }, { key: 'queue_contact_window_end', value: '21:00' }, { key: 'email_enabled', value: 'false' },
    { key: 'workflow_orchestrator_enabled', value: 'true' }, { key: 'workflow_orchestrator_heartbeat_at', value: iso(now - 4 * M) },
  ]
  return {
    campaigns, campaign_targets, send_queue: [...campaignRows, ...followups, ...singles], inbox_thread_state, acquisition_opportunities, properties,
    wf_runs, wf_versions: [{ workflow_key: 'seller_review_escalation', version: 1, graph: DEMO_GRAPH }], wf_workflows: [{ workflow_key: 'seller_review_escalation', name: 'Seller review escalation', status: 'armed', live_version: 1 }],
    wf_waits: [], wf_run_steps, email_queue, system_control, seller_offers: [],
  }
}

/** Closings through the real Closing Desk derivation (the shared scenarios). */
export function calendarScenarioClosings(now = DEMO_NOW) {
  return closingScenarios(now).map((s) => deriveClosingExecution({ ...s, now }))
}

/** A chainable, read-only stand-in for the Supabase client over these rows. */
export function scenarioDb(tables) {
  return {
    from(table) {
      const rows = tables[table] || []
      const q = {
        select: () => q, or: () => q, in: () => q, eq: () => q, gte: () => q, lt: () => q, limit: () => q, order: () => q,
        maybeSingle: async () => ({ data: rows[0] || null, error: null }), single: async () => ({ data: rows[0] || null, error: null }),
        then: (res, rej) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      }
      return q
    },
  }
}
