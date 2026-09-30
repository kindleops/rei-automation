/**
 * SELLER CONVERSATION · INBOUND — the real order of the seller-flow
 * orchestrator, as recorded by recordSellerInboundExecutionTimeline
 * (seller-automation-execution-service.js:519-740). That recorder writes the
 * ledger AFTER the orchestration, in this fixed order, with synthetic step
 * durations — so node latency is not measured here; the reply's time to
 * delivery (send_queue) is.
 *
 * Semantics the audit pinned down:
 *  - contactability_checked = 'blocked' means the decision carried a block
 *    reason (review-only gating, auto-reply off, low confidence, opt-out,
 *    wrong number…). The reply may STILL have been drafted as a queue row in
 *    the canonical review-hold status (paused_operator_review) for a person to
 *    approve — that is the FOR APPROVAL edge.
 *  - message_queued is written only when a real queue row exists; send truth
 *    is the send_queue row (PRECEDENCE.send_result), reached through the
 *    Queue Dispatch handoff — never the ledger's own "message_sent".
 */
import { edge as e, group as g, node as n } from '../core.js'

const OWNER = 'Seller Automation (seller-flow orchestrator)'
const NOT_TIMED = { latency: false, note: 'Recorded after the run by the timeline recorder — this step is not timed by the runtime.' }

