/**
 * THE WORKFLOW OBSERVATORY REGISTRY — the canonical list of LeadCommand's
 * automations, decided by the audit (docs/workflow-studio/automation-inventory.md),
 * not by what would look good. Each system entry names its owning runtime,
 * ledger, schedule, heartbeat and kill switch; its status is RESOLVED at read
 * time from those, never declared:
 *
 *   live         the runtime is running (heartbeat current, or event-driven with
 *                recent runs, or on-demand with recent runs)
 *   idle         running, but nothing to do in the window
 *   off          scheduled and alive, but its own switch keeps it from acting
 *   paused       its kill switch is off
 *   not_running  built but nothing drives it in production (never shown as live)
 *
 * Studio workflows come from wf_workflows (armed / draft / paused / archived).
 * Workflow V2 templates are listed as not running — published, never subscribed.
 * Test fixtures are flagged and hidden by the surface.
 */
import { DAY, iso, ts } from './core.js'
import { campaignAdapter } from './adapters/campaign.js'
import { closingAdapter, emailAdapter } from './adapters/closing-email.js'
import { sellerAdapter } from './adapters/seller.js'
import { queueAdapter } from './adapters/queue.js'
import { leadStateAdapter, notificationsAdapter, bridgeAdapter, dncAdapter, negotiationAdapter, decisionAdapter, buyerAdapter, deliveryReconcileAdapter } from './adapters/system-small.js'

export const SYSTEM_ADAPTERS = Object.freeze({
  seller_inbound: sellerAdapter,
  queue_dispatch: queueAdapter,
  campaign_execution: campaignAdapter,
  closing_execution: closingAdapter,
  email_dispatch: emailAdapter,
  lead_state_reconcile: leadStateAdapter,
  operator_notifications: notificationsAdapter,
  event_bridge: bridgeAdapter,
  dnc_opt_out: dncAdapter,
  offer_negotiation: negotiationAdapter,
  decision_engine: decisionAdapter,
  buyer_matching: buyerAdapter,
  delivery_reconcile: deliveryReconcileAdapter,
})

const S = (o) => ({ supports: { live: true, runs: true, replay: true, edit: false, simulation: false }, policy_keys: [], parent: null, kind: 'system', ...o })

