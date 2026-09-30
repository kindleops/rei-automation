/**
 * Topologies for the smaller system runtimes: lead-state reconciliation,
 * operator notifications, the canonical event bridge, delivery reconciliation,
 * the acquisition decision engine and buyer matching. Same rules: real order,
 * stable keys, evidence = the ledger fact that proves the node.
 */
import { edge as e, node as n } from '../core.js'

export const LEAD_STATE_RECONCILE = Object.freeze({
  workflow_key: 'lead_state_reconcile',
  topology_version: 'lead-state-reconcile-topology-v1',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from seller-flow/reconcile-state · read-only topology',
  groups: [],
  stages: [
    { key: 'tick', label: 'Every 5 min', nodes: ['reconcile_tick', 'find_stale'] },
    { key: 'evidence', label: 'Canonical evidence?', nodes: ['canonical_next_action'] },
    { key: 'write', label: 'Repair', nodes: ['restore_next_action', 'surface_to_human', 'lead_state_written'] },
  ],
  nodes: [
    n('reconcile_tick', 'TRIGGER', 'Reconcile tick', { summary: 'Cloudflare · every 5 min', evidence: ['tick'], owner: 'Cloudflare scheduler', action: 'POST /api/internal/seller-flow/reconcile-state { limit: 100 }' }),
    n('find_stale', 'DATA_LOOKUP', 'Find threads missing a next action', { summary: 'active · not archived · not suppressed', evidence: ['scan'], action: 'one-entry sweep allowlist', inputs: ['inbox_thread_state.next_action'] }),
    n('canonical_next_action', 'CONDITION', 'Canonical next action exists?', { summary: 'acquisition_opportunities', evidence: ['decision'], inputs: ['acquisition_opportunities.next_action'] }),
    n('restore_next_action', 'STATE_CHANGE', 'Restore next action', { summary: 'copied from the opportunity', evidence: ['ulse:restore'], action: 'patchUniversalLeadState' }),
    n('surface_to_human', 'HUMAN_REVIEW', 'Surface to a person', { lane: -1, summary: 'next_action = human_review', evidence: ['ulse:human_review'], description: 'With no canonical evidence the sweep never invents an outbound action — it marks the lead for a human.', link: { app: 'Inbox', href: '/inbox' } }),
    n('lead_state_written', 'TERMINAL', 'Lead state written', { terminal: 'success', evidence: ['ulse:written'], outputs: ['inbox_thread_state', 'universal_lead_state_events'] }),
  ],
  edges: [
    e('reconcile_tick', 'find_stale'),
    e('find_stale', 'canonical_next_action'),
    e('canonical_next_action', 'restore_next_action', 'primary', 'YES'),
    e('canonical_next_action', 'surface_to_human', 'human', 'NO'),
    e('restore_next_action', 'lead_state_written'),
    e('surface_to_human', 'lead_state_written', 'human'),
  ],
})

export const OPERATOR_NOTIFICATIONS = Object.freeze({
  workflow_key: 'operator_notifications',
  topology_version: 'operator-notifications-topology-v1',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from notification-emitter.js · read-only topology',
  groups: [],
  stages: [
    { key: 'event', label: 'Business event', nodes: ['business_event', 'known_type'] },
    { key: 'dedupe', label: 'Deduplicate', nodes: ['dedupe'] },
    { key: 'deliver', label: 'Deliver', nodes: ['persist', 'deliver_by_severity'] },
    { key: 'close', label: 'Operator', nodes: ['operator_acts', 'notification_closed'] },
  ],
  nodes: [
    n('business_event', 'TRIGGER', 'Business event raised', { summary: 'seller · campaign · closing · studio', evidence: ['event'], action: 'emitNotificationFromBusinessEvent' }),
    n('known_type', 'CONDITION', 'Known notification type?', { summary: 'catalog', evidence: ['catalog'] }),
    n('dedupe', 'DECISION', 'Already raised?', { summary: 'deduplication_key · grouped', evidence: ['dedupe'], outputs: ['notification_events.group_count'] }),
    n('grouped', 'TERMINAL', 'Grouped into existing', { lane: 1, terminal: 'neutral', evidence: ['grouped'] }),
    n('persist', 'ACTION', 'Write notification', { summary: 'notification_events', evidence: ['persist'], outputs: ['notification_events'] }),
    n('deliver_by_severity', 'NOTIFICATION', 'Deliver by severity', { summary: 'feed · pop-up · sound · device push', evidence: ['deliver'], description: 'Severity and the operator’s per-type preferences decide delivery; routine seller replies never buzz a device.' }),
    n('operator_acts', 'HUMAN_REVIEW', 'Operator reads or dismisses', { lane: -1, evidence: ['operator'], link: { app: 'Notifications', href: '/inbox' } }),
    n('notification_closed', 'TERMINAL', 'In the notification centre', { terminal: 'success', evidence: ['closed'] }),
  ],
  edges: [
    e('business_event', 'known_type'),
    e('known_type', 'dedupe', 'primary', 'YES'),
    e('dedupe', 'grouped', 'exception', 'IF DUPLICATE'),
    e('dedupe', 'persist', 'primary', 'NO'),
    e('persist', 'deliver_by_severity'),
    e('deliver_by_severity', 'operator_acts', 'human'),
    e('deliver_by_severity', 'notification_closed'),
    e('operator_acts', 'notification_closed', 'human'),
  ],
})