export const SELLER_INBOUND = Object.freeze({
  workflow_key: 'seller_inbound',
  topology_version: 'seller-inbound-topology-v3',
  direction: 'LR',
  badge: 'SYSTEM WORKFLOW · observed from the seller-flow orchestrator · read-only topology',
  groups: [
    g('resolve', 'Resolve seller & property', 'DATA_LOOKUP', 'sequence', 'property · seller · conversation'),
    g('signals', 'Seller signals', 'AI', 'stack', 'ownership · interest · price · condition'),
    g('canonical_state', 'Update canonical state', 'STATE_CHANGE', 'sequence', 'stage · lead state'),
  ],
  stages: [
    { key: 'reply', label: 'Reply', nodes: ['reply_received'] },
    { key: 'understand', label: 'Understand', nodes: ['resolve_property', 'resolve_seller', 'resolve_thread', 'classify_message', 'extract_facts', 'ownership_signal', 'interest_signal', 'price_signal', 'condition_signal'] },
    { key: 'decide', label: 'Decide', nodes: ['seller_decision', 'offer_negotiation', 'reply_warranted', 'render_template'] },
    { key: 'contact', label: 'Contact', nodes: ['contactable_now', 'policy_hold', 'opt_out_dnc'] },
    { key: 'reply_out', label: 'Queue', nodes: ['duplicate_guard', 'queue_reply', 'dispatch_handoff', 'approval_hold'] },
    { key: 'followup', label: 'Follow-up', nodes: ['schedule_follow_up'] },
    { key: 'state', label: 'State', nodes: ['advance_stage', 'lead_state'] },
    { key: 'review', label: 'Review', nodes: ['human_review'] },
    { key: 'notify', label: 'Notify', nodes: ['notify_operator', 'run_recorded'] },
  ],
  nodes: [
    n('reply_received', 'TRIGGER', 'Seller reply received', { summary: 'SMS · email', evidence: ['inbound_message_received'], owner: OWNER, action: 'processSellerInboundMessage', inputs: ['message_events (inbound)', 'thread_key'], description: 'Every inbound seller message (TextGrid webhook, or Email Command for email) starts one run. The inbound is deduplicated by inbound_processing_ledger before the orchestrator sees it.', link: { app: 'Inbox', href: '/inbox' }, measured: NOT_TIMED }),

    n('resolve_property', 'DATA_LOOKUP', 'Resolve property', { group: 'resolve', optional: true, evidence: ['property_resolved'], owner: OWNER, outputs: ['property_id'], measured: NOT_TIMED }),
    n('resolve_seller', 'DATA_LOOKUP', 'Resolve seller', { group: 'resolve', optional: true, evidence: ['participant_resolved'], owner: OWNER, outputs: ['participant_id'], measured: NOT_TIMED }),
    n('resolve_thread', 'DATA_LOOKUP', 'Resolve conversation', { group: 'resolve', evidence: ['phone_thread_resolved'], owner: OWNER, outputs: ['conversation_thread_id'], measured: NOT_TIMED }),

    n('classify_message', 'AI', 'Classify message', { summary: 'intent · sentiment · confidence', evidence: ['message_classified'], owner: OWNER, action: 'inbound intelligence v4', outputs: ['normalized_intent', 'ownership_signal', 'classification_confidence'], description: 'Structured classification of the seller’s words: intent, ownership signal, emotion and confidence. Only the structured output is shown — never a chain of thought.', measured: NOT_TIMED }),
    n('extract_facts', 'AI', 'Extract seller facts', { summary: 'one fact store · SMS + email', evidence: ['facts_extracted'], owner: OWNER, outputs: ['asking_price', 'condition', 'motivation', 'timeline', 'tenant_occupied'], measured: NOT_TIMED }),
    n('ownership_signal', 'AI', 'Ownership signal', { group: 'signals', optional: true, summary: 'confirmed · inferred · denied', evidence: ['ownership_confirmed', 'ownership_inferred', 'ownership_denied'], owner: OWNER, measured: NOT_TIMED }),
    n('interest_signal', 'AI', 'Offer interest', { group: 'signals', optional: true, evidence: ['seller_interest_detected'], owner: OWNER, measured: NOT_TIMED }),
    n('price_signal', 'AI', 'Asking price captured', { group: 'signals', optional: true, evidence: ['asking_price_extracted'], owner: OWNER, measured: NOT_TIMED }),
    n('condition_signal', 'AI', 'Condition captured', { group: 'signals', optional: true, evidence: ['property_condition_extracted'], owner: OWNER, measured: NOT_TIMED }),

    n('seller_decision', 'DECISION', 'Canonical seller decision', { summary: 'stage rules · next best action', evidence: ['decision_intelligence_evaluated'], owner: 'Seller decision authority', action: 'canonical seller decision (stage machine)', outputs: ['stage_before → stage_after', 'operational_status', 'next_action'], measured: NOT_TIMED }),
    n('offer_negotiation', 'SUBWORKFLOW', 'Offer negotiation', { lane: -1, optional: true, summary: 'S3–S6 · inside the authorized ceiling', handoff: 'offer_negotiation', evidence: ['negotiation'], owner: 'Seller negotiation engine', description: 'In the offer stages the negotiation engine recalculates underwriting, selects a strategy and queues an offer only inside the authorized ceiling — or asks for review.', link: { app: 'Deal Intelligence', href: '/deal-intelligence' }, measured: NOT_TIMED }),
    n('reply_warranted', 'DECISION', 'Reply warranted?', { summary: 'template chosen by the decision', evidence: ['automatic_reply_selected', 'reply_decision'], owner: 'Seller decision authority', outputs: ['selected_template'], measured: NOT_TIMED }),
    n('render_template', 'ACTION', 'Render approved template', { optional: true, evidence: ['template_rendered'], owner: OWNER, outputs: ['rendered message'], measured: NOT_TIMED }),

    n('contactable_now', 'CONDITION', 'Contactable now?', { summary: 'policy · suppression · confidence', evidence: ['contactability_checked'], owner: 'Contactability authority', action: 'block reason from the decision / automation policy', inputs: ['auto_reply_mode', 'execution mode', 'suppression', 'classification confidence'], measured: NOT_TIMED }),
    n('policy_hold', 'APPROVAL', 'Held by policy', { lane: 1, optional: true, summary: 'no automatic send', evidence: ['automation_blocked'], owner: OWNER, description: 'The decision carried a block reason — review-only mode, auto-reply off, low confidence, recent outbound, relationship review. Nothing is sent automatically; the reply may be drafted for approval.', link: { app: 'Inbox', href: '/inbox' }, measured: NOT_TIMED }),
    n('opt_out_dnc', 'SUBWORKFLOW', 'Opt-out & DNC', { lane: 2, optional: true, summary: 'suppression applied', handoff: 'dnc_opt_out', evidence: ['opt_out'], owner: 'Compliance (suppression)', outputs: ['sms_suppression_list', 'contactability → uncontactable'], measured: NOT_TIMED }),

    n('duplicate_guard', 'CONDITION', 'Duplicate-send guard', { optional: true, evidence: ['duplicate_send_check'], owner: 'Canonical queue writer', measured: NOT_TIMED }),
    n('queue_reply', 'ACTION', 'Queue reply', { optional: true, summary: 'canonical queue writer', evidence: ['message_queued'], owner: 'Canonical queue writer', outputs: ['send_queue row'], link: { app: 'Queue', href: '/queue' }, measured: NOT_TIMED }),
    n('enqueue_failed', 'TERMINAL', 'Enqueue failed', { lane: 3, terminal: 'failure', evidence: ['message_failed'] }),
    n('dispatch_handoff', 'HANDOFF', 'Queue dispatch', { lane: 1, optional: true, summary: 'queue runner · every brake', handoff: 'queue_dispatch', evidence: ['send_queue:outcome'], owner: 'Queue runner', description: 'The queue runner is the only sender. The send result shown here is the queue row’s own status — delivered, failed, held by sender health, withdrawn — never the seller ledger’s label.', link: { app: 'Queue', href: '/queue' }, measured: { latency: true, note: 'Measured: reply queued → delivered (send_queue.created_at → delivered_at).' } }),
    n('approval_hold', 'APPROVAL', 'Reply awaiting approval', { lane: -1, optional: true, summary: 'review hold · operator releases', evidence: ['send_queue:review_hold'], owner: 'Queue authority (review hold)', link: { app: 'Inbox', href: '/inbox' } }),
    n('reply_delivered', 'TERMINAL', 'Reply delivered', { lane: 1, terminal: 'success', evidence: ['send_queue:delivered'] }),
    n('reply_failed', 'TERMINAL', 'Reply failed', { lane: 2, terminal: 'failure', evidence: ['send_queue:failed'] }),

    n('schedule_follow_up', 'WAIT', 'Schedule follow-up', { optional: true, summary: 'cancelled on any reply', evidence: ['follow_up_scheduled'], owner: 'Follow-up scheduler', outputs: ['follow_up_at'], measured: NOT_TIMED }),
    n('advance_stage', 'STATE_CHANGE', 'Advance seller stage', { group: 'canonical_state', optional: true, summary: 'lifecycle authority', evidence: ['stage_advanced'], owner: 'Lifecycle authority', outputs: ['lifecycle_stage'], measured: NOT_TIMED }),
    n('lead_state', 'STATE_CHANGE', 'Update lead state', { group: 'canonical_state', summary: 'status · temperature · disposition · contactability', evidence: ['operational_status_changed', 'temperature_changed', 'disposition_changed', 'contactability_changed'], owner: 'Universal lead-state authority', outputs: ['inbox_thread_state'], measured: NOT_TIMED }),
    n('human_review', 'HUMAN_REVIEW', 'Needs human review', { lane: -1, optional: true, summary: 'open in the Inbox review bucket', evidence: ['needs_review_created'], owner: 'Inbox (needs review)', link: { app: 'Inbox', href: '/inbox' }, measured: NOT_TIMED }),
    n('notify_operator', 'NOTIFICATION', 'Notify operator', { summary: 'notification centre', evidence: ['notification_emitted'], owner: 'Notifications', handoff: null, measured: NOT_TIMED }),
    n('run_recorded', 'TERMINAL', 'Run complete', { terminal: 'success', evidence: ['run_completed'] }),
  ],
  edges: [
    e('reply_received', 'resolve_property'),
    e('resolve_property', 'resolve_seller'),
    e('resolve_seller', 'resolve_thread'),
    e('resolve_thread', 'classify_message'),
    e('classify_message', 'extract_facts'),
    e('extract_facts', 'ownership_signal', 'branch'),
    e('extract_facts', 'interest_signal', 'branch'),
    e('extract_facts', 'price_signal', 'branch'),
    e('extract_facts', 'condition_signal', 'branch'),
    e('extract_facts', 'seller_decision'),
    e('ownership_signal', 'seller_decision', 'branch'),
    e('interest_signal', 'seller_decision', 'branch'),
    e('price_signal', 'seller_decision', 'branch'),
    e('condition_signal', 'seller_decision', 'branch'),
    e('seller_decision', 'offer_negotiation', 'branch'),
    e('offer_negotiation', 'reply_warranted', 'branch'),
    e('seller_decision', 'reply_warranted'),
    e('reply_warranted', 'render_template', 'primary', 'YES'),
    e('reply_warranted', 'contactable_now', 'branch', 'NO'),
    e('render_template', 'contactable_now'),
    e('contactable_now', 'duplicate_guard', 'primary', 'CLEAR'),
    e('contactable_now', 'schedule_follow_up', 'branch'),
    e('contactable_now', 'policy_hold', 'exception', 'IF HELD'),
    e('policy_hold', 'duplicate_guard', 'human', 'FOR APPROVAL'),
    e('policy_hold', 'opt_out_dnc', 'exception', 'IF OPTED OUT'),
    e('policy_hold', 'schedule_follow_up', 'exception'),
    e('duplicate_guard', 'queue_reply'),
    e('queue_reply', 'enqueue_failed', 'failure', 'IF FAILED'),
    e('queue_reply', 'dispatch_handoff', 'handoff', 'ASYNC'),
    e('dispatch_handoff', 'reply_delivered', 'primary', 'DELIVERED'),
    e('dispatch_handoff', 'reply_failed', 'failure', 'IF FAILED'),
    e('dispatch_handoff', 'approval_hold', 'human', 'FOR APPROVAL'),
    e('approval_hold', 'reply_delivered', 'human', 'APPROVED'),
    e('queue_reply', 'schedule_follow_up'),
    e('opt_out_dnc', 'lead_state', 'exception'),
    e('schedule_follow_up', 'advance_stage'),
    e('schedule_follow_up', 'lead_state', 'branch'),
    e('advance_stage', 'lead_state'),
    e('lead_state', 'human_review', 'human', 'IF REVIEW'),
    e('lead_state', 'notify_operator'),
    e('human_review', 'notify_operator', 'human'),
    e('notify_operator', 'run_recorded'),
  ],
})

