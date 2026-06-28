/**
 * Canonical seller-flow automation action registry.
 * Workflow Studio generates nodes exclusively from this registry.
 * Backend seller-flow remains execution source of truth.
 */

export const SELLER_AUTOMATION_WORKFLOW_ID = 'seller-inbound-v1';

export const SELLER_EXECUTION_STATUSES = Object.freeze([
  'waiting',
  'running',
  'succeeded',
  'blocked',
  'needs_review',
  'failed',
  'retrying',
  'skipped',
]);

function node(def) {
  return Object.freeze({
    enabled: true,
    lifecycle_stage: null,
    trigger: null,
    required_inputs: [],
    produced_outputs: [],
    eligibility_rules: [],
    contactability_requirements: null,
    template_key: null,
    retry_behavior: { max_retries: 0, backoff_ms: 0 },
    timeout_behavior: { timeout_ms: 30_000 },
    next_possible_actions: [],
    frontend: { icon: 'workflow', color: '#6366f1', category: 'seller_flow' },
    backend_handler: null,
    ...def,
  });
}

/** @type {ReadonlyArray<ReturnType<typeof node>>} */
export const SELLER_AUTOMATION_ACTION_REGISTRY = Object.freeze([
  node({
    action_key: 'inbound_message_received',
    node_type: 'trigger.inbound_message_received',
    display_name: 'Inbound Message Received',
    description: 'Inbound SMS webhook accepted and normalized.',
    trigger: 'textgrid.inbound_webhook',
    backend_handler: 'seller-flow/process-seller-inbound-message',
    frontend: { icon: 'inbox', color: '#0ea5e9', category: 'triggers' },
    next_possible_actions: ['property_resolved', 'message_classified'],
  }),
  node({
    action_key: 'property_resolved',
    node_type: 'action.property_resolved',
    display_name: 'Property Resolved',
    description: 'Property anchor resolved from thread context.',
    required_inputs: ['thread_key'],
    produced_outputs: ['property_id'],
    backend_handler: 'seller-flow/persist-inbound-intelligence',
    frontend: { icon: 'home', color: '#14b8a6', category: 'resolution' },
    next_possible_actions: ['participant_resolved'],
  }),
  node({
    action_key: 'participant_resolved',
    node_type: 'action.participant_resolved',
    display_name: 'Participant Resolved',
    description: 'Seller participant / prospect identity resolved.',
    required_inputs: ['property_id', 'thread_key'],
    produced_outputs: ['participant_id', 'prospect_id', 'master_owner_id'],
    backend_handler: 'seller-flow/persist-inbound-intelligence',
    frontend: { icon: 'user', color: '#14b8a6', category: 'resolution' },
    next_possible_actions: ['phone_thread_resolved'],
  }),
  node({
    action_key: 'phone_thread_resolved',
    node_type: 'action.phone_thread_resolved',
    display_name: 'Phone Thread Resolved',
    description: 'Canonical conversation thread key established.',
    required_inputs: ['phone_e164'],
    produced_outputs: ['conversation_thread_id'],
    backend_handler: 'seller-flow/process-seller-inbound-message',
    frontend: { icon: 'phone', color: '#14b8a6', category: 'resolution' },
    next_possible_actions: ['message_classified'],
  }),
  node({
    action_key: 'message_classified',
    node_type: 'action.message_classified',
    display_name: 'Message Classified',
    description: 'Inbound message classified by seller conversation engine.',
    required_inputs: ['message_body', 'thread_key'],
    produced_outputs: ['classification', 'normalized_intent'],
    backend_handler: 'classification/classify',
    frontend: { icon: 'brain', color: '#8b5cf6', category: 'intelligence' },
    next_possible_actions: ['facts_extracted', 'ownership_confirmed', 'ownership_inferred', 'ownership_denied'],
  }),
  node({
    action_key: 'facts_extracted',
    node_type: 'action.facts_extracted',
    display_name: 'Facts Extracted',
    description: 'Structured facts extracted from seller reply.',
    produced_outputs: ['extracted_facts'],
    backend_handler: 'seller-flow/normalize-classification-contract',
    frontend: { icon: 'list', color: '#8b5cf6', category: 'intelligence' },
    next_possible_actions: ['seller_interest_detected', 'asking_price_extracted', 'property_condition_extracted'],
  }),
  node({
    action_key: 'ownership_confirmed',
    node_type: 'action.ownership_confirmed',
    display_name: 'Ownership Confirmed',
    description: 'Seller explicitly confirmed property ownership.',
    lifecycle_stage: 'ownership_confirmation',
    produced_outputs: ['ownership_signal'],
    backend_handler: 'seller-flow/seller-flow-decision-contract',
    frontend: { icon: 'check-circle', color: '#22c55e', category: 'ownership' },
    next_possible_actions: ['stage_advanced', 'automatic_reply_selected'],
  }),
  node({
    action_key: 'ownership_inferred',
    node_type: 'action.ownership_inferred',
    display_name: 'Ownership Inferred',
    description: 'Ownership inferred from negative / not-for-sale signals.',
    lifecycle_stage: 'ownership_confirmation',
    backend_handler: 'seller-flow/seller-flow-decision-contract',
    frontend: { icon: 'help-circle', color: '#f59e0b', category: 'ownership' },
    next_possible_actions: ['follow_up_scheduled', 'stage_advanced'],
  }),
  node({
    action_key: 'ownership_denied',
    node_type: 'action.ownership_denied',
    display_name: 'Ownership Denied',
    description: 'Seller denied ownership or wrong-party signal.',
    backend_handler: 'seller-flow/seller-flow-decision-contract',
    frontend: { icon: 'x-circle', color: '#ef4444', category: 'ownership' },
    next_possible_actions: ['automation_blocked', 'needs_review_created'],
  }),
  node({
    action_key: 'seller_interest_detected',
    node_type: 'action.seller_interest_detected',
    display_name: 'Seller Interest Detected',
    description: 'Positive selling interest detected.',
    lifecycle_stage: 'offer_interest',
    backend_handler: 'seller-flow/stage2-offer-interest-engine',
    frontend: { icon: 'trending-up', color: '#22c55e', category: 'interest' },
    next_possible_actions: ['stage_advanced', 'offer_calculated'],
  }),
  node({
    action_key: 'asking_price_extracted',
    node_type: 'action.asking_price_extracted',
    display_name: 'Asking Price Extracted',
    description: 'Seller asking price captured from reply.',
    lifecycle_stage: 'asking_price',
    produced_outputs: ['asking_price'],
    backend_handler: 'seller-flow/stage3-asking-price-engine',
    frontend: { icon: 'dollar-sign', color: '#22c55e', category: 'pricing' },
    next_possible_actions: ['offer_calculated', 'decision_intelligence_evaluated'],
  }),
  node({
    action_key: 'property_condition_extracted',
    node_type: 'action.property_condition_extracted',
    display_name: 'Property Condition Extracted',
    description: 'Condition / repair facts captured.',
    lifecycle_stage: 'property_condition',
    backend_handler: 'seller-flow/stage4-condition-engine',
    frontend: { icon: 'tool', color: '#f59e0b', category: 'condition' },
    next_possible_actions: ['decision_intelligence_evaluated'],
  }),
  node({
    action_key: 'motivation_extracted',
    node_type: 'action.motivation_extracted',
    display_name: 'Motivation Extracted',
    description: 'Seller motivation signal extracted.',
    backend_handler: 'seller-flow/normalize-classification-contract',
    frontend: { icon: 'zap', color: '#8b5cf6', category: 'intelligence' },
    next_possible_actions: ['decision_intelligence_evaluated'],
  }),
  node({
    action_key: 'timeline_extracted',
    node_type: 'action.timeline_extracted',
    display_name: 'Timeline Extracted',
    description: 'Seller timeline / urgency extracted.',
    backend_handler: 'seller-flow/normalize-classification-contract',
    frontend: { icon: 'clock', color: '#8b5cf6', category: 'intelligence' },
    next_possible_actions: ['follow_up_scheduled'],
  }),
  node({
    action_key: 'decision_intelligence_evaluated',
    node_type: 'action.decision_intelligence_evaluated',
    display_name: 'Decision Intelligence Evaluated',
    description: 'Inbound intelligence phase produced canonical decision.',
    produced_outputs: ['canonical_decision', 'intelligence_snapshot'],
    backend_handler: 'seller-flow/run-inbound-intelligence-phase',
    frontend: { icon: 'cpu', color: '#6366f1', category: 'intelligence' },
    next_possible_actions: ['automatic_reply_selected', 'needs_review_created', 'automation_blocked'],
  }),
  node({
    action_key: 'offer_calculated',
    node_type: 'action.offer_calculated',
    display_name: 'Offer Calculated',
    description: 'Underwriting / offer calculation completed.',
    lifecycle_stage: 'offer',
    backend_handler: 'seller-flow/stage5-offer-engine',
    frontend: { icon: 'calculator', color: '#6366f1', category: 'offer' },
    next_possible_actions: ['offer_message_generated'],
  }),
  node({
    action_key: 'offer_message_generated',
    node_type: 'action.offer_message_generated',
    display_name: 'Offer Message Generated',
    description: 'Offer narrative message composed.',
    backend_handler: 'seller-flow/stage5-offer-engine',
    frontend: { icon: 'file-text', color: '#6366f1', category: 'offer' },
    next_possible_actions: ['template_rendered'],
  }),
  node({
    action_key: 'automatic_reply_selected',
    node_type: 'action.automatic_reply_selected',
    display_name: 'Automatic Reply Selected',
    description: 'Auto-reply plan / route profile selected.',
    produced_outputs: ['route_profile', 'use_case'],
    backend_handler: 'seller-flow/resolve-seller-auto-reply-plan',
    frontend: { icon: 'message-square', color: '#0ea5e9', category: 'outbound' },
    next_possible_actions: ['template_rendered', 'contactability_checked'],
  }),
  node({
    action_key: 'template_rendered',
    node_type: 'action.template_rendered',
    display_name: 'Template Rendered',
    description: 'Selected template rendered with context.',
    template_key: 'dynamic',
    produced_outputs: ['rendered_message'],
    backend_handler: 'seller-flow/apply-inbound-automation-decision',
    frontend: { icon: 'layout', color: '#0ea5e9', category: 'outbound' },
    next_possible_actions: ['duplicate_send_check', 'message_queued'],
  }),
  node({
    action_key: 'contactability_checked',
    node_type: 'guard.contactability_checked',
    display_name: 'Contactability Checked',
    description: 'Opt-out, wrong-number, and suppression gates evaluated.',
    contactability_requirements: 'contactable',
    backend_handler: 'seller-flow/apply-inbound-automation-decision',
    frontend: { icon: 'shield', color: '#f59e0b', category: 'guards' },
    next_possible_actions: ['message_queued', 'automation_blocked'],
  }),
  node({
    action_key: 'duplicate_send_check',
    node_type: 'guard.duplicate_send_check',
    display_name: 'Duplicate Send Check',
    description: 'Duplicate outbound prevention evaluated.',
    backend_handler: 'seller-flow/apply-inbound-automation-decision',
    frontend: { icon: 'copy', color: '#f59e0b', category: 'guards' },
    next_possible_actions: ['message_queued', 'skipped'],
  }),
  node({
    action_key: 'message_queued',
    node_type: 'action.message_queued',
    display_name: 'Message Queued',
    description: 'Outbound message inserted into send queue.',
    produced_outputs: ['queue_row_id'],
    backend_handler: 'seller-flow/apply-inbound-automation-decision',
    frontend: { icon: 'layers', color: '#0ea5e9', category: 'outbound' },
    next_possible_actions: ['message_claimed'],
  }),
  node({
    action_key: 'message_claimed',
    node_type: 'action.message_claimed',
    display_name: 'Message Claimed',
    description: 'Queue worker claimed outbound message.',
    backend_handler: 'queue/send-queue-worker',
    frontend: { icon: 'download', color: '#0ea5e9', category: 'outbound' },
    next_possible_actions: ['message_sent'],
  }),
  node({
    action_key: 'message_sent',
    node_type: 'action.message_sent',
    display_name: 'Message Sent',
    description: 'Provider accepted outbound send.',
    backend_handler: 'queue/send-queue-worker',
    frontend: { icon: 'send', color: '#22c55e', category: 'outbound' },
    next_possible_actions: ['message_delivered', 'message_failed'],
  }),
  node({
    action_key: 'message_delivered',
    node_type: 'action.message_delivered',
    display_name: 'Message Delivered',
    description: 'Delivery confirmation received from provider.',
    backend_handler: 'queue/delivery-status',
    frontend: { icon: 'check', color: '#22c55e', category: 'outbound' },
    next_possible_actions: ['notification_emitted'],
  }),
  node({
    action_key: 'message_failed',
    node_type: 'action.message_failed',
    display_name: 'Message Failed',
    description: 'Outbound send or delivery failed.',
    retry_behavior: { max_retries: 3, backoff_ms: 60_000 },
    backend_handler: 'queue/send-queue-worker',
    frontend: { icon: 'alert-triangle', color: '#ef4444', category: 'outbound' },
    next_possible_actions: ['retry_executed', 'needs_review_created'],
  }),
  node({
    action_key: 'follow_up_scheduled',
    node_type: 'action.follow_up_scheduled',
    display_name: 'Follow-Up Scheduled',
    description: 'Seller follow-up scheduled.',
    produced_outputs: ['follow_up_at'],
    backend_handler: 'seller-flow/seller-followup-scheduler',
    frontend: { icon: 'calendar', color: '#6366f1', category: 'timing' },
    next_possible_actions: ['follow_up_became_due'],
  }),
  node({
    action_key: 'follow_up_became_due',
    node_type: 'trigger.follow_up_due',
    display_name: 'Follow-Up Became Due',
    description: 'Scheduled follow-up reached execution window.',
    trigger: 'cron.follow_up_due',
    backend_handler: 'seller-flow/seller-followup-scheduler',
    frontend: { icon: 'bell', color: '#6366f1', category: 'timing' },
    next_possible_actions: ['follow_up_executed'],
  }),
  node({
    action_key: 'follow_up_executed',
    node_type: 'action.follow_up_executed',
    display_name: 'Follow-Up Executed',
    description: 'Due follow-up executed by scheduler.',
    backend_handler: 'seller-flow/seller-followup-scheduler',
    frontend: { icon: 'play', color: '#6366f1', category: 'timing' },
    next_possible_actions: ['message_queued'],
  }),
  node({
    action_key: 'stage_advanced',
    node_type: 'action.stage_advanced',
    display_name: 'Stage Advanced',
    description: 'Universal lifecycle stage updated.',
    produced_outputs: ['stage_before', 'stage_after'],
    backend_handler: 'lead-state/patch-universal-lead-state',
    frontend: { icon: 'arrow-right', color: '#22c55e', category: 'state' },
    next_possible_actions: ['operational_status_changed'],
  }),
  node({
    action_key: 'operational_status_changed',
    node_type: 'action.operational_status_changed',
    display_name: 'Operational Status Changed',
    description: 'Operational status patched on lead state.',
    backend_handler: 'lead-state/patch-universal-lead-state',
    frontend: { icon: 'activity', color: '#6366f1', category: 'state' },
    next_possible_actions: ['notification_emitted'],
  }),
  node({
    action_key: 'temperature_changed',
    node_type: 'action.temperature_changed',
    display_name: 'Temperature Changed',
    description: 'Lead temperature updated.',
    backend_handler: 'automation/automation-actions',
    frontend: { icon: 'thermometer', color: '#f59e0b', category: 'state' },
    next_possible_actions: [],
  }),
  node({
    action_key: 'disposition_changed',
    node_type: 'action.disposition_changed',
    display_name: 'Disposition Changed',
    description: 'Seller disposition updated.',
    backend_handler: 'automation/automation-actions',
    frontend: { icon: 'tag', color: '#6366f1', category: 'state' },
    next_possible_actions: [],
  }),
  node({
    action_key: 'contactability_changed',
    node_type: 'action.contactability_changed',
    display_name: 'Contactability Changed',
    description: 'Contactability status updated after suppression/opt-out.',
    backend_handler: 'automation/automation-actions',
    frontend: { icon: 'shield-off', color: '#ef4444', category: 'state' },
    next_possible_actions: ['automation_blocked'],
  }),
  node({
    action_key: 'next_best_contact_selected',
    node_type: 'action.next_best_contact_selected',
    display_name: 'Next Best Contact Selected',
    description: 'Next-best participant / phone selected for outreach.',
    backend_handler: 'seller-flow/apply-inbound-automation-decision',
    frontend: { icon: 'users', color: '#14b8a6', category: 'routing' },
    next_possible_actions: ['message_queued'],
  }),
  node({
    action_key: 'conversation_archived',
    node_type: 'action.conversation_archived',
    display_name: 'Conversation Archived',
    description: 'Thread archived in inbox state.',
    backend_handler: 'cockpit/inbox/thread-state',
    frontend: { icon: 'archive', color: '#64748b', category: 'inbox' },
    next_possible_actions: [],
  }),
  node({
    action_key: 'conversation_unarchived',
    node_type: 'action.conversation_unarchived',
    display_name: 'Conversation Unarchived',
    description: 'Thread restored from archive.',
    backend_handler: 'cockpit/inbox/thread-state',
    frontend: { icon: 'archive-restore', color: '#64748b', category: 'inbox' },
    next_possible_actions: [],
  }),
  node({
    action_key: 'lead_paused',
    node_type: 'action.lead_paused',
    display_name: 'Lead Paused',
    description: 'Automation paused for lead / thread.',
    backend_handler: 'seller-automation/manual-control',
    frontend: { icon: 'pause', color: '#f59e0b', category: 'controls' },
    next_possible_actions: ['lead_resumed'],
  }),
  node({
    action_key: 'lead_resumed',
    node_type: 'action.lead_resumed',
    display_name: 'Lead Resumed',
    description: 'Automation resumed for lead / thread.',
    backend_handler: 'seller-automation/manual-control',
    frontend: { icon: 'play', color: '#22c55e', category: 'controls' },
    next_possible_actions: [],
  }),
  node({
    action_key: 'contract_generated',
    node_type: 'action.contract_generated',
    display_name: 'Contract Generated',
    description: 'Seller contract document generated.',
    lifecycle_stage: 'formal_contract',
    backend_handler: 'seller-flow/stage6-seller-contract-engine',
    frontend: { icon: 'file', color: '#6366f1', category: 'contract' },
    next_possible_actions: ['contract_sent'],
  }),
  node({
    action_key: 'contract_sent',
    node_type: 'action.contract_sent',
    display_name: 'Contract Sent',
    description: 'Contract sent to seller.',
    backend_handler: 'seller-flow/stage6-seller-contract-engine',
    frontend: { icon: 'send', color: '#6366f1', category: 'contract' },
    next_possible_actions: ['contract_viewed'],
  }),
  node({
    action_key: 'contract_viewed',
    node_type: 'action.contract_viewed',
    display_name: 'Contract Viewed',
    description: 'Seller opened contract.',
    backend_handler: 'seller-flow/stage6-seller-contract-engine',
    frontend: { icon: 'eye', color: '#6366f1', category: 'contract' },
    next_possible_actions: ['contract_signed'],
  }),
  node({
    action_key: 'contract_signed',
    node_type: 'action.contract_signed',
    display_name: 'Contract Signed',
    description: 'Contract fully signed.',
    backend_handler: 'seller-flow/stage6-seller-contract-engine',
    frontend: { icon: 'pen-tool', color: '#22c55e', category: 'contract' },
    next_possible_actions: ['under_contract_handoff'],
  }),
  node({
    action_key: 'under_contract_handoff',
    node_type: 'action.under_contract_handoff',
    display_name: 'Under-Contract Handoff',
    description: 'Deal handed to closing / disposition workflow.',
    backend_handler: 'pipeline/opportunity-workflow-bridge',
    frontend: { icon: 'git-branch', color: '#22c55e', category: 'contract' },
    next_possible_actions: ['prepared_to_close'],
  }),
  node({
    action_key: 'disposition_started',
    node_type: 'action.disposition_started',
    display_name: 'Disposition Started',
    description: 'Disposition workflow started.',
    backend_handler: 'pipeline/opportunity-workflow-bridge',
    frontend: { icon: 'flag', color: '#6366f1', category: 'closing' },
    next_possible_actions: ['prepared_to_close'],
  }),
  node({
    action_key: 'prepared_to_close',
    node_type: 'action.prepared_to_close',
    display_name: 'Prepared To Close',
    description: 'Deal prepared for closing desk.',
    backend_handler: 'closing-desk',
    frontend: { icon: 'clipboard-check', color: '#22c55e', category: 'closing' },
    next_possible_actions: ['deal_closed'],
  }),
  node({
    action_key: 'deal_closed',
    node_type: 'action.deal_closed',
    display_name: 'Deal Closed',
    description: 'Deal marked closed.',
    backend_handler: 'closing-desk',
    frontend: { icon: 'award', color: '#22c55e', category: 'closing' },
    next_possible_actions: [],
  }),
  node({
    action_key: 'needs_review_created',
    node_type: 'action.needs_review_created',
    display_name: 'Needs Review Created',
    description: 'Human review required before execution.',
    backend_handler: 'seller-flow/seller-flow-decision-contract',
    frontend: { icon: 'eye', color: '#f59e0b', category: 'review' },
    next_possible_actions: ['message_queued', 'automation_blocked'],
  }),
  node({
    action_key: 'automation_blocked',
    node_type: 'guard.automation_blocked',
    display_name: 'Automation Blocked',
    description: 'Automation blocked by suppression, opt-out, or policy.',
    backend_handler: 'automation/automation-actions',
    frontend: { icon: 'ban', color: '#ef4444', category: 'guards' },
    next_possible_actions: ['contactability_changed'],
  }),
  node({
    action_key: 'retry_executed',
    node_type: 'action.retry_executed',
    display_name: 'Retry Executed',
    description: 'Failed action retried by worker or operator.',
    retry_behavior: { max_retries: 3, backoff_ms: 60_000 },
    backend_handler: 'seller-flow/recover-unprocessed-inbound-messages',
    frontend: { icon: 'refresh-cw', color: '#f59e0b', category: 'recovery' },
    next_possible_actions: ['message_sent', 'message_failed'],
  }),
  node({
    action_key: 'recovery_worker_repaired',
    node_type: 'action.recovery_worker_repaired',
    display_name: 'Recovery Worker Repaired Message',
    description: 'Inbound recovery worker reprocessed stuck message.',
    backend_handler: 'seller-flow/recover-unprocessed-inbound-messages',
    frontend: { icon: 'wrench', color: '#f59e0b', category: 'recovery' },
    next_possible_actions: ['inbound_message_received'],
  }),
  node({
    action_key: 'notification_emitted',
    node_type: 'action.notification_emitted',
    display_name: 'Notification Emitted',
    description: 'Operator notification emitted for business event.',
    backend_handler: 'notifications/notification-emitter',
    frontend: { icon: 'bell', color: '#0ea5e9', category: 'notifications' },
    next_possible_actions: [],
  }),
]);

