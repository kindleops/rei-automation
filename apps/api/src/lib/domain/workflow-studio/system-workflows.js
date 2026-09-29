/**
 * SYSTEM WORKFLOWS — the automations that actually run LeadCommand today,
 * described as graphs so Workflow Studio can SHOW them without reimplementing
 * them (spec §145: visualize proven automation through adapters first).
 *
 * Each graph is the real topology of an existing canonical runtime:
 *   seller_inbound      seller-flow orchestrator (seller_automation_executions/_steps)
 *   closing_execution   closing-automation.js planner (closing_cases, closing_email_requests)
 *   campaign_execution  campaign activate-due + feeder (campaigns, campaign_targets)
 *   email_dispatch      email-dispatch.js (email_queue, email_events)
 *   outbound_sms        queue runner (send_queue)
 *
 * Nodes carry `match` — the ledger keys that prove a run passed through them —
 * so a run's execution path is DERIVED from the runtime's own records, never
 * guessed. These are LOCKED CORE (topology is code); Studio may inspect and
 * control them only through the owning system's switches.
 *
 * Node families: trigger · resolve · understand · decision · action · wait ·
 * approval · state · notify · end.
 */

export const NODE_FAMILIES = Object.freeze(['trigger', 'resolve', 'understand', 'decision', 'action', 'wait', 'approval', 'state', 'notify', 'end'])

const n = (id, family, label, extra = {}) => ({ id, family, label, ...extra })
const e = (from, to, label = null) => ({ from, to, label })