/* ── OPT-OUT & DNC (subworkflow of seller inbound) ─────────────────────────
 * One run = the seller run in which the seller opted out. Suppression is the
 * compliance runtime's (sms_suppression_list), the event is the canonical bus'
 * (SUPPRESSION_APPLIED), and the queue runner re-checks it before every send.
 */
export const DNC_OPT_OUT = Object.freeze({
  workflow_key: 'dnc_opt_out',
  topology_version: 'dnc-opt-out-topology-v1',
  direction: 'LR',
  badge: 'SUBWORKFLOW · observed from the seller-flow opt-out branch · read-only topology',
  groups: [],
  stages: [
    { key: 'optout', label: 'Seller opts out', nodes: ['opt_out_received', 'replies_blocked'] },
    { key: 'suppress', label: 'Suppress', nodes: ['apply_suppression', 'suppression_event'] },
    { key: 'state', label: 'Uncontactable', nodes: ['mark_uncontactable', 'notify_opt_out'] },
    { key: 'enforce', label: 'Every send re-checks', nodes: ['send_recheck', 'suppressed'] },
  ],
  nodes: [
    n('opt_out_received', 'TRIGGER', 'Seller opts out', { summary: 'STOP · opt-out intent', evidence: ['opt_out:inbound'], owner: OWNER, action: 'inbound classification → opt_out', link: { app: 'Inbox', href: '/inbox' } }),
    n('replies_blocked', 'CONDITION', 'Every automatic reply blocked', { summary: 'block reason opt_out', evidence: ['opt_out:blocked'], owner: OWNER }),
    n('apply_suppression', 'ACTION', 'Suppress the number', { summary: 'sms_suppression_list', evidence: ['opt_out:suppression_row'], owner: 'Compliance (suppression)', outputs: ['sms_suppression_list'] }),
    n('suppression_event', 'NOTIFICATION', 'Suppression on the bus', { optional: true, summary: 'SUPPRESSION_APPLIED', evidence: ['opt_out:event'], outputs: ['automation_events'] }),
    n('mark_uncontactable', 'STATE_CHANGE', 'Mark uncontactable', { optional: true, summary: 'contactability · lead state', evidence: ['opt_out:contactability'], owner: 'Universal lead-state authority' }),
    n('notify_opt_out', 'NOTIFICATION', 'Opt-out notification', { optional: true, evidence: ['opt_out:notification'] }),
    n('send_recheck', 'HANDOFF', 'Re-checked before every send', { summary: 'queue compliance gate', handoff: 'queue_dispatch', evidence: ['opt_out:enforced'], owner: 'Queue runner (compliance)' }),
    n('suppressed', 'TERMINAL', 'Suppressed', { terminal: 'success', evidence: ['opt_out:done'] }),
  ],
  edges: [
    e('opt_out_received', 'replies_blocked'),
    e('replies_blocked', 'apply_suppression'),
    e('apply_suppression', 'suppression_event'),
    e('suppression_event', 'mark_uncontactable'),
    e('apply_suppression', 'mark_uncontactable', 'branch'),
    e('mark_uncontactable', 'notify_opt_out'),
    e('notify_opt_out', 'send_recheck'),
    e('mark_uncontactable', 'send_recheck', 'branch'),
    e('send_recheck', 'suppressed'),
  ],
})