export const REGISTRY = Object.freeze([
  S({
    workflow_key: 'seller_inbound', name: 'Seller Conversation · Inbound', short_name: 'Seller conversation', family: 'SELLER',
    description: 'Every seller reply: resolve the seller and property, classify the message and extract facts, let the canonical seller decision choose the next move, check contactability, then queue the permitted reply (deduplicated) or hold it for a person — and update canonical stage, lead state and follow-up.',
    owner_app: 'Inbox', owner_href: '/inbox', runtime: 'seller-flow orchestrator', runtime_version: 'seller-inbound-v1',
    trigger: { type: 'seller_reply_received', label: 'Seller replies by SMS or email', source: 'TextGrid inbound webhook · Email Command inbound' },
    subject_type: 'seller_thread', schedule: 'event', heartbeat_key: null, kill_switch: null, policy_keys: ['auto_reply_mode', 'followup_automation_mode'],
    ledger: ['seller_automation_executions', 'seller_automation_execution_steps', 'send_queue'],
  }),
  S({
    workflow_key: 'queue_dispatch', name: 'Outbound Dispatch · Queue Runner', short_name: 'Queue dispatch', family: 'DELIVERY',
    description: 'The only SMS sender. Every minute it claims due queue rows once, revalidates them against every brake, suppression, contact window, sender health and duplicate guard, dispatches through the provider and records the transport outcome.',
    owner_app: 'Queue', owner_href: '/queue', runtime: 'queue runner (queue/run)', runtime_version: 'queue-dispatch-v1',
    trigger: { type: 'queue_row_due', label: 'A queued message is due', source: 'send_queue (scheduled_for ≤ now)' },
    subject_type: 'queue_row', schedule: '* * * * *', heartbeat_key: 'queue_processor_heartbeat_at', heartbeat_stale_ms: 5 * 60e3, kill_switch: null, policy_keys: ['queue_processor_mode', 'queue_execution_mode', 'queue_emergency_stop_at'],
    ledger: ['send_queue', 'seller_logical_communications', 'seller_communication_attempts', 'queue_claim_audit'],
  }),
  S({
    workflow_key: 'delivery_reconcile', name: 'Delivery Reconciliation', short_name: 'Delivery reconciliation', family: 'DELIVERY',
    description: 'Every five minutes, provider delivery outcomes that never arrived by callback are reconciled onto the queue row (delivered / failed), and stale queue lifecycle state is repaired. Send-incapable: it only writes terminal or delivered states.',
    owner_app: 'Queue', owner_href: '/queue', runtime: 'webhooks/recover-delivery + queue/reconcile', runtime_version: 'delivery-reconcile-v1',
    trigger: { type: 'schedule', label: 'Every 5 minutes', source: 'Cloudflare scheduler */5' },
    subject_type: 'queue_row', schedule: '*/5 * * * *', heartbeat_key: 'webhook_delivery_recovery_last_at', heartbeat_stale_ms: 15 * 60e3,
    supports: { live: true, runs: true, replay: false, edit: false, simulation: false },
    ledger: ['send_queue (delivered_at, failed_reason)', 'system_control webhook_delivery_recovery_*'],
  }),
  S({
    workflow_key: 'campaign_execution', name: 'Campaign Execution · Activation & Feeding', short_name: 'Campaign execution', family: 'CAMPAIGN',
    description: 'Every five minutes a due scheduled campaign is activated (a start missed by more than two hours is marked missed, never fired late), and each live campaign is refilled into the queue inside its caps and contact window. The queue runner is the only sender.',
    owner_app: 'Campaign Command', owner_href: '/campaigns', runtime: 'campaigns/activate-due + campaigns/feed', runtime_version: 'campaign-execution-v1',
    trigger: { type: 'schedule', label: 'Every 5 minutes', source: 'Cloudflare scheduler */5' },
    subject_type: 'campaign', schedule: '*/5 * * * *', heartbeat_key: 'campaign_feeder_heartbeat_at', heartbeat_stale_ms: 15 * 60e3, kill_switch: 'queue_auto_enqueue_enabled',
    ledger: ['campaign_runs', 'campaign_events', 'campaigns', 'send_queue'],
  }),
  S({
    workflow_key: 'closing_execution', name: 'Closing Execution · Title & Buyer Coordination', short_name: 'Closing execution', family: 'CLOSING',
    description: 'Once the seller contract is fully executed, Email Command is asked to open title; acknowledgement, commitment, clear to close and settlement are chased on bounded cadences (and the buyer’s EMD and agreement in parallel), escalating to the operator when a counterparty goes silent. Closing Authority alone records milestones; only an operator finalizes.',
    owner_app: 'Closing Desk', owner_href: '/closing-desk', runtime: 'closing-automation.js', runtime_version: 'closing-automation-v1',
    trigger: { type: 'contract_fully_executed', label: 'Seller contract fully executed', source: 'Closing Authority (DocuSign)' },
    subject_type: 'closing_case', schedule: '*/5 * * * *', heartbeat_key: 'closing_automation_heartbeat_at', heartbeat_stale_ms: 15 * 60e3, kill_switch: 'closing_automation_enabled',
    ledger: ['closing_cases', 'closing_email_requests', 'closing_activity_events', 'closing_milestones'],
  }),
  S({
    workflow_key: 'email_dispatch', name: 'Email Dispatch · Revalidate & Send', short_name: 'Email dispatch', family: 'EMAIL',
    description: 'Every minute, closing requests are bridged into the outbox and due emails are claimed once, revalidated against live business state and sent through the brand sender — or superseded, cancelled, deferred or escalated. Sending is double-gated and OFF in production.',
    owner_app: 'Email Command', owner_href: '/email-command', runtime: 'email-dispatch.js', runtime_version: 'email-dispatch-v1',
    trigger: { type: 'schedule', label: 'Every minute', source: 'Cloudflare scheduler * * * * *' },
    subject_type: 'email_message', schedule: '* * * * *', heartbeat_key: 'email_dispatch_heartbeat_at', heartbeat_stale_ms: 5 * 60e3, kill_switch: 'email_enabled',
    ledger: ['email_queue', 'email_events', 'email_inbound_messages'],
  }),
  S({
    workflow_key: 'lead_state_reconcile', name: 'Lead-State Reconciliation', short_name: 'Lead-state reconcile', family: 'SYSTEM',
    description: 'Every five minutes, active seller conversations whose next action went missing are repaired from the canonical opportunity; with no canonical evidence the lead is surfaced to a person (human_review) instead of guessing. Send-incapable by construction.',
    owner_app: 'Inbox', owner_href: '/inbox', runtime: 'seller-flow/reconcile-state', runtime_version: 'seller-state-reconcile-v1',
    trigger: { type: 'schedule', label: 'Every 5 minutes', source: 'Cloudflare scheduler */5' },
    subject_type: 'seller_thread', schedule: '*/5 * * * *', heartbeat_key: 'seller_state_reconcile_heartbeat_at', heartbeat_stale_ms: 15 * 60e3, kill_switch: 'seller_state_reconcile_enabled',
    supports: { live: true, runs: true, replay: false, edit: false, simulation: false },
    ledger: ['universal_lead_state_events', 'automation_events (RECOVERY_*)'],
  }),
  S({
    workflow_key: 'operator_notifications', name: 'Operator Notifications', short_name: 'Notifications', family: 'COMMUNICATION',
    description: 'Business events from every runtime become one canonical, deduplicated notification; severity decides whether it only lands in the notification centre or also buzzes a device.',
    owner_app: 'Notifications', owner_href: '/inbox', runtime: 'notification-emitter.js', runtime_version: 'notifications-v1',
    trigger: { type: 'business_event', label: 'A runtime raises a business event', source: 'seller flow · campaigns · closing · orchestrator' },
    subject_type: 'notification', schedule: 'event', heartbeat_key: null,
    supports: { live: true, runs: true, replay: false, edit: false, simulation: false },
    ledger: ['notification_events'],
  }),
  S({
    workflow_key: 'event_bridge', name: 'Canonical Event Bridge', short_name: 'Event bridge', family: 'SYSTEM',
    description: 'Every five minutes the canonical acquisition bus (automation_events) is bridged into the workflow inbox (workflow_events, unique dedupe key) over an overlapping window. The Studio orchestrator consumes it; the Workflow V2 matcher selects nothing because no real definition is armed.',
    owner_app: 'Workflow Studio', owner_href: '/workflow-studio', runtime: 'workflows/runtime-tick (canonical-event-bridge)', runtime_version: 'event-bridge-v1',
    trigger: { type: 'schedule', label: 'Every 5 minutes', source: 'Cloudflare scheduler */5' },
    subject_type: 'event', schedule: '*/5 * * * *', heartbeat_key: null,
    supports: { live: true, runs: true, replay: false, edit: false, simulation: false },
    ledger: ['automation_events', 'workflow_events'],
  }),
  S({
    workflow_key: 'dnc_opt_out', name: 'Opt-out & DNC', short_name: 'Opt-out & DNC', family: 'COMMUNICATION', parent: 'seller_inbound',
    description: 'When a seller opts out, the seller brain blocks every reply, suppression is applied to the number, pending sends are withdrawn and the conversation is marked uncontactable. The send path re-checks suppression before every dispatch, so no workflow can bypass it.',
    owner_app: 'Inbox', owner_href: '/inbox', runtime: 'seller-flow orchestrator (opt-out branch)', runtime_version: 'seller-inbound-v1',
    trigger: { type: 'seller_opt_out', label: 'Seller opts out (STOP)', source: 'seller inbound classification' },
    subject_type: 'seller_thread', schedule: 'event', heartbeat_key: null,
    supports: { live: true, runs: true, replay: true, edit: false, simulation: false },
    ledger: ['seller_automation_execution_steps (opt_out)', 'sms_suppression_list', 'automation_events SUPPRESSION_APPLIED'],
  }),
  S({
    workflow_key: 'offer_negotiation', name: 'Offer Negotiation · S3–S6', short_name: 'Offer negotiation', family: 'ACQUISITION', parent: 'seller_inbound',
    description: 'Inside a seller conversation, the negotiation engine captures the asking price, recalculates underwriting, selects a strategy and queues an offer only inside the authorized ceiling — or asks for review.',
    owner_app: 'Deal Intelligence', owner_href: '/deal-intelligence', runtime: 'seller negotiation engine', runtime_version: 'negotiation-v1',
    trigger: { type: 'seller_decision', label: 'Canonical seller decision in S3–S6', source: 'seller-flow orchestrator' },
    subject_type: 'opportunity', schedule: 'event', heartbeat_key: null,
    supports: { live: true, runs: true, replay: true, edit: false, simulation: false },
    ledger: ['seller_automation_decisions', 'automation_events (seller_negotiation_engine)'],
  }),
  S({
    workflow_key: 'decision_engine', name: 'Acquisition Decision · Comps & Valuation', short_name: 'Decision engine', family: 'ACQUISITION',
    description: 'On demand — when a property needs a decision (seller flow, negotiation, Deal Intelligence) — comps are selected and scored, a valuation and buyer ceiling computed, and an authorized offer range recorded as an immutable snapshot.',
    owner_app: 'Deal Intelligence', owner_href: '/deal-intelligence', runtime: 'decisionAuthority (ensurePropertyAcquisitionDecision)', runtime_version: 'acquisition-engine-v3',
    trigger: { type: 'on_demand', label: 'A property needs a current decision', source: 'seller flow · negotiation · Deal Intelligence' },
    subject_type: 'property', schedule: 'on_demand', heartbeat_key: null,
    supports: { live: true, runs: true, replay: false, edit: false, simulation: false },
    ledger: ['acquisition_score_snapshots', 'property_acquisition_scores'],
  }),
  S({
    workflow_key: 'buyer_matching', name: 'Buyer Matching', short_name: 'Buyer matching', family: 'BUYER',
    description: 'On demand from Buyer Match: rank the buyers whose purchase history fits the property and record the run with its grade and demand score.',
    owner_app: 'Buyer Match', owner_href: '/buyer-match', runtime: 'buyer-match workspace service', runtime_version: 'buyer-match-v1',
    trigger: { type: 'on_demand', label: 'Operator opens a property in Buyer Match', source: 'Buyer Match' },
    subject_type: 'property', schedule: 'on_demand', heartbeat_key: null,
    supports: { live: false, runs: true, replay: false, edit: false, simulation: false },
    ledger: ['buyer_match_runs', 'buyer_match_candidates'],
  }),
])