const REGISTRY_BY_KEY = new Map(
  SELLER_AUTOMATION_ACTION_REGISTRY.map((entry) => [entry.action_key, entry]),
);

const REGISTRY_BY_NODE_TYPE = new Map(
  SELLER_AUTOMATION_ACTION_REGISTRY.map((entry) => [entry.node_type, entry]),
);

export function getSellerAutomationAction(actionKey) {
  return REGISTRY_BY_KEY.get(clean(actionKey)) ?? null;
}

export function getSellerAutomationActionByNodeType(nodeType) {
  return REGISTRY_BY_NODE_TYPE.get(clean(nodeType)) ?? null;
}

export function listSellerAutomationActions({ enabledOnly = true } = {}) {
  return SELLER_AUTOMATION_ACTION_REGISTRY.filter((entry) => !enabledOnly || entry.enabled);
}

function mapRegistryNode(entry) {
  const cat = entry.frontend?.category || 'seller_flow';
  return {
    action_key: entry.action_key,
    node_type: entry.node_type,
    display_name: entry.display_name,
    description: entry.description,
    lifecycle_stage: entry.lifecycle_stage,
    trigger: entry.trigger,
    required_inputs: entry.required_inputs,
    produced_outputs: entry.produced_outputs,
    eligibility_rules: entry.eligibility_rules,
    contactability_requirements: entry.contactability_requirements,
    template_key: entry.template_key,
    retry_behavior: entry.retry_behavior,
    timeout_behavior: entry.timeout_behavior,
    next_possible_actions: entry.next_possible_actions,
    enabled: entry.enabled,
    icon: entry.frontend?.icon,
    color: entry.frontend?.color,
    category: cat,
    backend_handler: entry.backend_handler,
  };
}