/* ── OFFER NEGOTIATION S3–S6 (subworkflow of seller inbound) ───────────────
 * One run = one seller turn in which the negotiation engine acted (its events
 * for one conversation, emitted by one orchestrator invocation).
 */
export const OFFER_NEGOTIATION = Object.freeze({
  workflow_key: 'offer_negotiation',
  topology_version: 'offer-negotiation-topology-v1',
  direction: 'LR',
  badge: 'SUBWORKFLOW · observed from the seller negotiation engine · read-only topology',
  groups: [],
  stages: [
    { key: 'turn', label: 'Seller turn', nodes: ['negotiation_turn', 'price_signal'] },
    { key: 'underwrite', label: 'Underwrite', nodes: ['underwrite', 'comp_anchor'] },
    { key: 'strategy', label: 'Strategy', nodes: ['select_strategy', 'within_authority'] },
    { key: 'offer', label: 'Offer', nodes: ['queue_offer', 'terms_accepted', 'contract_info'] },
  ],
  nodes: [
    n('negotiation_turn', 'TRIGGER', 'Seller turn in an offer stage', { summary: 'S3–S6', evidence: ['negotiation:turn'], owner: 'Seller negotiation engine' }),
    n('price_signal', 'AI', 'Price · change · concession', { optional: true, evidence: ['asking_price_captured', 'asking_price_changed', 'seller_concession_detected'] }),
    n('underwrite', 'ACTION', 'Recalculate underwriting', { optional: true, evidence: ['underwriting_recalculated', 'underwriting_completed'], link: { app: 'Deal Intelligence', href: '/deal-intelligence' } }),
    n('comp_anchor', 'DATA_LOOKUP', 'Anchor on comps', { optional: true, evidence: ['comp_anchor_selected'] }),
    n('select_strategy', 'DECISION', 'Select strategy', { optional: true, evidence: ['strategy_selected', 'alternate_strategy_selected'] }),
    n('within_authority', 'CONDITION', 'Inside the authorized ceiling?', { optional: true, summary: 'monetary authority', evidence: ['offer_authorized'] }),
    n('review_required', 'HUMAN_REVIEW', 'Review required', { lane: -1, optional: true, evidence: ['review_required'], link: { app: 'Deal Intelligence', href: '/deal-intelligence' } }),
    n('queue_offer', 'ACTION', 'Queue the offer', { optional: true, evidence: ['offer_queued'], handoff: 'queue_dispatch' }),
    n('terms_accepted', 'DECISION', 'Terms accepted', { optional: true, evidence: ['terms_accepted'] }),
    n('contract_info', 'ACTION', 'Request contract information', { optional: true, evidence: ['contract_information_requested'] }),
    n('turn_done', 'TERMINAL', 'Turn complete', { terminal: 'success', evidence: ['negotiation:done'] }),
  ],
  edges: [
    e('negotiation_turn', 'price_signal'),
    e('price_signal', 'underwrite'),
    e('negotiation_turn', 'underwrite', 'branch'),
    e('underwrite', 'comp_anchor'),
    e('comp_anchor', 'select_strategy'),
    e('underwrite', 'select_strategy', 'branch'),
    e('select_strategy', 'within_authority'),
    e('within_authority', 'queue_offer', 'primary', 'YES'),
    e('within_authority', 'review_required', 'human', 'IF REVIEW'),
    e('underwrite', 'review_required', 'human', 'IF REVIEW'),
    e('queue_offer', 'terms_accepted'),
    e('terms_accepted', 'contract_info'),
    e('contract_info', 'turn_done'),
    e('queue_offer', 'turn_done', 'branch'),
    e('review_required', 'turn_done', 'human'),
    e('negotiation_turn', 'review_required', 'human', 'IF REVIEW', 'negotiation_turn__review_required'),
  ],
})