/** Built, present in code, and NOT driven in production — listed so nobody mistakes them for live. */
export const NOT_RUNNING = Object.freeze([
  { workflow_key: 'delivery_retry', name: 'Delivery Recovery · Retry', family: 'DELIVERY', reason: 'queue/retry is not on the production schedule and system_control.retry_enabled=false; no transport attempt beyond #1 has ever been recorded.', runtime: 'queue/retry · workflow-v2/delivery-recovery.js', owner_app: 'Queue' },
  { workflow_key: 'inbound_burst_flush', name: 'Inbound Burst Flush & Recovery', family: 'SELLER', reason: 'seller-flow/flush-inbound-bursts and recover-inbound are deliberately absent from the production schedule; their heartbeats stopped 2026-09-17 when the Vercel crons were removed.', runtime: 'seller-flow/flush-inbound-bursts · webhooks/recover-inbound', owner_app: 'Inbox' },
  { workflow_key: 'follow_up_scheduler_legacy', name: 'Follow-up Scheduler (legacy lane)', family: 'SELLER', reason: 'follow_up_scheduler_heartbeat_at last moved 2026-09-17 (Vercel lane removed); follow-ups are now scheduled inside the seller flow and sent by the queue runner.', runtime: 'seller-flow follow-up legs', owner_app: 'Inbox' },
  { workflow_key: 'autopilot', name: 'Autopilot Run', family: 'ACQUISITION', reason: 'autopilot/run is explicitly excluded from the production schedule (can cause seller-visible sends).', runtime: 'autopilot/run', owner_app: 'Pipeline' },
])

