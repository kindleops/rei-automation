/**
 * Topologies for Campaign Execution, Closing Automation and Email Dispatch —
 * each mirrors its runtime's real order (audit: docs/workflow-studio/
 * automation-inventory.md §Campaign, §Closing, §Email). Evidence keys name the
 * exact ledger fact that proves a node; the adapters emit those keys.
 */
import { edge as e, node as n } from '../core.js'

/* ── CAMPAIGN EXECUTION ────────────────────────────────────────────────────
 * Two jobs on the same five-minute tick run CONCURRENTLY (the Worker fans them out),
 * so activation and the rolling feeder are two lanes. A run is one
 * `campaign_runs` hydration pass (lock_owner scheduled_worker = activation,
 * campaign_feeder = refill); a feeder tick with no room writes no run.
 */
export const CAMPAIGN_EXECUTION = Object.freeze({
  workflow_key: 'campaign_execution',
  topology_version: 'campaign-execution-topology-v3',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from campaign activate-due + feeder · read-only topology',
  groups: [],
  stages: [
    { key: 'tick', label: 'Every 5 min', nodes: ['campaign_tick'] },
    { key: 'activate', label: 'Activate due', nodes: ['find_due', 'schedule_missed', 'launch_readiness', 'hydrate_first_chunk', 'activate_campaign'] },
    { key: 'feed', label: 'Refill queue', nodes: ['auto_enqueue_gate', 'find_feedable', 'spam_recycle', 'feed_room', 'queue_plan'] },
    { key: 'dispatch', label: 'Queue runner', nodes: ['dispatch_handoff'] },
    { key: 'resolve', label: 'Complete', nodes: ['cohort_resolved', 'campaign_completed'] },
  ],
  nodes: [
    n('campaign_tick', 'TRIGGER', 'Campaign scheduler tick', { summary: 'Cloudflare · every 5 min', evidence: ['tick'], owner: 'Cloudflare scheduler', action: 'CAMPAIGN_ACTIVATE_DUE ∥ CAMPAIGN_FEED', description: 'Both campaign jobs are fanned out on the same five-minute tick and run concurrently. Neither transmits — the queue runner is the only sender.' }),
    // activation lane (above the spine)
    n('find_due', 'DATA_LOOKUP', 'Find due scheduled campaigns', { lane: -1, summary: 'status scheduled · start ≤ now', evidence: ['activation:scanned'], action: 'findDueScheduledCampaigns', inputs: ['campaigns.status', 'campaigns.scheduled_for'] }),
    n('schedule_missed', 'CONDITION', 'Start missed?', { lane: -1, summary: 'never auto-fired', evidence: ['activation:missed_check'], action: 'isScheduleMissed', description: 'A start that passes without activation (or that readiness refused) is marked missed (metadata.schedule_missed_at) and waits for the operator to reschedule or activate — it is never fired late.' }),
    n('marked_missed', 'TERMINAL', 'Marked missed', { lane: -2, terminal: 'human', summary: 'operator reschedules', evidence: ['campaigns.metadata.schedule_missed_for'], link: { app: 'Campaign Command', href: '/campaigns' } }),
    n('launch_readiness', 'CONDITION', 'Launch readiness', { lane: -1, summary: 'caps · window · recipients · routing', evidence: ['activation:readiness'], action: 'evaluateCampaignLaunchReadiness', description: 'Blocking codes (missing cap, missing window, no ready recipients, routing zero, provider disabled) stop the activation; nothing is persisted and it is retried every tick until the two-hour grace expires.' }),
    n('hydrate_first_chunk', 'ACTION', 'Hydrate first chunk', { lane: -1, optional: true, summary: 'queue plan · batch_max', evidence: ['campaign_runs:scheduled_worker'], action: 'activateCampaignWithHydration → createCampaignQueuePlan', outputs: ['campaign_runs', 'campaign_send_windows', 'send_queue (scheduled)'] }),
    n('activate_campaign', 'STATE_CHANGE', 'Activate campaign', { lane: -1, summary: 'scheduled → activating → active', evidence: ['campaign_events:campaign.activated'], action: 'campaign_transition_status (RPC)', owner: 'Campaign lifecycle authority' }),
    // feeder lane (the spine)
    n('auto_enqueue_gate', 'CONDITION', 'Auto-enqueue on?', { summary: 'queue_auto_enqueue_enabled', evidence: ['feeder:gate'], action: 'runCampaignOutboundFeeder', inputs: ['system_control.queue_auto_enqueue_enabled'] }),
    n('find_feedable', 'DATA_LOOKUP', 'Find live campaigns', { summary: 'active · auto_queue_enabled', evidence: ['feeder:scanned'], action: 'findFeedableCampaigns', inputs: ['campaigns.status', 'campaigns.auto_queue_enabled', 'campaigns.emergency_stop_at'] }),
    n('spam_recycle', 'RETRY', 'Recycle carrier-filtered', { optional: true, summary: 'one retry · different template', evidence: ['feeder:spam_recycle'], action: 'recycleFilteredSends', description: 'A send the carrier filtered as spam returns its target to ready with that template excluded — at most one retry per target.' }),
    n('feed_room', 'DECISION', 'Room to feed?', { summary: 'buffer 150 · daily · total cap', evidence: ['feeder:limit'], action: 'resolveFeedLimit', outputs: ['campaigns.metadata.feeder_last.bound'] }),
    n('capacity_hold', 'WAIT', 'Hold for capacity', { lane: 1, summary: 'next tick · day · window', evidence: ['feeder:bound'], description: 'Buffer full, daily or total cap reached, or window closed: targets stay ready until a later tick, day or window.' }),
    n('queue_plan', 'ACTION', 'Queue plan', { summary: 'eligibility · routing · window', evidence: ['campaign_runs:campaign_feeder'], action: 'createCampaignQueuePlan', outputs: ['send_queue (scheduled)', 'campaign_targets → planned'], link: { app: 'Campaign Command', href: '/campaigns' } }),
    n('dispatch_handoff', 'HANDOFF', 'Queue runner sends', { summary: 'under every brake', handoff: 'queue_dispatch', evidence: ['send_queue:campaign_rows'], owner: 'Queue runner', link: { app: 'Queue', href: '/queue' } }),
    n('cohort_resolved', 'CONDITION', 'Cohort resolved?', { summary: 'nothing sendable left', evidence: ['feeder:cohort_check'], action: 'isCohortResolved' }),
    n('stalled', 'HUMAN_REVIEW', 'Stalled — needs operator', { lane: 1, summary: 'sendable targets, none placed', evidence: ['campaigns.metadata.feeder_last.stalled'], link: { app: 'Campaign Command', href: '/campaigns' } }),
    n('campaign_completed', 'TERMINAL', 'Campaign completed', { terminal: 'success', evidence: ['campaign_status:completed'] }),
  ],
  edges: [
    e('campaign_tick', 'find_due', 'branch'),
    e('find_due', 'schedule_missed', 'branch'),
    e('schedule_missed', 'marked_missed', 'exception', 'MISSED'),
    e('schedule_missed', 'launch_readiness', 'branch', 'CLEAR'),
    e('launch_readiness', 'hydrate_first_chunk', 'branch', 'CLEAR'),
    e('launch_readiness', 'find_due', 'retry', 'RETRY'),
    e('hydrate_first_chunk', 'activate_campaign', 'branch'),
    e('activate_campaign', 'dispatch_handoff', 'handoff', 'ASYNC'),
    e('campaign_tick', 'auto_enqueue_gate'),
    e('auto_enqueue_gate', 'find_feedable', 'primary', 'YES'),
    e('find_feedable', 'spam_recycle'),
    e('spam_recycle', 'feed_room'),
    e('feed_room', 'queue_plan', 'primary', 'YES'),
    e('feed_room', 'capacity_hold', 'exception', 'IF NONE'),
    e('queue_plan', 'dispatch_handoff', 'handoff'),
    e('queue_plan', 'cohort_resolved'),
    e('capacity_hold', 'cohort_resolved', 'exception'),
    e('cohort_resolved', 'campaign_completed', 'primary', 'YES'),
    e('cohort_resolved', 'stalled', 'human', 'IF HELD'),
  ],
})

