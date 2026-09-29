/**
 * FIRST BOUNDED WORKFLOWS (spec §144–145: migrate one bounded workflow first).
 *
 * seller_review_escalation — when the seller brain asks for human review, give
 * the team 4 hours; if the conversation is still open in the canonical inbox
 * buckets, raise one operator notification. Send-incapable by construction:
 * its only capability is notify.operator (deduplicated per run).
 */
export const SELLER_REVIEW_ESCALATION = Object.freeze({
  schema: 'lc.workflow/v1',
  key: 'seller_review_escalation',
  name: 'Seller review escalation',
  domain: 'seller',
  trigger: { type: 'seller_needs_review' },
  nodes: [
    { id: 'grace', kind: 'wait', label: 'Give the team 4 hours', config: { mode: 'duration', duration_hours: 4, anchor: 'trigger' } },
    { id: 'still_open', kind: 'condition', label: 'Still needs a human?', config: { condition: 'seller.conversation_open' } },
    {
      id: 'escalate', kind: 'action', label: 'Escalate to operator',
      config: {
        capability: 'notify.operator',
        inputs: {
          event_type: 'inbox_needs_call',
          title: 'Seller waiting on review for 4 hours',
          description: 'The seller brain asked for a human and the conversation is still open.',
          entity: { kind: 'seller_thread', id: { var: 'trigger.thread_key' } },
        },
      },
    },
    { id: 'escalated', kind: 'terminate', label: 'Escalated', config: { outcome: 'escalated' } },
    { id: 'handled', kind: 'terminate', label: 'Handled in time', config: { outcome: 'handled' } },
  ],
  edges: [
    { from: 'trigger', to: 'grace' },
    { from: 'grace', to: 'still_open' },
    { from: 'still_open', exit: 'Open', to: 'escalate' },
    { from: 'still_open', exit: 'Handled', to: 'handled' },
    { from: 'escalate', to: 'escalated' },
  ],
})

export const BOUNDED_WORKFLOWS = Object.freeze([SELLER_REVIEW_ESCALATION])

/**
 * BLUEPRINTS — how an operator creates a workflow on the phone. Each blueprint
 * is a typed recipe (parameters with bounds) that builds a lc.workflow/v1
 * graph; the server validates every build exactly like a publish. `reach`
 * says who can ever hear from it: 'operator' (notifications only), 'internal'
 * (state/records only) or 'seller' (can cause seller-facing messages through
 * the canonical senders, under every brake).
 */
const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d))
const n = (id, kind, label, config) => ({ id, kind, label, config })