const beat = (at, now, staleMs) => {
  const t = ts(at)
  if (t === null) return 'never'
  return now - t > staleMs ? 'stale' : 'current'
}

const EMPTY_STATS = { runs_today: null, runs_24h: null, runs_7d: null, needs_you: null, in_flight: null, executing: null, waiting: null, failed_24h: null, last_run_at: null }

/** The Studio orchestrator's own heartbeat (Cloudflare, every 5 min) — read, never assumed. */
export const ORCHESTRATOR_HEARTBEAT = 'workflow_orchestrator_heartbeat_at'
export const ORCHESTRATOR_SWITCH = 'workflow_orchestrator_enabled'

export function resolveSystemStatus(r, { ctl = {}, now = Date.now(), stats = null, current = null } = {}) {
  const hbAt = r.heartbeat_key ? ctl[r.heartbeat_key] || null : null
  const hb = r.heartbeat_key ? beat(hbAt, now, r.heartbeat_stale_ms || 15 * 60e3) : r.schedule === 'on_demand' ? 'on_demand' : 'event_driven'
  const last = stats?.last_run_at || null
  const recent = last && now - Date.parse(last) < 7 * DAY
  let status = 'live'
  let note = null
  if (r.heartbeat_key) {
    if (hb === 'never') { status = 'not_running'; note = 'No heartbeat has ever been written' }
    else if (hb === 'stale') { status = 'not_running'; note = `Heartbeat stale since ${String(hbAt).slice(0, 16).replace('T', ' ')}Z` }
  } else if (!recent) { status = 'idle'; note = last ? `No run in 7 days (last ${String(last).slice(0, 10)})` : 'No run recorded' }
  if (status === 'live' && r.kill_switch) {
    const v = String(ctl[r.kill_switch] ?? '').toLowerCase()
    if (r.workflow_key === 'email_dispatch' && v !== 'true') { status = 'off'; note = 'Scheduled every minute · sending is hard-off (email_enabled=false)' }
    else if (v === 'false') { status = 'paused'; note = `${r.kill_switch} = false` }
  }
  if (status === 'live' && r.workflow_key === 'closing_execution' && !(current?.in_flight)) note = 'Running every 5 min · no live closings'
  if (status === 'live' && r.schedule === 'on_demand') note = 'On demand'
  const group = status === 'not_running' ? 'not_running' : status === 'paused' ? 'paused' : 'live_system'
  return {
    workflow_key: r.workflow_key, name: r.name, short_name: r.short_name, description: r.description, family: r.family, kind: 'system',
    owner_app: r.owner_app, owner_href: r.owner_href, runtime: r.runtime, runtime_version: r.runtime_version,
    status, status_note: note, group, trigger: r.trigger, subject_type: r.subject_type, supports: r.supports,
    topology_version: SYSTEM_ADAPTERS[r.workflow_key]?.topology?.topology_version || null,
    heartbeat: { key: r.heartbeat_key || null, at: hbAt, state: hb, cadence: r.schedule === 'event' ? 'event-driven' : r.schedule === 'on_demand' ? 'on demand' : r.schedule === '* * * * *' ? 'every minute' : r.schedule === '*/5 * * * *' ? 'every 5 min' : r.schedule },
    schedule: r.schedule, ledger: r.ledger, parent: r.parent || null,
    policy: Object.fromEntries((r.policy_keys || []).map((k) => [k, ctl[k] ?? null])),
    stats: {
      ...EMPTY_STATS, ...(stats || {}),
      needs_you: current?.needs_you ? current.needs_you.length : stats?.needs_you ?? 0,
      in_flight: current?.in_flight ?? stats?.in_flight ?? 0,
      // executing = runtime evidence of work in progress right now; waiting = scheduled, healthy waits
      executing: current ? current.executing ?? 0 : null,
      waiting: current ? current.waiting ?? 0 : null,
      ...(current?.follow_ups_scheduled !== undefined ? { follow_ups_scheduled: current.follow_ups_scheduled } : {}),
      ...(current?.feeding !== undefined ? { feeding: current.feeding } : {}),
    },
  }
}