/* ── CLOSING AUTOMATION ────────────────────────────────────────────────────
 * One run = one closing case, polled every five minutes. Loops are bounded
 * (start · every · max 3) and exhaust into an operator escalation; Closing
 * Authority alone records milestones and only an operator finalizes.
 */
const loop = (every, max = 3) => `every ${every}h · max ${max}`
export const CLOSING_EXECUTION = Object.freeze({
  workflow_key: 'closing_execution',
  topology_version: 'closing-automation-topology-v3',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from closing-automation.js · read-only topology',
  groups: [],
  stages: [
    { key: 'contract', label: 'Contract executed', nodes: ['contract_executed', 'automation_gate'] },
    { key: 'title', label: 'Title', nodes: ['title_open', 'title_ack', 'title_commitment', 'clear_to_close'] },
    { key: 'close', label: 'Close', nodes: ['closing_confirmation', 'settlement', 'operator_finalize'] },
    { key: 'buyer', label: 'Buyer', nodes: ['buyer_emd', 'buyer_agreement'] },
  ],
  nodes: [
    n('contract_executed', 'TRIGGER', 'Seller contract fully executed', { summary: 'DocuSign · Closing Authority', evidence: ['milestone:contract_fully_executed'], owner: 'Closing Authority', action: 'reconcileClosingCaseFromEnvelope → advanceClosingWorkflow' }),
    n('automation_gate', 'CONDITION', 'Automation on · case open?', { summary: 'kill switch · pause · terminal', evidence: ['gate'], action: 'planClosingAutomation (gate)', inputs: ['system_control.closing_automation_enabled', 'closing_cases.automation_paused_at', 'closing_cases.terminal_outcome'] }),
    n('automation_paused', 'TERMINAL', 'Paused — pending requests withdrawn', { lane: 2, terminal: 'human', evidence: ['activity:automation_paused'], link: { app: 'Closing Desk', href: '/closing-desk' } }),
    n('title_open', 'ACTION', 'Open title', { summary: 'Email Command · title order', evidence: ['request:title_open'], action: 'requestClosingEmail(title_open)', outputs: ['closing_email_requests'] }),
    n('title_ack', 'WAIT', 'Chase title acknowledgement', { summary: `after 24h · ${loop(24)}`, evidence: ['request:title_ack', 'activity:title_acknowledged'], action: 'followUpLoop(title_ack)' }),
    n('title_commitment', 'WAIT', 'Chase title commitment', { summary: `due −24h · ${loop(24)}`, evidence: ['request:title_commitment', 'activity:title_commitment_received'], action: 'followUpLoop(title_commitment)', description: 'Starts once title is acknowledged OR the order was sent — it does not wait for acknowledgement.' }),
    n('clear_to_close', 'WAIT', 'Chase clear to close', { summary: `close −72h · ${loop(24)}`, evidence: ['request:clear_to_close', 'activity:clear_to_close'], action: 'followUpLoop(clear_to_close)' }),
    n('closing_confirmation', 'ACTION', 'Confirm closing date', { summary: 'one per confirmed date', evidence: ['request:closing_confirmation'], action: 'requestClosingEmail(closing_confirmation)', description: 'Sent once per confirmed closing date — independent of clear to close.' }),
    n('settlement', 'WAIT', 'Request settlement statement', { summary: `close −36h · ${loop(12)}`, evidence: ['request:settlement', 'activity:settlement_recorded'], action: 'followUpLoop(settlement)' }),
    n('buyer_emd', 'WAIT', 'Buyer earnest money', { lane: 1, summary: `in parallel · ${loop(24)}`, evidence: ['request:buyer_emd', 'activity:emd_received'], action: 'followUpLoop(buyer_emd)' }),
    n('buyer_agreement', 'WAIT', 'Buyer agreement signature', { lane: 1, summary: `sent +24h · ${loop(24)}`, evidence: ['request:buyer_agreement', 'activity:buyer_agreement_status'], action: 'followUpLoop(buyer_agreement)' }),
    n('email_handoff', 'HANDOFF', 'Email Command sends', { lane: 1, summary: 'outbox · revalidated', handoff: 'email_dispatch', evidence: ['request:bridged'], owner: 'Email Command', link: { app: 'Email Command', href: '/email-command' } }),
    n('escalate', 'HUMAN_REVIEW', 'Escalate to operator', { lane: -1, summary: 'exhausted · stale · no recipient', evidence: ['activity:automation_escalated'], action: 'emit closing_party_unreachable', outputs: ['closing_cases.automation_state.escalations', 'notification_events'], link: { app: 'Closing Desk', href: '/closing-desk' } }),
    n('at_risk', 'NOTIFICATION', 'At-risk alert', { lane: -1, summary: '<48h · no clear to close', evidence: ['notify:closing_case_at_risk'] }),
    n('operator_finalize', 'HUMAN_REVIEW', 'Operator finalizes', { summary: 'finalize_closing_case · guarded', evidence: ['activity:closing_finalized'], owner: 'Closing Authority', link: { app: 'Closing Desk', href: '/closing-desk' } }),
    n('closed', 'TERMINAL', 'Closed · won', { terminal: 'success', evidence: ['milestone:closed'] }),
  ],
  edges: [
    e('contract_executed', 'automation_gate'),
    e('automation_gate', 'automation_paused', 'exception', 'PAUSED'),
    e('automation_gate', 'title_open', 'primary', 'CLEAR'),
    e('automation_gate', 'buyer_emd', 'branch'),
    e('title_open', 'title_ack'),
    e('title_open', 'escalate', 'human', 'IF NONE'),
    e('title_open', 'email_handoff', 'handoff', 'ASYNC'),
    e('title_ack', 'title_commitment'),
    e('title_ack', 'escalate', 'human', 'EXHAUSTED'),
    e('title_commitment', 'clear_to_close'),
    e('title_commitment', 'escalate', 'human', 'EXHAUSTED'),
    e('clear_to_close', 'settlement'),
    e('clear_to_close', 'at_risk', 'human', 'IF HELD'),
    e('clear_to_close', 'escalate', 'human', 'EXHAUSTED'),
    e('automation_gate', 'closing_confirmation', 'branch'),
    e('closing_confirmation', 'settlement'),
    e('settlement', 'operator_finalize'),
    e('settlement', 'escalate', 'human', 'EXHAUSTED'),
    e('buyer_emd', 'buyer_agreement'),
    e('buyer_emd', 'escalate', 'human', 'EXHAUSTED'),
    e('buyer_agreement', 'operator_finalize'),
    e('operator_finalize', 'closed'),
  ],
})

