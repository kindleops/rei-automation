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
    { id: 'grace', kind: 'wait', label: 'Give the team 4 hours', config: { mode: 'duration', duration_hours: 4 } },
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