export function studioEntry(w, observed = [], current = null, { now = Date.now(), dayStart, ctl = null } = {}) {
  const v = w.live || w.latest
  const hbAt = ctl ? ctl[ORCHESTRATOR_HEARTBEAT] || null : null
  const hbState = ctl ? beat(hbAt, now, 15 * 60e3) : 'never'
  const switchedOff = ctl ? String(ctl[ORCHESTRATOR_SWITCH] ?? '').toLowerCase() === 'false' : false
  const runs = observed.map((o) => o.run)
  const day0 = dayStart || iso(Math.floor(now / DAY) * DAY)
  const test = /^test[_ ]/i.test(w.workflow_key) || /^test\b/i.test(w.name || '')
  const status = w.status === 'armed' ? 'armed' : w.status
  const group = w.status === 'armed' ? 'studio' : w.status === 'draft' ? 'drafts' : w.status === 'paused' ? 'paused' : 'archived'
  const mine = (current?.live || []).filter((x) => x.workflow_key === w.workflow_key)
  const needs = (current?.needs_you || []).filter((x) => x.workflow_key === w.workflow_key)
  return {
    workflow_key: w.workflow_key, name: w.name, short_name: w.name, description: v?.description || '', family: String(w.domain || 'seller').toUpperCase() === 'SELLER' ? 'SELLER' : String(w.domain || '').toUpperCase() || 'SYSTEM', kind: 'studio',
    owner_app: 'Workflow Studio', owner_href: '/workflow-studio', runtime: 'wf orchestrator', runtime_version: v ? `v${v.version}` : '—',
    status, status_note: w.status === 'armed' ? (switchedOff ? `Armed · v${w.live_version} · orchestrator switched off` : hbState === 'stale' ? `Armed · v${w.live_version} · orchestrator heartbeat stale` : `Armed · v${w.live_version}`) : w.status === 'draft' ? 'Draft — nothing runs' : w.status === 'paused' ? 'Paused — no new runs; runs in flight do not advance' : null, group,
    trigger: { type: v?.graph?.trigger?.type || null, label: v?.graph?.trigger?.type ? v.graph.trigger.type.replace(/_/g, ' ') : '—', source: 'workflow_events (canonical bridge)' },
    subject_type: 'seller_thread', supports: { live: true, runs: true, replay: true, edit: true, simulation: true },
    topology_version: v ? `${w.workflow_key}@v${v.version}` : null,
    heartbeat: { key: ORCHESTRATOR_HEARTBEAT, at: hbAt, state: hbState, cadence: 'every 5 min' },
    schedule: '*/5 * * * *', ledger: ['wf_runs', 'wf_run_steps', 'wf_waits'], parent: null, policy: {}, test,
    stats: {
      runs_today: runs.filter((r) => r.started_at >= day0).length, runs_24h: runs.filter((r) => Date.parse(r.started_at) > now - DAY).length, runs_7d: runs.length,
      needs_you: needs.length, in_flight: mine.length, failed_24h: runs.filter((r) => r.status === 'failed' && Date.parse(r.started_at) > now - DAY).length,
      executing: mine.filter((x) => x.status === 'running').length, waiting: mine.filter((x) => x.status === 'waiting').length,
      last_run_at: runs[0]?.started_at || null,
    },
  }
}