export const BLUEPRINTS = Object.freeze({
  review_escalation: {
    name: 'Escalate unanswered reviews',
    domain: 'seller',
    reach: 'operator',
    icon: 'alert',
    summary: 'When the seller brain asks for a human and nobody has answered in time, raise one alert.',
    params: { hours: { label: 'Grace period', unit: 'hours', min: 1, max: 48, step: 1, default: 4 } },
    build: (p) => {
      const h = num(p.hours, 4, 1, 48)
      return {
        schema: 'lc.workflow/v1',
        trigger: { type: 'seller_needs_review' },
        nodes: [
          n('grace', 'wait', `Give the team ${h} hour${h === 1 ? '' : 's'}`, { mode: 'duration', duration_hours: h, anchor: 'trigger' }),
          n('still_open', 'condition', 'Still needs a human?', { condition: 'seller.conversation_open' }),
          n('escalate', 'action', 'Alert operator', { capability: 'notify.operator', inputs: { event_type: 'inbox_needs_call', title: `Seller waiting on review for ${h} hour${h === 1 ? '' : 's'}`, description: 'The seller brain asked for a human and the conversation is still open.', entity: { kind: 'seller_thread', id: { var: 'trigger.thread_key' } } } }),
          n('escalated', 'terminate', 'Escalated', { outcome: 'escalated' }),
          n('handled', 'terminate', 'Handled in time', { outcome: 'handled' }),
        ],
        edges: [{ from: 'trigger', to: 'grace' }, { from: 'grace', to: 'still_open' }, { from: 'still_open', exit: 'Open', to: 'escalate' }, { from: 'still_open', exit: 'Handled', to: 'handled' }, { from: 'escalate', to: 'escalated' }],
      }
    },
  },
  offer_silence_alert: {
    name: 'Offer went quiet',
    domain: 'deal',
    reach: 'operator',
    icon: 'trending-up',
    summary: 'After an offer goes out, wait for the seller. If they stay silent, tell me — I decide the next move.',
    params: { hours: { label: 'Wait for a reply', unit: 'hours', min: 6, max: 168, step: 6, default: 48 } },
    build: (p) => {
      const h = num(p.hours, 48, 6, 168)
      return {
        schema: 'lc.workflow/v1',
        trigger: { type: 'offer_sent' },
        nodes: [
          n('reply', 'wait', 'Wait for the seller', { mode: 'event', event: 'seller_reply_received', timeout_hours: h }),
          n('replied', 'terminate', 'Seller replied', { outcome: 'replied' }),
          n('alert', 'action', 'Alert operator', { capability: 'notify.operator', inputs: { event_type: 'inbox_needs_call', title: `Offer unanswered for ${h} hours`, description: 'The seller has not replied since the offer went out.', entity: { kind: 'seller_thread', id: { var: 'trigger.thread_key' } } } }),
          n('quiet', 'terminate', 'Went quiet', { outcome: 'no_response' }),
        ],
        edges: [{ from: 'trigger', to: 'reply' }, { from: 'reply', exit: 'Event', to: 'replied' }, { from: 'reply', exit: 'Timeout', to: 'alert' }, { from: 'alert', to: 'quiet' }],
      }
    },
  },
  failed_send_alert: {
    name: 'Failed message alert',
    domain: 'outbound',
    reach: 'operator',
    icon: 'zap',
    summary: 'The moment an outbound message fails, alert me with the conversation.',
    params: {},
    build: () => ({
      schema: 'lc.workflow/v1',
      trigger: { type: 'message_failed' },
      nodes: [
        n('alert', 'action', 'Alert operator', { capability: 'notify.operator', inputs: { event_type: 'inbox_needs_call', title: 'An outbound message failed', description: 'The provider rejected or failed a message on this conversation.', entity: { kind: 'seller_thread', id: { var: 'trigger.thread_key' } } } }),
        n('done', 'terminate', 'Alerted', { outcome: 'alerted' }),
      ],
      edges: [{ from: 'trigger', to: 'alert' }, { from: 'alert', to: 'done' }],
    }),
  },
  ownership_refresh_decision: {
    name: 'Ownership confirmed → refresh the deal',
    domain: 'deal',
    reach: 'internal',
    icon: 'target',
    summary: 'When a seller confirms ownership, make sure the deal decision is current before the offer conversation.',
    params: {},
    build: () => ({
      schema: 'lc.workflow/v1',
      trigger: { type: 'seller_ownership_confirmed' },
      nodes: [
        n('refresh', 'action', 'Refresh deal decision', { capability: 'deal.ensure_decision', inputs: { property: { kind: 'property', id: { var: 'trigger.property_id' } } } }),
        n('done', 'terminate', 'Decision current', { outcome: 'refreshed' }),
      ],
      edges: [{ from: 'trigger', to: 'refresh' }, { from: 'refresh', to: 'done' }],
    }),
  },
  not_interested_stop: {
    name: 'Not interested → stop follow-ups',
    domain: 'seller',
    reach: 'internal',
    icon: 'shield',
    summary: 'When a seller says they are not interested, withdraw every pending follow-up on that conversation.',
    params: {},
    build: () => ({
      schema: 'lc.workflow/v1',
      trigger: { type: 'seller_not_interested' },
      nodes: [
        n('stop', 'action', 'Cancel pending follow-ups', { capability: 'seller.cancel_follow_ups', inputs: { seller: { var: 'trigger' }, reason: 'seller_not_interested' } }),
        n('done', 'terminate', 'Follow-ups withdrawn', { outcome: 'stopped' }),
      ],
      edges: [{ from: 'trigger', to: 'stop' }, { from: 'stop', to: 'done' }],
    }),
  },
  title_issue_alert: {
    name: 'Title issue alert',
    domain: 'closing',
    reach: 'operator',
    icon: 'key',
    summary: 'When title opens an issue on a closing, alert me immediately.',
    params: {},
    build: () => ({
      schema: 'lc.workflow/v1',
      trigger: { type: 'title_issue_opened' },
      nodes: [
        n('alert', 'action', 'Alert operator', { capability: 'notify.operator', inputs: { event_type: 'closing_case_at_risk', title: 'Title opened an issue', description: 'Review the issue on the Closing Desk.', entity: { kind: 'closing_case', id: { var: 'trigger.closing_case_id' } } } }),
        n('done', 'terminate', 'Alerted', { outcome: 'alerted' }),
      ],
      edges: [{ from: 'trigger', to: 'alert' }, { from: 'alert', to: 'done' }],
    }),
  },
})

export function buildBlueprint(key, params = {}) {
  const bp = BLUEPRINTS[key]
  if (!bp) return null
  const clean = {}
  for (const [k, spec] of Object.entries(bp.params)) clean[k] = num(params[k], spec.default, spec.min, spec.max)
  return { ...bp.build(clean), blueprint: key, params: clean }
}