export const EVENT_BRIDGE = Object.freeze({
  workflow_key: 'event_bridge',
  topology_version: 'event-bridge-topology-v1',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from workflows/runtime-tick · read-only topology',
  groups: [],
  stages: [
    { key: 'read', label: 'Read the bus', nodes: ['bridge_tick', 'read_window'] },
    { key: 'map', label: 'Map', nodes: ['map_event'] },
    { key: 'inbox', label: 'Workflow inbox', nodes: ['write_inbox'] },
    { key: 'consume', label: 'Consumers', nodes: ['orchestrator_consumes', 'v2_matcher'] },
  ],
  nodes: [
    n('bridge_tick', 'TRIGGER', 'Runtime tick', { summary: 'Cloudflare · every 5 min', evidence: ['tick'], action: 'runWorkflowRuntimeTick' }),
    n('read_window', 'DATA_LOOKUP', 'Read automation_events', { summary: 'overlapping window', evidence: ['read'], inputs: ['automation_events'] }),
    n('map_event', 'DECISION', 'A workflow trigger?', { summary: 'bookkeeping + shadow telemetry excluded', evidence: ['map'] }),
    n('write_inbox', 'ACTION', 'Write workflow_events', { summary: 'dedupe_key unique', evidence: ['workflow_events'], outputs: ['workflow_events'] }),
    n('orchestrator_consumes', 'HANDOFF', 'Studio orchestrator', { summary: 'durable cursor', handoff: 'seller_review_escalation', evidence: ['consumed'], owner: 'wf orchestrator' }),
    n('v2_matcher', 'CONDITION', 'V2 matcher (status active)', { lane: 1, summary: 'no real definition armed', evidence: ['v2'], description: 'matchDefinitions requires status=active; the 14 real V2 definitions are published, so nothing is enrolled.' }),
    n('nothing_enrolled', 'TERMINAL', 'Nothing enrolled (V2)', { lane: 1, terminal: 'neutral', evidence: ['v2_none'] }),
  ],
  edges: [
    e('bridge_tick', 'read_window'),
    e('read_window', 'map_event'),
    e('map_event', 'write_inbox', 'primary', 'YES'),
    e('write_inbox', 'orchestrator_consumes', 'handoff'),
    e('write_inbox', 'v2_matcher', 'branch'),
    e('v2_matcher', 'nothing_enrolled', 'branch', 'NO'),
  ],
})

export const DELIVERY_RECONCILE = Object.freeze({
  workflow_key: 'delivery_reconcile',
  topology_version: 'delivery-reconcile-topology-v1',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from recover-delivery + queue/reconcile · read-only topology',
  groups: [],
  stages: [
    { key: 'tick', label: 'Every 5 min', nodes: ['reconcile_tick'] },
    { key: 'delivery', label: 'Delivery outcomes', nodes: ['read_unresolved', 'write_outcome'] },
    { key: 'lifecycle', label: 'Queue lifecycle', nodes: ['expire_stale'] },
  ],
  nodes: [
    n('reconcile_tick', 'TRIGGER', 'Reconcile tick', { summary: 'Cloudflare · every 5 min', evidence: ['tick'], action: 'recover-delivery ∥ queue/reconcile' }),
    n('read_unresolved', 'DATA_LOOKUP', 'Sends without an outcome', { summary: 'no polling fallback', evidence: ['scan'], action: 'include_polling_fallback: false' }),
    n('write_outcome', 'STATE_CHANGE', 'Write delivered / failed', { summary: 'monotonic merge', evidence: ['outcome'], outputs: ['send_queue.delivered_at', 'send_queue.queue_status'] }),
    n('expire_stale', 'STATE_CHANGE', 'Expire stale rows', { lane: 1, summary: 'terminal states only', evidence: ['expire'], action: 'queue/reconcile' }),
    n('reconciled', 'TERMINAL', 'Reconciled', { terminal: 'success', evidence: ['done'] }),
  ],
  edges: [
    e('reconcile_tick', 'read_unresolved'),
    e('read_unresolved', 'write_outcome'),
    e('write_outcome', 'reconciled'),
    e('reconcile_tick', 'expire_stale', 'branch'),
    e('expire_stale', 'reconciled', 'branch'),
  ],
})

