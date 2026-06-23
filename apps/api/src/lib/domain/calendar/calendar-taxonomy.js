/** @typedef {'follow_up'|'seller_reply'|'scheduled_sms'|'sent_delivered'|'failed_retry'|'workflow'|'task'|'offer'|'contract'|'title'|'closing'|'buyer'|'campaign'|'appointment'|'risk_blocker'|'manual'} CalendarCategory */

/** @typedef {'blue'|'cyan'|'green'|'amber'|'red'|'purple'|'gold'|'gray'|'violet'|'teal'|'emerald'|'pink'} CalendarTone */

export const CALENDAR_LAYERS = Object.freeze([
  'follow_ups',
  'seller_replies',
  'sms',
  'email',
  'workflow',
  'offers',
  'contracts',
  'title',
  'closings',
  'buyers',
  'campaigns',
  'manual_events',
  'risks',
]);

export const EVENT_TYPE_META = Object.freeze({
  scheduled_sms: { category: 'scheduled_sms', subtype: 'queue_scheduled', tone: 'blue', layer: 'sms' },
  sms_sent: { category: 'sent_delivered', subtype: 'sms_sent', tone: 'green', layer: 'sms' },
  sms_delivered: { category: 'sent_delivered', subtype: 'sms_delivered', tone: 'emerald', layer: 'sms' },
  sms_failed: { category: 'failed_retry', subtype: 'sms_failed', tone: 'red', layer: 'risks' },
  queue_retry: { category: 'failed_retry', subtype: 'queue_retry', tone: 'amber', layer: 'risks' },
  inbound_reply: { category: 'seller_reply', subtype: 'inbound_reply', tone: 'cyan', layer: 'seller_replies' },
  seller_reply_needs_action: { category: 'seller_reply', subtype: 'needs_action', tone: 'cyan', layer: 'seller_replies' },
  positive_intent: { category: 'seller_reply', subtype: 'positive_intent', tone: 'green', layer: 'seller_replies' },
  seller_follow_up: { category: 'follow_up', subtype: 'seller_follow_up', tone: 'amber', layer: 'follow_ups' },
  workflow_wake: { category: 'workflow', subtype: 'enrollment_wake', tone: 'violet', layer: 'workflow' },
  workflow_task: { category: 'workflow', subtype: 'scheduled_task', tone: 'violet', layer: 'workflow' },
  workflow_blocked: { category: 'risk_blocker', subtype: 'workflow_blocked', tone: 'red', layer: 'risks' },
  automation_blocked: { category: 'risk_blocker', subtype: 'automation_blocked', tone: 'red', layer: 'risks' },
  offer_created: { category: 'offer', subtype: 'created', tone: 'gold', layer: 'offers' },
  offer_sent: { category: 'offer', subtype: 'sent', tone: 'gold', layer: 'offers' },
  offer_expiration: { category: 'offer', subtype: 'expiration', tone: 'gold', layer: 'offers' },
  offer_follow_up: { category: 'offer', subtype: 'follow_up', tone: 'amber', layer: 'offers' },
  contract_sent: { category: 'contract', subtype: 'sent', tone: 'teal', layer: 'contracts' },
  contract_signature_deadline: { category: 'contract', subtype: 'signature_deadline', tone: 'teal', layer: 'contracts' },
  fully_executed_contract: { category: 'contract', subtype: 'executed', tone: 'emerald', layer: 'contracts' },
  title_opened: { category: 'title', subtype: 'opened', tone: 'gold', layer: 'title' },
  title_milestone: { category: 'title', subtype: 'milestone', tone: 'gold', layer: 'title' },
  clear_to_close: { category: 'title', subtype: 'clear_to_close', tone: 'emerald', layer: 'title' },
  closing_scheduled: { category: 'closing', subtype: 'scheduled', tone: 'emerald', layer: 'closings' },
  buyer_follow_up: { category: 'buyer', subtype: 'follow_up', tone: 'amber', layer: 'buyers' },
  buyer_packet_sent: { category: 'buyer', subtype: 'packet_sent', tone: 'green', layer: 'buyers' },
  campaign_scheduled: { category: 'campaign', subtype: 'activation', tone: 'blue', layer: 'campaigns' },
  pipeline_next_action: { category: 'task', subtype: 'next_action', tone: 'amber', layer: 'follow_ups' },
  underwriting_started: { category: 'task', subtype: 'underwriting_started', tone: 'blue', layer: 'workflow' },
  underwriting_completed: { category: 'task', subtype: 'underwriting_completed', tone: 'emerald', layer: 'workflow' },
  manual_call: { category: 'appointment', subtype: 'call', tone: 'blue', layer: 'manual_events' },
  manual_meeting: { category: 'appointment', subtype: 'meeting', tone: 'blue', layer: 'manual_events' },
  manual_visit: { category: 'appointment', subtype: 'property_visit', tone: 'blue', layer: 'manual_events' },
  manual_task: { category: 'task', subtype: 'manual_task', tone: 'amber', layer: 'manual_events' },
  manual_reminder: { category: 'task', subtype: 'reminder', tone: 'amber', layer: 'manual_events' },
  dnc_suppression: { category: 'risk_blocker', subtype: 'suppression', tone: 'red', layer: 'risks' },
  historical_event: { category: 'sent_delivered', subtype: 'historical', tone: 'gray', layer: 'sms' },
});

export function resolveEventMeta(eventType) {
  return EVENT_TYPE_META[eventType] ?? {
    category: 'task',
    subtype: eventType || 'unknown',
    tone: 'gray',
    layer: 'manual_events',
  };
}

export function layerMatchesEvent(layer, eventType) {
  if (!layer || layer === 'all') return true;
  const meta = resolveEventMeta(eventType);
  return meta.layer === layer;
}