/* ── EMAIL DISPATCH ────────────────────────────────────────────────────────
 * The one email sender, every minute. Sending is double-gated
 * (system_control.email_enabled AND env EMAIL_SEND_ENABLED) and is OFF in
 * production: the tick still bridges, reaps and writes its heartbeat. A run is
 * one email_queue row (queue_key).
 */
export const EMAIL_DISPATCH = Object.freeze({
  workflow_key: 'email_dispatch',
  topology_version: 'email-dispatch-topology-v3',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from email-dispatch.js · read-only topology',
  groups: [],
  stages: [
    { key: 'tick', label: 'Every minute', nodes: ['dispatch_tick', 'bridge_closing', 'reap_stuck'] },
    { key: 'gate', label: 'Send gate', nodes: ['send_gate'] },
    { key: 'revalidate', label: 'Revalidate', nodes: ['claim_once', 'revalidate'] },
    { key: 'send', label: 'Send', nodes: ['send_brand', 'email_sent'] },
  ],
  nodes: [
    n('dispatch_tick', 'TRIGGER', 'Email dispatcher tick', { summary: 'Cloudflare · every minute', evidence: ['tick'], owner: 'Cloudflare scheduler', action: 'runEmailDispatch' }),
    n('bridge_closing', 'ACTION', 'Bridge closing requests', { summary: 'pending_transport → outbox', evidence: ['queue:bridged'], action: 'bridgeClosingEmailRequests', outputs: ['email_queue (pending_send)', 'closing_email_requests → claimed'] }),
    n('reap_stuck', 'ACTION', 'Reap stuck sends', { summary: '>15 min · never re-sent', evidence: ['queue:transport_outcome_unknown'], action: 'email_queue_reap_stuck (RPC)', description: 'A send whose outcome is unknown after 15 minutes is failed to an operator — it is never sent twice.' }),
    n('send_gate', 'CONDITION', 'Sending enabled?', { summary: 'email_enabled ∧ EMAIL_SEND_ENABLED', evidence: ['gate'], inputs: ['system_control.email_enabled', 'env EMAIL_SEND_ENABLED'] }),
    n('sending_off', 'TERMINAL', 'Held — sending is off', { lane: 1, terminal: 'neutral', evidence: ['gate:disabled'] }),
    n('claim_once', 'ACTION', 'Claim once', { summary: 'SKIP LOCKED · → sending', evidence: ['queue:sending'], action: 'email_queue_claim (RPC)' }),
    n('revalidate', 'DECISION', 'Still right to send?', { summary: 'reply · takeover · suppression · stale', evidence: ['decision'], action: 'evaluateSendSafety + source revalidator' }),
    n('superseded', 'TERMINAL', 'Superseded / cancelled', { lane: 1, terminal: 'neutral', evidence: ['event:superseded', 'event:cancelled', 'queue:superseded', 'queue:cancelled'] }),
    n('escalate', 'HUMAN_REVIEW', 'Needs operator', { lane: -1, summary: 'identity · changed contact · stale', evidence: ['event:escalated'], link: { app: 'Email Command', href: '/email-command' } }),
    n('defer', 'RETRY', 'Defer 15 min', { lane: 2, summary: 'approval · sender · suppression read', evidence: ['queue:deferred'] }),
    n('send_brand', 'ACTION', 'Send via brand sender', { summary: 'Brevo · threaded', evidence: ['event:sent', 'event:accepted'], action: 'provider send', outputs: ['email_queue → sent', 'email_events'] }),
    n('retry_backoff', 'RETRY', 'Transport retry', { lane: 2, summary: '5m × 2ⁿ · max 3', evidence: ['event:retry_scheduled'] }),
    n('transport_failed', 'TERMINAL', 'Transport failed', { lane: 3, terminal: 'failure', evidence: ['event:failed', 'queue:failed'] }),
    n('email_sent', 'TERMINAL', 'Sent', { terminal: 'success', evidence: ['queue:sent', 'queue:delivered', 'event:delivered'] }),
  ],
  edges: [
    e('dispatch_tick', 'bridge_closing'),
    e('bridge_closing', 'reap_stuck'),
    e('reap_stuck', 'send_gate'),
    e('send_gate', 'sending_off', 'exception', 'IF BLOCKED'),
    e('send_gate', 'claim_once', 'primary', 'CLEAR'),
    e('claim_once', 'revalidate'),
    e('revalidate', 'send_brand', 'primary', 'CLEAR'),
    e('revalidate', 'superseded', 'exception', 'SUPERSEDED'),
    e('revalidate', 'escalate', 'human', 'ESCALATE'),
    e('revalidate', 'defer', 'exception', 'IF DEFERRED'),
    e('defer', 'claim_once', 'retry', 'RETRY'),
    e('send_brand', 'email_sent', 'primary', 'SENT'),
    e('send_brand', 'retry_backoff', 'failure', 'IF FAILED'),
    e('retry_backoff', 'claim_once', 'retry', 'RETRY'),
    e('retry_backoff', 'transport_failed', 'failure', 'EXHAUSTED'),
  ],
})