export const DECISION_ENGINE = Object.freeze({
  workflow_key: 'decision_engine',
  topology_version: 'decision-engine-topology-v1',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from the acquisition decision authority · read-only topology',
  groups: [],
  stages: [
    { key: 'request', label: 'Decision requested', nodes: ['decision_requested', 'subject_inputs'] },
    { key: 'comps', label: 'Comps', nodes: ['select_comps'] },
    { key: 'value', label: 'Valuation', nodes: ['valuation', 'buyer_ceiling'] },
    { key: 'decide', label: 'Decision', nodes: ['decision_tier', 'snapshot'] },
  ],
  nodes: [
    n('decision_requested', 'TRIGGER', 'Decision requested', { summary: 'seller flow · negotiation · Deal Intelligence', evidence: ['request'], action: 'ensurePropertyAcquisitionDecision' }),
    n('subject_inputs', 'DATA_LOOKUP', 'Subject property facts', { summary: 'canonical property + seller facts', evidence: ['subject'] }),
    n('select_comps', 'AI', 'Select comparable sales', { summary: 'raw → eligible → selected · outliers out', evidence: ['comps'], outputs: ['selected_comps', 'rejected_comps'] }),
    n('valuation', 'ACTION', 'Valuation range', { summary: 'low · mid · high · confidence', evidence: ['valuation'] }),
    n('buyer_ceiling', 'ACTION', 'Buyer ceiling', { summary: 'behaviour + valuation based', evidence: ['ceiling'] }),
    n('decision_tier', 'DECISION', 'Decision tier', { summary: 'hard offer · range · creative · nurture', evidence: ['tier'] }),
    n('snapshot', 'TERMINAL', 'Immutable decision snapshot', { terminal: 'success', evidence: ['snapshot'], outputs: ['acquisition_score_snapshots'], link: { app: 'Deal Intelligence', href: '/deal-intelligence' } }),
  ],
  edges: [
    e('decision_requested', 'subject_inputs'),
    e('subject_inputs', 'select_comps'),
    e('select_comps', 'valuation'),
    e('valuation', 'buyer_ceiling'),
    e('buyer_ceiling', 'decision_tier'),
    e('decision_tier', 'snapshot'),
  ],
})

export const BUYER_MATCHING = Object.freeze({
  workflow_key: 'buyer_matching',
  topology_version: 'buyer-matching-topology-v1',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from buyer-match workspace · read-only topology',
  groups: [],
  stages: [
    { key: 'request', label: 'Property opened', nodes: ['match_requested'] },
    { key: 'rank', label: 'Rank buyers', nodes: ['candidate_buyers', 'grade_buyers'] },
    { key: 'record', label: 'Recorded', nodes: ['match_recorded'] },
  ],
  nodes: [
    n('match_requested', 'TRIGGER', 'Match requested', { summary: 'Buyer Match workspace', evidence: ['request'] }),
    n('candidate_buyers', 'DATA_LOOKUP', 'Candidate buyers', { summary: 'purchase history near the property', evidence: ['candidates'] }),
    n('grade_buyers', 'AI', 'Grade & rank', { summary: 'fit · demand score', evidence: ['grade'] }),
    n('match_recorded', 'TERMINAL', 'Match run recorded', { terminal: 'success', evidence: ['recorded'], outputs: ['buyer_match_runs'], link: { app: 'Buyer Match', href: '/buyer-match' } }),
  ],
  edges: [e('match_requested', 'candidate_buyers'), e('candidate_buyers', 'grade_buyers'), e('grade_buyers', 'match_recorded')],
})