export function listSellerAutomationRegistryResponse() {
  const sourceNodes = listSellerAutomationActions();
  const nodes = sourceNodes.map(mapRegistryNode);
  const categories = {};
  for (const entry of nodes) {
    const cat = entry.category || 'seller_flow';
    categories[cat] = categories[cat] || [];
    categories[cat].push(entry);
  }
  return {
    workflow_id: SELLER_AUTOMATION_WORKFLOW_ID,
    registry_version: 'seller_automation_v1',
    source: 'seller-automation-action-registry',
    counts: {
      total: nodes.length,
      enabled: nodes.filter((n) => n.enabled).length,
      categories: Object.keys(categories).length,
    },
    nodes,
    categories,
    edges: buildDefaultSellerFlowEdges(sourceNodes),
  };
}

function buildDefaultSellerFlowEdges(nodes) {
  const keys = new Set(nodes.map((n) => n.action_key));
  const edges = [];
  for (const node of nodes) {
    for (const next of node.next_possible_actions || []) {
      if (!keys.has(next)) continue;
      edges.push({
        from_action_key: node.action_key,
        to_action_key: next,
        edge_type: 'eligible_next',
      });
    }
  }
  return edges;
}

function clean(value) {
  return String(value ?? '').trim();
}

export default {
  SELLER_AUTOMATION_WORKFLOW_ID,
  SELLER_AUTOMATION_ACTION_REGISTRY,
  getSellerAutomationAction,
  listSellerAutomationActions,
  listSellerAutomationRegistryResponse,
};