/**
 * TRIGGER + CONDITION CATALOG.
 *
 * Triggers are canonical domain events that already flow in production
 * (automation_events → workflow_events bridge, closing activity, campaign
 * lifecycle). Each declares the exact identity scope a run receives — never
 * an ambiguous phone/email string when canonical identity exists.
 *
 * Conditions read canonical state through the owning authority's own tables;
 * a workflow cannot define an opaque string condition when a typed one exists.
 */

export const TRIGGERS = Object.freeze({
  seller_reply_received: { domain: 'seller', label: 'Seller replies', source: 'workflow_events: inbound_reply (bridged from automation_events.inbound_message_received)', event_types: ['inbound_reply', 'inbound_message_received'], scope: ['thread_key', 'property_id', 'master_owner_id', 'prospect_id', 'channel'], volume30d: 132 },
  seller_needs_review: { domain: 'seller', label: 'Seller conversation needs review', source: 'automation_events: HUMAN_REVIEW_REQUESTED / AUTOMATION_NEEDS_REVIEW', event_types: ['human_review_requested', 'HUMAN_REVIEW_REQUESTED', 'AUTOMATION_NEEDS_REVIEW'], scope: ['thread_key', 'property_id', 'master_owner_id'], volume30d: 95 },
  seller_asking_price_captured: { domain: 'seller', label: 'Asking price captured', source: 'automation_events: SELLER_ASKING_PRICE_CAPTURED', event_types: ['asking_price_captured', 'SELLER_ASKING_PRICE_CAPTURED'], scope: ['thread_key', 'property_id', 'master_owner_id'], volume30d: 14 },
  seller_ownership_confirmed: { domain: 'seller', label: 'Ownership confirmed', source: 'automation_events: OWNER_CONFIRMED', event_types: ['ownership_confirmed', 'OWNER_CONFIRMED'], scope: ['thread_key', 'property_id', 'master_owner_id'], volume30d: 15 },
  seller_not_interested: { domain: 'seller', label: 'Seller not interested', source: 'automation_events: SELLER_NOT_INTERESTED', event_types: ['not_interested', 'SELLER_NOT_INTERESTED'], scope: ['thread_key', 'property_id', 'master_owner_id'], volume30d: 18 },
  message_failed: { domain: 'outbound', label: 'Outbound message failed', source: 'automation_events: queue_item_failed', event_types: ['message_failed', 'queue_item_failed'], scope: ['thread_key', 'property_id', 'queue_row_id'], volume30d: 12 },
  opportunity_stage_changed: { domain: 'pipeline', label: 'Lifecycle stage changed', source: 'workflow_events: opportunity_stage_changed', event_types: ['opportunity_stage_changed', 'stage_entered'], scope: ['opportunity_id', 'property_id', 'master_owner_id', 'to_stage'], volume30d: 19 },
  offer_sent: { domain: 'deal', label: 'Offer sent', source: 'workflow_events: offer_sent', event_types: ['offer_sent', 'offer_queued'], scope: ['thread_key', 'property_id', 'opportunity_id'], volume30d: 33 },
  contract_fully_executed: { domain: 'closing', label: 'Seller contract fully executed', source: 'Closing Authority (DocuSign reconcile)', event_types: ['contract_fully_executed'], scope: ['closing_case_id', 'opportunity_id', 'property_id'], volume30d: 0 },
  title_issue_opened: { domain: 'closing', label: 'Title issue opened', source: 'closing_activity_events: title_issue_opened', event_types: ['title_issue_opened'], scope: ['closing_case_id', 'issue_id'], volume30d: 0 },
  manual: { domain: 'any', label: 'Operator starts on an exact entity or cohort', source: 'Workflow Studio (authenticated operator)', event_types: ['manual_enrollment'], scope: ['entity_kind', 'entity_ids', 'actor'], volume30d: null },
})