export const SYSTEM_WORKFLOWS = Object.freeze({
  seller_inbound: {
    key: 'seller_inbound',
    name: 'Seller Conversation · Inbound',
    domain: 'seller',
    kind: 'system',
    lock: 'locked_core',
    runtime: 'seller-flow orchestrator (processSellerInboundMessage)',
    owner: 'Seller Automation',
    version: 'seller-inbound-v1',
    trigger: { type: 'seller_reply_received', label: 'Seller replies (SMS or email)', source: 'TextGrid inbound webhook · Email Command inbound' },
    heartbeat: null,
    description: 'When a seller replies on any channel, this workflow resolves the seller and property, classifies the message and extracts supported facts into the one seller fact store, lets the canonical decision engine choose the next move, checks contactability and suppression, and then either sends the next permitted question (deduplicated, through the outbound queue) or routes the conversation to operator review. Canonical stage, temperature and disposition are updated by their authority, and a follow-up is scheduled when the seller goes quiet.',
    sections: [
      { id: 'identify', label: 'Identify', nodes: ['property', 'participant', 'thread'] },
      { id: 'understand', label: 'Understand', nodes: ['classify', 'facts', 'ownership', 'interest', 'price', 'condition'] },
      { id: 'decide', label: 'Decide', nodes: ['decide', 'reply', 'render', 'contact'] },
      { id: 'act', label: 'Act', nodes: ['blocked', 'dupe', 'queued', 'sent', 'failed', 'followup'] },
      { id: 'state', label: 'Canonical state', nodes: ['stage', 'status', 'review', 'notify'] },
    ],
    nodes: [
      n('trigger', 'trigger', 'Seller reply received', { match: ['inbound_message_received'], summary: 'SMS or email' }),
      n('property', 'resolve', 'Resolve property', { match: ['property_resolved'], optional: true }),
      n('participant', 'resolve', 'Resolve seller', { match: ['participant_resolved'], optional: true }),
      n('thread', 'resolve', 'Resolve conversation', { match: ['phone_thread_resolved'] }),
      n('classify', 'understand', 'Classify message', { match: ['message_classified'], summary: 'Intent + ownership signal' }),
      n('facts', 'understand', 'Extract seller facts', { match: ['facts_extracted'], summary: 'One fact store for SMS + email' }),
      n('ownership', 'understand', 'Ownership signal', { match: ['ownership_confirmed', 'ownership_inferred', 'ownership_denied'], optional: true }),
      n('interest', 'understand', 'Offer interest', { match: ['seller_interest_detected'], optional: true }),
      n('price', 'understand', 'Asking price captured', { match: ['asking_price_extracted'], optional: true }),
      n('condition', 'understand', 'Condition captured', { match: ['property_condition_extracted'], optional: true }),
      n('decide', 'decision', 'Canonical seller decision', { match: ['decision_intelligence_evaluated'], summary: 'Stage rules · next best action' }),
      n('reply', 'decision', 'Reply warranted?', { match: ['automatic_reply_selected'], optional: true, exits: ['Reply', 'No reply'] }),
      n('render', 'action', 'Render approved template', { match: ['template_rendered'], optional: true }),
      n('contact', 'decision', 'Contactable now?', { match: ['contactability_checked'], exits: ['Clear', 'Blocked'], summary: 'Suppression · opt-out · autopilot policy' }),
      n('blocked', 'approval', 'Held for operator', { match: ['automation_blocked'], optional: true, tone: 'attention', branch: 'Blocked' }),
      n('dupe', 'action', 'Duplicate-send check', { match: ['duplicate_send_check'], optional: true }),
      n('queued', 'action', 'Queue reply', { match: ['message_queued'], optional: true, capability: 'outbound_sms.enqueue' }),
      // Send truth is the send_queue outcome, never a ledger label (derived in the observatory).
      n('sent', 'action', 'Reply delivered', { match: [], optional: true, derived: 'send_queue' }),
      n('failed', 'action', 'Send failed', { match: ['message_failed'], optional: true, tone: 'bad', branch: 'Failed' }),
      n('followup', 'wait', 'Schedule follow-up', { match: ['follow_up_scheduled'], optional: true, summary: 'Cancelled on any reply' }),
      n('stage', 'state', 'Advance seller stage', { match: ['stage_advanced'], optional: true, summary: 'Lifecycle authority' }),
      n('status', 'state', 'Update lead state', { match: ['operational_status_changed', 'temperature_changed', 'disposition_changed', 'contactability_changed'], optional: true }),
      n('review', 'approval', 'Needs review', { match: ['needs_review_created'], optional: true, tone: 'attention' }),
      n('notify', 'notify', 'Notify operator', { match: ['notification_emitted'] }),
    ],
    edges: [
      e('trigger', 'property'), e('property', 'participant'), e('participant', 'thread'),
      e('thread', 'classify'), e('classify', 'facts'), e('facts', 'ownership'), e('ownership', 'interest'), e('interest', 'price'), e('price', 'condition'),
      e('condition', 'decide'), e('decide', 'reply'),
      e('reply', 'render', 'Reply'), e('reply', 'contact', 'No reply'), e('render', 'contact'),
      e('contact', 'dupe', 'Clear'), e('contact', 'blocked', 'Blocked'),
      e('dupe', 'queued'), e('queued', 'sent', 'Sent'), e('queued', 'failed', 'Failed'),
      e('sent', 'followup'), e('blocked', 'review'),
      e('followup', 'stage'), e('stage', 'status'), e('status', 'review'), e('review', 'notify'),
    ],
  },

  closing_execution: {
    key: 'closing_execution',
    name: 'Closing Execution · Title & Buyer Coordination',
    domain: 'closing',
    kind: 'system',
    lock: 'locked_core',
    runtime: 'closing-automation.js (Cloudflare */5)',
    owner: 'Closing Authority',
    version: 'closing-automation-v1',
    trigger: { type: 'contract_fully_executed', label: 'Seller contract fully executed', source: 'Closing Authority' },
    heartbeat: 'closing_automation_heartbeat_at',
    killSwitch: 'closing_automation_enabled',
    description: 'Once the seller contract is fully executed, this workflow asks Email Command to open title with the routed title company, then waits for acknowledgement, the title commitment, clear-to-close and the settlement statement — following up on a bounded cadence and escalating to the operator when a counterparty goes silent. It tracks buyer earnest money and the buyer agreement in parallel. It never sets closing truth: Closing Authority records every milestone and alone can finalize the closing.',
    sections: [
      { id: 'title', label: 'Title', nodes: ['open', 'ack', 'commitment', 'ctc', 'settlement'] },
      { id: 'buyer', label: 'Buyer', nodes: ['emd', 'agreement'] },
      { id: 'close', label: 'Close', nodes: ['confirm', 'finalize'] },
    ],
    nodes: [
      n('trigger', 'trigger', 'Contract fully executed', { match: ['contract_fully_executed'] }),
      n('open', 'action', 'Open title', { match: ['title_open'], capability: 'email.closing_request', summary: 'Email Command · title order' }),
      n('ack', 'wait', 'Wait for title acknowledgement', { match: ['title_ack'], summary: 'Follow up every 24h · max 3 · then escalate', loop: { max: 3, cadenceHours: 24, stop: 'title acknowledged' } }),
      n('commitment', 'wait', 'Wait for title commitment', { match: ['title_commitment'], loop: { max: 3, cadenceHours: 24, stop: 'commitment received' } }),
      n('ctc', 'wait', 'Wait for clear to close', { match: ['clear_to_close'], loop: { max: 3, cadenceHours: 24, stop: 'clear to close recorded' } }),
      n('settlement', 'wait', 'Request settlement statement', { match: ['settlement'], loop: { max: 3, cadenceHours: 12, stop: 'statement received' } }),
      n('emd', 'wait', 'Buyer earnest money', { lane: 'Buyer · in parallel', match: ['buyer_emd'], loop: { max: 3, cadenceHours: 24, stop: 'EMD received' } }),
      n('agreement', 'wait', 'Buyer agreement signature', { match: ['buyer_agreement'], loop: { max: 3, cadenceHours: 24, stop: 'agreement executed' } }),
      n('confirm', 'action', 'Confirm closing with title', { match: ['closing_confirmation'] }),
      n('escalate', 'approval', 'Escalate to operator', { match: ['escalated'], tone: 'attention', summary: 'Cadence exhausted · stale · no recipient', branch: 'Silent / overdue' }),
      n('finalize', 'state', 'Finalize closing (S10)', { match: ['closed'], summary: 'Closing Authority only' }),
    ],
    edges: [
      e('trigger', 'open'), e('open', 'ack'), e('ack', 'commitment', 'Acknowledged'), e('ack', 'escalate', 'Silent'),
      e('commitment', 'ctc', 'Received'), e('commitment', 'escalate', 'Overdue'), e('ctc', 'confirm', 'Clear'), e('ctc', 'escalate', 'Overdue'),
      e('confirm', 'settlement'), e('settlement', 'finalize', 'Settled'), e('settlement', 'escalate', 'Missing'),
      e('trigger', 'emd'), e('emd', 'agreement', 'Received'), e('emd', 'escalate', 'Overdue'), e('agreement', 'finalize', 'Executed'),
    ],
  },

  campaign_execution: {
    key: 'campaign_execution',
    name: 'Campaign Execution · Activation & Feeding',
    domain: 'campaign',
    kind: 'system',
    lock: 'locked_core',
    runtime: 'campaigns/activate-due + campaigns/feed (Cloudflare */5)',
    owner: 'Campaign Command',
    version: 'campaign-execution-v1',
    trigger: { type: 'campaign_scheduled', label: 'Campaign scheduled or launched', source: 'Campaign Command' },
    heartbeat: 'campaign_feeder_heartbeat_at',
    description: 'A scheduled campaign becomes active at its start time (a start missed by more than two hours is marked missed, never auto-fired). While active, the feeder moves eligible targets into the outbound queue inside the campaign contact window and daily caps; the queue runner is the only sender, under every operator brake, suppression and sender rail.',
    nodes: [
      n('trigger', 'trigger', 'Campaign scheduled', { match: ['scheduled'] }),
      n('activate', 'decision', 'Start time reached?', { match: ['active'], exits: ['Activate', 'Missed'] }),
      n('missed', 'end', 'Marked missed', { match: ['missed'], tone: 'attention', branch: 'Missed' }),
      n('feed', 'action', 'Feed eligible targets', { match: ['feeding'], capability: 'campaign.feed', summary: 'Contact window · daily cap' }),
      n('queue', 'action', 'Outbound queue', { match: ['queued'], summary: 'Queue runner sends' }),
      n('pause', 'approval', 'Paused', { match: ['paused'], tone: 'attention', branch: 'Paused' }),
      n('done', 'end', 'Completed', { match: ['completed'] }),
    ],
    edges: [e('trigger', 'activate'), e('activate', 'feed', 'Activate'), e('activate', 'missed', 'Missed'), e('feed', 'queue'), e('queue', 'feed', 'Refill'), e('feed', 'pause', 'Paused'), e('feed', 'done', 'Exhausted')],
  },

  email_dispatch: {
    key: 'email_dispatch',
    name: 'Email Dispatch · Revalidate & Send',
    domain: 'email',
    kind: 'system',
    lock: 'locked_core',
    runtime: 'email-dispatch.js (Cloudflare every minute)',
    owner: 'Email Command',
    version: 'email-dispatch-v1',
    trigger: { type: 'email_due', label: 'Email due to send', source: 'Email Command outbox' },
    heartbeat: 'email_dispatch_heartbeat_at',
    killSwitch: 'email_enabled',
    description: 'Every minute, due emails are claimed once, revalidated against live business state (did the counterparty reply, was the closing cancelled, did the operator take over, is the address suppressed, is it stale), and then sent through the brand sender — or superseded, cancelled or escalated. A transport retry reuses the same message; a send whose outcome is unknown is never re-sent.',
    nodes: [
      n('trigger', 'trigger', 'Email due', { match: ['pending_send', 'scheduled'] }),
      n('claim', 'action', 'Claim once', { match: ['sending'] }),
      n('revalidate', 'decision', 'Still right to send?', { exits: ['Send', 'Supersede', 'Escalate'] }),
      n('send', 'action', 'Send via brand sender', { match: ['sent', 'delivered'] }),
      n('superseded', 'end', 'Superseded / cancelled', { match: ['superseded', 'cancelled'], branch: 'Supersede' }),
      n('escalate', 'approval', 'Needs operator', { match: ['failed'], tone: 'attention', branch: 'Escalate' }),
    ],
    edges: [e('trigger', 'claim'), e('claim', 'revalidate'), e('revalidate', 'send', 'Send'), e('revalidate', 'superseded', 'Supersede'), e('revalidate', 'escalate', 'Escalate')],
  },
})

/**
 * Deterministic outline from topology (spec §106): the authored step order
 * (nodes are written in execution order), exception branches indented one
 * level under the decision that routes to them, decision exits listed as
 * business-readable labels.
 */
export function outlineOf(wf) {
  return wf.nodes.map((node) => {
    const exits = wf.edges.filter((x) => x.from === node.id)
    return {
      id: node.id,
      depth: node.branch ? 1 : 0,
      label: node.label,
      family: node.family,
      branch: exits.length > 1 ? exits.map((x) => x.label || wf.nodes.find((y) => y.id === x.to)?.label).filter(Boolean) : null,
      via: node.branch || null,
      lane: node.lane || null,
    }
  })
}