export function notRunningEntries() {
  return NOT_RUNNING.map((x) => ({
    workflow_key: x.workflow_key, name: x.name, short_name: x.name, description: x.reason, family: x.family, kind: 'system',
    owner_app: x.owner_app, owner_href: null, runtime: x.runtime, runtime_version: '—', status: 'not_running', status_note: 'Built · not driven in production', group: 'not_running',
    trigger: { type: 'none', label: 'Not scheduled', source: '—' }, subject_type: '—', supports: { live: false, runs: false, replay: false, edit: false, simulation: false },
    topology_version: null, heartbeat: { key: null, at: null, state: 'never', cadence: null }, schedule: null, ledger: [], parent: null, policy: {}, stats: { ...EMPTY_STATS },
  }))
}

/** Workflow V2 definitions: published templates no production event subscribes; test fixtures flagged. */
export async function v2Entries(db, { degraded = [] } = {}) {
  const { data, error } = await db.from('workflow_definitions').select('id, name, definition_key, status, trigger_type, updated_at').neq('status', 'archived').limit(200)
  if (error) { degraded.push('workflow_definitions'); return [] }
  return (data || []).map((d) => {
    const key = d.definition_key || d.id
    const test = /^test[_ ]/i.test(key) || /^test\b/i.test(d.name || '')
    return {
      workflow_key: `v2:${key}`, name: d.name || key, short_name: d.name || key, description: d.status === 'published' ? 'Workflow V2 template — published, but no production event subscribes it; nothing is enrolled.' : `Workflow V2 ${d.status}`,
      family: 'SELLER', kind: 'studio', owner_app: 'Workflow Studio', owner_href: null, runtime: 'Workflow V2 (legacy)', runtime_version: '—',
      status: 'not_running', status_note: `V2 ${d.status} · ${String(d.trigger_type || '').replace(/^trigger\./, '') || 'no trigger'}`, group: 'not_running',
      trigger: { type: d.trigger_type || 'none', label: String(d.trigger_type || '—').replace(/^trigger\./, '').replace(/_/g, ' '), source: 'Workflow V2' },
      subject_type: '—', supports: { live: false, runs: false, replay: false, edit: false, simulation: false },
      topology_version: null, heartbeat: { key: null, at: null, state: 'never', cadence: null }, schedule: null, ledger: ['workflow_definitions'], parent: null, policy: {}, test,
      stats: { ...EMPTY_STATS },
    }
  })
}