export const CONDITIONS = Object.freeze({
  'seller.replied_since': { label: 'Seller replied since', reads: 'inbox_thread_state.last_inbound_at', inputs: ['seller', 'since'], exits: ['Replied', 'No reply'] },
  'seller.asking_price_known': { label: 'Asking price known?', reads: 'acquisition_opportunities.metadata.seller_facts.asking_price', inputs: ['seller'], exits: ['Known', 'Unknown'] },
  'seller.contactable': { label: 'Contactable now?', reads: 'evaluateCanonicalContactability', inputs: ['seller'], exits: ['Contactable', 'Not contactable'] },
  'seller.conversation_open': { label: 'Still needs a human?', reads: 'v_inbox_thread_state_buckets.in_needs_review / in_new_replies', inputs: ['seller'], exits: ['Open', 'Handled'] },
  'closing.title_acknowledged': { label: 'Title acknowledged?', reads: 'closing_cases.title_acknowledged_at', inputs: ['closing'], exits: ['Acknowledged', 'Not yet'] },
  'closing.commitment_received': { label: 'Title commitment received?', reads: 'closing_cases.title_commitment_received_at', inputs: ['closing'], exits: ['Received', 'Not yet'] },
  'closing.clear_to_close': { label: 'Clear to close?', reads: 'closing_cases.clear_to_close_at', inputs: ['closing'], exits: ['Clear', 'Not yet'] },
  'closing.emd_verified': { label: 'EMD verified?', reads: 'emd_receipts.status', inputs: ['closing'], exits: ['Verified', 'Not yet'] },
  'closing.cancelled': { label: 'Closing cancelled?', reads: 'closing_cases.terminal_outcome', inputs: ['closing'], exits: ['Cancelled', 'Open'] },
  'campaign.active': { label: 'Campaign still active?', reads: 'campaigns.status', inputs: ['campaign'], exits: ['Active', 'Not active'] },
  'email.address_healthy': { label: 'Email address healthy?', reads: 'email_address_health.status', inputs: ['recipient'], exits: ['Healthy', 'Bounced / suppressed'] },
  'time.deadline_passed': { label: 'Deadline passed?', reads: 'run clock vs canonical deadline', inputs: ['deadline'], exits: ['Passed', 'Not yet'] },
})

/** Evaluate a typed condition against pre-read canonical facts (pure; the runtime reads facts). */
export function evaluateCondition(key, facts = {}) {
  switch (key) {
    case 'seller.replied_since': return facts.last_inbound_at && facts.since && Date.parse(facts.last_inbound_at) > Date.parse(facts.since) ? 'Replied' : 'No reply'
    case 'seller.asking_price_known': return facts.asking_price ? 'Known' : 'Unknown'
    case 'seller.contactable': return facts.contactable === true ? 'Contactable' : 'Not contactable'
    case 'seller.conversation_open': return facts.in_needs_review || facts.in_new_replies ? 'Open' : 'Handled'
    case 'closing.title_acknowledged': return facts.title_acknowledged_at ? 'Acknowledged' : 'Not yet'
    case 'closing.commitment_received': return facts.title_commitment_received_at ? 'Received' : 'Not yet'
    case 'closing.clear_to_close': return facts.clear_to_close_at ? 'Clear' : 'Not yet'
    case 'closing.emd_verified': return facts.emd_verified ? 'Verified' : 'Not yet'
    case 'closing.cancelled': return facts.terminal_outcome ? 'Cancelled' : 'Open'
    case 'campaign.active': return String(facts.status || '').toLowerCase() === 'active' ? 'Active' : 'Not active'
    case 'email.address_healthy': return ['healthy', 'unknown'].includes(String(facts.status || 'unknown')) ? 'Healthy' : 'Bounced / suppressed'
    case 'time.deadline_passed': return facts.deadline && Date.parse(facts.deadline) < (facts.now ?? Date.now()) ? 'Passed' : 'Not yet'
    default: throw new Error(`unknown condition ${key}`)
  }
}
