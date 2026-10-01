/**
 * ANALYTICS LAB — THE CANONICAL METRIC REGISTRY (server-owned, shipped to the
 * client through GET /api/cockpit/analytics/lab/registry).
 *
 * One declaration per metric: what is counted (numerator), over what
 * (denominator), which entity is the unit, which timestamp places it in a
 * period, which tables it reads, which dimensions and filters are valid, the
 * minimum sample before a rate is shown as a finding, how fresh the source is,
 * how a comparison is expressed and what a missing value means. The engine
 * computes ONLY metrics declared here; the client renders ONLY what the
 * registry and the engine return. Nothing is estimated and shown as actual.
 *
 * DEFINITION VERSION lab-v2 (2026-09-30). Changes against the v1 contract the
 * phone surface still reads (analytics_performance RPC) are listed in
 * DEFINITION_CHANGES with the production evidence that forced each one.
 */

export const DEFINITION_VERSION = 'lab-v2.2026-09-30'

/** The unit a metric counts. Dimensions and filters are declared per entity. */
export const ENTITIES = {
  seller: { label: 'Seller conversation', plural: 'sellers', key: 'thread_key', note: 'A seller is identified by their phone conversation (send_queue.thread_key). Where a prospect is recorded, phones and prospects are 1:1 except for 2 prospects with 2 phones (production, 2026-09-30).' },
  message: { label: 'Outbound message', plural: 'messages', key: 'send_queue.id' },
  reply: { label: 'Seller reply', plural: 'replies', key: 'message_events.id' },
  opportunity: { label: 'Opportunity', plural: 'opportunities', key: 'acquisition_opportunities.id' },
  transition: { label: 'Stage transition', plural: 'transitions', key: 'acquisition_opportunity_history.id' },
  run: { label: 'Autopilot run', plural: 'runs', key: 'seller_automation_executions.id' },
  offer: { label: 'Offer', plural: 'offers', key: 'seller_offers.offer_id' },
  closing: { label: 'Closing case', plural: 'closing cases', key: 'closing_cases.id' },
  purchase: { label: 'Recorded buyer purchase', plural: 'purchases', key: 'comp_private.mv_comp_market_evidence' },
}

/** Where each entity is placed in time. Declared once; metrics reference these. */
export const TIME_BASES = {
  attempt: {
    label: 'Send attempt time',
    column: 'coalesce(send_queue.sent_at, send_queue.created_at)',
    why: 'A message belongs to the period it was SENT in; rows that never left the queue belong to the period they were queued in. v1 used created_at, which placed 1,395 April-queued rows (1,136 delivered) in April although they were sent in May.',
  },
  anchor: {
    label: 'First delivered message in the period',
    column: 'min(attempt time) over the seller’s delivered messages in the period',
    why: 'A seller is reached once per period; every seller attribute (campaign, sender, template, market) is read off that anchor message so breakdowns add up to the total.',
  },
  inbound: {
    label: 'Reply receive time',
    column: 'message_events.created_at (direction = inbound)',
    why: 'received_at and event_timestamp were REWRITTEN to 2026-07-01 for 1,096 April–June inbound rows by a reprocessing sweep; created_at is the only faithful receive time. Any metric keyed on received_at would put those replies on July 1.',
  },
  history: { label: 'Recorded event time', column: 'acquisition_opportunity_history.created_at', why: 'Stage and creation truth is the append-only history, never the opportunity row’s mutable fields.' },
  run: { label: 'Run start', column: 'seller_automation_executions.created_at', why: 'One row per autopilot evaluation.' },
  offer: { label: 'Offer recorded', column: 'seller_offers.created_at', why: '' },
  contract: { label: 'Contract signed date', column: 'closing_cases.contract_signed_date', why: '' },
  closing: { label: 'Recording / funding date', column: 'coalesce(closing_cases.recording_date, closing_cases.funding_date)', why: 'Actual, never projected.' },
  purchase: { label: 'Recorded purchase date', column: 'mv_comp_market_evidence.event_date', why: 'The recorded corpus has a DATA-THROUGH date; later periods are "not yet recorded", never zero.' },
}

const SQ = 'send_queue'
const ME = 'message_events (inbound)'
const AOH = 'acquisition_opportunity_history'
const SAE = 'seller_automation_executions'
const CANARY = 'Internal test phones (INTERNAL_TEST_PHONE_SET, 5 numbers) and rows flagged internal_canary / exclude_from_kpis are excluded.'

/** Dimension ids by entity. The engine resolves each through the canonical joins below. */
const GEO = ['market', 'state', 'county', 'zip']
const PROPERTY = ['property_type', 'owner_type']
const OUTREACH = ['campaign', 'campaign_source', 'sender', 'template', 'template_use_case', 'touch', 'origin', 'language']
const DIMS = {
  seller: [...GEO, ...PROPERTY, ...OUTREACH, 'weekday_local', 'hour_local'],
  message: [...GEO, ...PROPERTY, ...OUTREACH, 'disposition', 'failure_class', 'weekday_local', 'hour_local', 'channel'],
  reply: [...GEO, ...PROPERTY, 'campaign', 'campaign_source', 'sender', 'template', 'touch', 'intent', 'weekday_local', 'hour_local'],
  opportunity: [...GEO, ...PROPERTY, 'stage', 'campaign'],
  transition: [...GEO, ...PROPERTY, 'stage', 'from_stage', 'actor', 'direction'],
  run: [...GEO, ...PROPERTY, 'hold_class', 'block_reason', 'workflow'],
  offer: [...GEO],
  closing: [...GEO],
  purchase: ['market', 'zip', 'buyer_kind'],
}

const m = (id, spec) => ({
  id,
  version: DEFINITION_VERSION,
  unit: 'count',
  polarity: 'neutral',
  min_sample: null,
  null_behavior: 'A period with no qualifying records is 0 only when the source is live and was read successfully; a failed or unavailable source is UNAVAILABLE, never 0.',
  comparison: 'count',
  freshness: { kind: 'live', note: 'Read on request; cached 90 s while the window touches now.' },
  dimensions: DIMS[spec.entity] || [],
  ...spec,
})

/**
 * THE METRICS. `family` groups them in the UI. `numerator` / `denominator`
 * reference other metric ids when the operands are themselves metrics, so the
 * inspector can open each operand's records.
 */
export const METRIC_REGISTRY = Object.freeze([
  /* ── communication · seller grain ─────────────────────────────────────── */
  m('sellers_reached', {
    family: 'communication', entity: 'seller', label: 'Sellers reached', short: 'Reached',
    description: 'Distinct seller conversations with at least one message DELIVERED whose send attempt falls in the period. One seller counts once however many messages they received.',
    numerator: { label: 'sellers with a delivered message sent in the period', def: 'count(distinct thread_key) where delivered and attempt time in period' },
    time_basis: 'anchor', sources: [SQ], exclusions: [CANARY], polarity: 'neutral', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 placed messages by created_at (queue time). Identical for the last 30 days (710 delivered rows / 663 threads either way); differs for April–May.' },
  }),
  m('sellers_replied', {
    family: 'communication', entity: 'reply', label: 'Sellers who replied', short: 'Replied (all)',
    description: 'Distinct seller conversations that sent at least one inbound reply in the period, whenever they were first contacted. Includes replies to earlier outreach — this is reply THROUGHPUT, not the reply rate numerator.',
    numerator: { label: 'distinct seller threads with an inbound reply in the period', def: 'count(distinct message_events.thread_key) where direction = inbound and created_at in period' },
    time_basis: 'inbound', sources: [ME], exclusions: [CANARY, 'Inbound rows with no thread (25 synthetic "inbound_unknown" rows from test numbers) are excluded.'],
    polarity: 'up', additive_over_time: false,
    v1: { status: 'same', note: 'Matches v1 replied_conversations.' },
  }),
  m('reached_replied', {
    family: 'communication', entity: 'seller', label: 'Reached sellers who replied', short: 'Replied',
    description: 'Sellers reached in the period who replied at or after their first delivered message in the period (replies counted through the period end).',
    numerator: { label: 'reached sellers with a reply after their period anchor', def: 'thread ∈ reached(P) and ∃ inbound reply r on the thread with anchor ≤ r.created_at < P.end' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'up', additive_over_time: true,
    v1: { status: 'new', note: 'v1 had no subset-consistent numerator.' },
  }),
  m('reply_rate', {
    family: 'communication', entity: 'seller', label: 'Reply rate', short: 'Reply rate', unit: 'rate', comparison: 'pts',
    description: 'Of the sellers reached in the period, the share who replied after being reached. Numerator is a subset of the denominator, so it is a true proportion (Wilson interval shown).',
    numerator: { metric: 'reached_replied', label: 'reached sellers who replied' },
    denominator: { metric: 'sellers_reached', label: 'sellers reached' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'up', min_sample: 30, additive_over_time: false,
    caveat: 'Sellers reached late in the period have had less time to reply (right-censored). The comparison period is measured by the identical rule.',
    v1: { status: 'changed', note: 'v1 divided ALL sellers who replied in the period (incl. replies to earlier outreach) by sellers reached — the numerator was not a subset of the denominator (30D: 9 of 90 replying threads were not reached in the period), so it could exceed 100% on a short window.' },
  }),
  m('interested_sellers', {
    family: 'communication', entity: 'seller', label: 'Interested sellers', short: 'Interested',
    description: 'Reached sellers whose reply after their period anchor carried a positive intent (interest, ownership confirmed, asking price, asks for an offer, price anchor/interest — the shared war-room POSITIVE_INTENTS).',
    numerator: { label: 'reached sellers with a positive reply', def: 'reached_replied ∩ detected_intent ∈ POSITIVE_INTENTS' },
    time_basis: 'anchor', sources: [SQ, `${ME}.detected_intent`], exclusions: [CANARY], polarity: 'up', additive_over_time: true,
    caveat: 'Replies the classifier has not labelled (detected_intent null, 4 in the last 30 days) are not positive and not negative — they are counted as replied only.',
    v1: { status: 'changed', note: 'v1 counted positive threads among ALL repliers.' },
  }),
  m('positive_reply_rate', {
    family: 'communication', entity: 'seller', label: 'Positive reply rate', short: 'Positive %', unit: 'rate', comparison: 'pts',
    description: 'Of the reached sellers who replied, the share whose reply was positive.',
    numerator: { metric: 'interested_sellers', label: 'interested sellers' }, denominator: { metric: 'reached_replied', label: 'reached sellers who replied' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'up', min_sample: 20, additive_over_time: false,
    v1: { status: 'changed', note: 'v1 positive_share used all repliers as the base.' },
  }),
  m('interest_rate', {
    family: 'communication', entity: 'seller', label: 'Interest rate', short: 'Interest', unit: 'rate', comparison: 'pts',
    description: 'Of the sellers reached in the period, the share who showed interest.',
    numerator: { metric: 'interested_sellers', label: 'interested sellers' }, denominator: { metric: 'sellers_reached', label: 'sellers reached' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'up', min_sample: 30, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('opted_out_sellers', {
    family: 'communication', entity: 'seller', label: 'Opted-out sellers', short: 'Opt-outs',
    description: 'Reached sellers who opted out after their period anchor (opt-out flag, STOP keyword or opt-out intent).',
    numerator: { label: 'reached sellers who opted out', def: 'reached_replied ∩ (is_opt_out or opt_out_keyword or intent ∈ OPTOUT_INTENTS)' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 counted opt-outs among all repliers.' },
  }),
  m('opt_out_rate', {
    family: 'communication', entity: 'seller', label: 'Opt-out rate', short: 'Opt-out', unit: 'rate', comparison: 'pts',
    description: 'Of the sellers reached in the period, the share who opted out after being reached.',
    numerator: { metric: 'opted_out_sellers', label: 'opted-out sellers' }, denominator: { metric: 'sellers_reached', label: 'sellers reached' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'down', min_sample: 30, additive_over_time: false,
    v1: { status: 'changed', note: 'v1 numerator was not restricted to the reached cohort.' },
  }),
  m('touches_per_reply', {
    family: 'communication', entity: 'seller', label: 'Touches per reply', short: 'Touches/reply', unit: 'ratio', comparison: 'ratio',
    description: 'Delivered messages sent in the period to the reached cohort, divided by the reached sellers who replied. A ratio, not a proportion.',
    numerator: { metric: 'messages_delivered', label: 'delivered messages to reached sellers' }, denominator: { metric: 'reached_replied', label: 'reached sellers who replied' },
    time_basis: 'attempt', sources: [SQ, ME], exclusions: [CANARY], polarity: 'down', min_sample: 20, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('median_reply_latency', {
    family: 'communication', entity: 'seller', label: 'Median reply latency', short: 'Reply latency', unit: 'duration_min', comparison: 'duration',
    description: 'For each reached seller who replied, minutes from the latest delivered message before their first reply to that reply. Median, with P75 and n.',
    numerator: { label: 'minutes from our last delivered message to the first reply', def: 'first reply after anchor − latest delivered attempt before it (same thread, ≤ 30 days)' },
    time_basis: 'anchor', sources: [SQ, ME], exclusions: [CANARY], polarity: 'down', min_sample: 10, additive_over_time: false,
    v1: { status: 'changed', note: 'v1 measured against message_events outbound timestamps for every replying thread; lab-v2 measures the reached cohort against delivered send_queue attempts (the same messages; send_queue is the send authority).' },
  }),

  /* ── delivery · message grain ─────────────────────────────────────────── */
  m('queue_rows', {
    family: 'delivery', entity: 'message', label: 'Queue rows', short: 'Queued',
    description: 'Every outbound queue row whose attempt time (sent, else queued) falls in the period, whatever happened to it: sent, held, blocked, refused, expired, cancelled or still waiting. The whole of the delivery flow; each row has exactly one outcome.',
    numerator: { label: 'send_queue rows', def: 'all send_queue rows with attempt time in period' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'neutral', additive_over_time: true,
    v1: { status: 'new', note: 'v1 counted send_rows by created_at; lab-v2 places them by attempt time.' },
  }),
  m('messages_sent', {
    family: 'delivery', entity: 'message', label: 'Messages sent', short: 'Sent',
    description: 'Outbound messages handed to the carrier in the period (sent_at recorded, or status sent/delivered).',
    numerator: { label: 'messages sent', def: 'sent_at is not null or queue_status in (sent, delivered)' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'neutral', additive_over_time: true,
    v1: { status: 'changed', note: 'Same predicate as v1; placed by send time instead of queue time.' },
  }),
  m('messages_delivered', {
    family: 'delivery', entity: 'message', label: 'Messages delivered', short: 'Delivered',
    description: 'Sent messages the carrier confirmed delivered.',
    numerator: { label: 'messages delivered', def: 'delivered_at is not null or queue_status = delivered or delivery_confirmed in (true, delivered, yes)' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'up', additive_over_time: true,
    v1: { status: 'changed', note: 'Same predicate as v1; placed by send time.' },
  }),
  m('delivery_rate', {
    family: 'delivery', entity: 'message', label: 'Delivery rate', short: 'Delivery', unit: 'rate', comparison: 'pts',
    description: 'Of the messages sent in the period, the share the carrier confirmed delivered.',
    numerator: { metric: 'messages_delivered', label: 'messages delivered' }, denominator: { metric: 'messages_sent', label: 'messages sent' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'up', min_sample: 30, additive_over_time: false,
    caveat: 'Messages sent in the last minutes may not have a delivery receipt yet (counted as sent, not delivered).',
    v1: { status: 'same', note: 'Same ratio; placed by send time.' },
  }),
  m('transport_failures', {
    family: 'delivery', entity: 'message', label: 'Transport failures', short: 'Undelivered',
    description: 'Sent messages the carrier reported as not delivered (failed_transport / undelivered). Never includes rows the queue held or blocked before sending.',
    numerator: { label: 'carrier non-delivery', def: 'queue_status in (failed_transport, undelivered)' },
    time_basis: 'attempt', sources: [SQ, 'message_events.failure_bucket'], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 "failed" also added provider rejections (queue_status failed: HTTP 21610 blacklist, NO SID, internal errors) that never reached the carrier.' },
  }),
  m('transport_failure_rate', {
    family: 'delivery', entity: 'message', label: 'Transport failure rate', short: 'Undelivered %', unit: 'rate', comparison: 'pts',
    description: 'Of the messages sent in the period, the share the carrier reported undelivered.',
    numerator: { metric: 'transport_failures', label: 'transport failures' }, denominator: { metric: 'messages_sent', label: 'messages sent' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', min_sample: 30, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('content_filtered', {
    family: 'delivery', entity: 'message', label: 'Carrier content-filtered', short: 'Filtered',
    description: 'Transport failures the carrier attributed to spam/content filtering (message_events.failure_bucket = Spam on the message’s delivery callback).',
    numerator: { label: 'carrier spam-filtered messages', def: 'transport failure and latest callback failure_bucket = Spam' },
    time_basis: 'attempt', sources: [SQ, 'message_events.failure_bucket (outbound callbacks, joined by queue_id)'], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 "content blocks" matched the regex (blank|content|filter|216) on failure/guard reasons: it counted pre-send blank-greeting guards and HTTP 21610 blacklist rejections (a recipient opt-out, not content) and MISSED every carrier spam filter (their reason is "delivery_failed"). 30D: v1 reported 4; the carrier filtered 326 of 1,072 sent.' },
  }),
  m('content_filter_rate', {
    family: 'delivery', entity: 'message', label: 'Content-filter rate', short: 'Filtered %', unit: 'rate', comparison: 'pts',
    description: 'Of the messages sent in the period, the share the carrier filtered as spam/content.',
    numerator: { metric: 'content_filtered', label: 'carrier content-filtered' }, denominator: { metric: 'messages_sent', label: 'messages sent' },
    time_basis: 'attempt', sources: [SQ, 'message_events.failure_bucket'], exclusions: [CANARY], polarity: 'down', min_sample: 30, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('provider_rejections', {
    family: 'delivery', entity: 'message', label: 'Provider rejections', short: 'Rejected',
    description: 'Messages the SMS provider refused before accepting them (queue_status failed): recipient blacklisted the sender pair (HTTP 21610 — a prior STOP), no message SID returned, or an internal send error. Not a carrier delivery failure.',
    numerator: { label: 'provider-refused messages', def: 'queue_status in (failed, paused_max_retries) and never sent' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 merged these into "failed".' },
  }),
  m('dispatch_decisions', {
    family: 'delivery', entity: 'message', label: 'Dispatch decisions', short: 'Dispatched',
    description: 'Queue rows that reached an outcome in the period: sent, refused by the provider, or held/blocked by a guard or gate. Excludes rows still waiting, cancelled or expired unsent. The denominator for guard and gate rates.',
    numerator: { label: 'rows with a dispatch outcome', def: 'sent ∪ provider rejected ∪ held/blocked' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'neutral', additive_over_time: true,
    v1: { status: 'new', note: '' },
  }),
  m('sender_health_blocks', {
    family: 'delivery', entity: 'message', label: 'Sender-health blocks', short: 'Sender blocks',
    description: 'Messages the sender-health guard stopped before sending (blocked sender number, sender cooling/ineligible).',
    numerator: { label: 'sender-health blocks', def: 'queue_status = blocked_by_health_guard with sender reason, or blocked_sender_ineligible' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 "sender-health blocks" also counted blocked_template_id (122 of 322 all-time health-guard rows are TEMPLATE blocks).' },
  }),
  m('sender_health_block_rate', {
    family: 'delivery', entity: 'message', label: 'Sender-health block rate', short: 'Sender block %', unit: 'rate', comparison: 'pts',
    description: 'Of the dispatch decisions in the period, the share stopped by the sender-health guard.',
    numerator: { metric: 'sender_health_blocks', label: 'sender-health blocks' }, denominator: { metric: 'dispatch_decisions', label: 'dispatch decisions' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', min_sample: 30, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('template_health_blocks', {
    family: 'delivery', entity: 'message', label: 'Template-health blocks', short: 'Template blocks',
    description: 'Messages the health guard stopped because the TEMPLATE was blocked (blocked_template_id).',
    numerator: { label: 'template-health blocks', def: 'queue_status = blocked_by_health_guard with template reason' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'Split out of v1 "sender-health blocks".' },
  }),
  m('content_guard_blocks', {
    family: 'delivery', entity: 'message', label: 'Pre-send content guards', short: 'Content guards',
    description: 'Messages our own guards stopped before sending for content quality (blank greeting, blank body, missing first name). Not a carrier filter.',
    numerator: { label: 'pre-send content guard stops', def: 'queue_status in (blocked, paused_name_missing) with a blank/missing-name reason' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 mixed these into "content blocks".' },
  }),
  m('send_gate_holds', {
    family: 'delivery', entity: 'message', label: 'Held by send gate', short: 'Gate holds',
    description: 'Queue rows the system brake held (global lock / emergency stop). The system’s own brake — not a failure, not a campaign hold.',
    numerator: { label: 'rows held by the send gate', def: 'queue_status = paused_global_lock or reason queue_emergency_stop_active' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'neutral', additive_over_time: true,
    v1: { status: 'new', note: '' },
  }),
  m('send_gate_hold_rate', {
    family: 'delivery', entity: 'message', label: 'Send-gate hold rate', short: 'Gate hold %', unit: 'rate', comparison: 'pts',
    description: 'Of the dispatch decisions in the period, the share held by the send gate.',
    numerator: { metric: 'send_gate_holds', label: 'held by send gate' }, denominator: { metric: 'dispatch_decisions', label: 'dispatch decisions' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'neutral', min_sample: 30, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('median_send_delay', {
    family: 'delivery', entity: 'message', label: 'Median send delay', short: 'Send delay', unit: 'duration_min', comparison: 'duration',
    description: 'Minutes from a message’s scheduled time to the moment it was sent. Median with P75 and n.',
    numerator: { label: 'sent_at − scheduled time', def: 'sent_at − coalesce(scheduled_for_utc, scheduled_for), ≥ 0' },
    time_basis: 'attempt', sources: [SQ], exclusions: [CANARY], polarity: 'down', min_sample: 10, additive_over_time: false,
    v1: { status: 'same', note: '' },
  }),

  /* ── pipeline · opportunity grain ─────────────────────────────────────── */
  m('opportunities_created', {
    family: 'pipeline', entity: 'transition', label: 'Opportunities created', short: 'Opportunities',
    description: 'opportunity_created events recorded in the period (canonical creation truth). The June 2026 backfill (721 rows) has no creation event and is never counted as created.',
    numerator: { label: 'opportunity_created events', def: `${AOH}.event_type = opportunity_created` },
    time_basis: 'history', sources: [AOH], exclusions: ['Certification / probe / fixture / QA rows (actor or reason) excluded; a null actor is kept (the v1 null-actor trap).'],
    polarity: 'up', additive_over_time: true,
    v1: { status: 'same', note: '' },
  }),
  m('opportunity_rate', {
    family: 'pipeline', entity: 'seller', label: 'Opportunity rate', short: 'Reply → opp', unit: 'rate', comparison: 'pts',
    description: 'Of the reached sellers who replied, the share whose conversation produced an opportunity (opportunity_created on their thread at or after their period anchor).',
    numerator: { label: 'repliers who became opportunities', def: 'reached_replied ∩ opportunity_created(primary_thread_key) in [anchor, P.end)' },
    denominator: { metric: 'reached_replied', label: 'reached sellers who replied' },
    time_basis: 'anchor', sources: [SQ, ME, AOH, 'acquisition_opportunities.primary_thread_key'], exclusions: [CANARY], polarity: 'up', min_sample: 20, additive_over_time: false,
    v1: { status: 'new', note: '' },
  }),
  m('stage_advancements', {
    family: 'pipeline', entity: 'transition', label: 'Stage advancements', short: 'Advanced',
    description: 'FORWARD stage transitions recorded in the period (to a later canonical stage S1→S10). Backward moves and re-opens are counted separately.',
    numerator: { label: 'forward stage transitions', def: 'stage_transition with stage_index(to) > stage_index(from)' },
    time_basis: 'history', sources: [AOH], exclusions: ['Certification / probe / fixture rows excluded.'], polarity: 'up', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 counted every stage_transition, including backward moves (e.g. 2026-09-23 closed → asking_price, an operator re-open).' },
  }),
  m('stage_regressions', {
    family: 'pipeline', entity: 'transition', label: 'Stage regressions', short: 'Moved back',
    description: 'Backward stage transitions (including re-opening a closed opportunity) recorded in the period.',
    numerator: { label: 'backward stage transitions', def: 'stage_transition with stage_index(to) < stage_index(from)' },
    time_basis: 'history', sources: [AOH], exclusions: ['Certification / probe / fixture rows excluded.'], polarity: 'down', additive_over_time: true,
    v1: { status: 'new', note: '' },
  }),
  m('median_stage_dwell', {
    family: 'pipeline', entity: 'transition', label: 'Median stage dwell', short: 'Stage dwell', unit: 'duration_min', comparison: 'duration',
    description: 'For stage exits recorded in the period, time from entering the stage to leaving it (previous recorded event on the same opportunity). Median, P75, n.',
    numerator: { label: 'exit time − entry time', def: 'transition.created_at − previous history event on the opportunity' },
    time_basis: 'history', sources: [AOH], exclusions: ['Certification rows excluded.'], polarity: 'down', min_sample: 5, additive_over_time: false,
    v1: { status: 'same', note: '' },
  }),
  m('offers_issued', {
    family: 'pipeline', entity: 'offer', label: 'Offers issued', short: 'Offers',
    description: 'Offers we issued (seller_offers, not seller counters) recorded in the period.',
    numerator: { label: 'offers issued', def: 'seller_offers.direction <> inbound (null direction counted as ours)' },
    time_basis: 'offer', sources: ['seller_offers'], exclusions: [], polarity: 'up', additive_over_time: true,
    caveat: 'Production offer ledger: 1 row ever — a withdrawn seller counter. Zero here is an empty ledger, not a failed funnel.',
    v1: { status: 'changed', note: 'v1 "direction <> inbound" silently dropped rows with a null direction.' },
  }),
  m('contracts_signed', {
    family: 'pipeline', entity: 'closing', label: 'Contracts signed', short: 'Contracts',
    description: 'Closing cases with a contract signed date in the period (voided / cancelled cases excluded).',
    numerator: { label: 'contracts signed', def: 'closing_cases.contract_signed_date in period' },
    time_basis: 'contract', sources: ['closing_cases'], exclusions: ['Voided / cancelled closing cases.'], polarity: 'up', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 did not exclude voided cases.' },
  }),
  m('closings', {
    family: 'pipeline', entity: 'closing', label: 'Closings', short: 'Closed',
    description: 'Closing cases recorded or funded in the period (actual dates only, never projected).',
    numerator: { label: 'closings', def: 'coalesce(recording_date, funding_date) in period' },
    time_basis: 'closing', sources: ['closing_cases'], exclusions: ['Voided / cancelled closing cases.'], polarity: 'up', additive_over_time: true,
    v1: { status: 'changed', note: 'v1 did not exclude voided cases.' },
  }),
  m('offer_rate', {
    family: 'pipeline', entity: 'opportunity', label: 'Offer rate', short: 'Offer rate', unit: 'rate', comparison: 'pts',
    description: 'Of the opportunities that entered S5 Offer in the period, the share that received an issued offer.',
    numerator: { metric: 'offers_issued', label: 'offers issued' }, denominator: { label: 'opportunities entering S5 Offer', def: 'stage_transition to = offer' },
    time_basis: 'history', sources: ['seller_offers', AOH], exclusions: [], polarity: 'up', min_sample: 10, additive_over_time: false,
    availability: { requires: 'offers_issued', min_records_ever: 5, reason: 'The offer ledger holds fewer than 5 issued offers in the whole corpus, so a rate would read as a 0% funnel instead of a practice that has not started.' },
    v1: { status: 'new', note: '' },
  }),
  m('contract_rate', {
    family: 'pipeline', entity: 'opportunity', label: 'Contract rate', short: 'Contract rate', unit: 'rate', comparison: 'pts',
    description: 'Of the offers issued in the period, the share that reached a signed contract.',
    numerator: { metric: 'contracts_signed', label: 'contracts signed' }, denominator: { metric: 'offers_issued', label: 'offers issued' },
    time_basis: 'contract', sources: ['closing_cases', 'seller_offers'], exclusions: [], polarity: 'up', min_sample: 10, additive_over_time: false,
    availability: { requires: 'contracts_signed', min_records_ever: 5, reason: 'No signed contracts exist in production yet.' },
    v1: { status: 'new', note: '' },
  }),
  m('close_rate', {
    family: 'pipeline', entity: 'closing', label: 'Close rate', short: 'Close rate', unit: 'rate', comparison: 'pts',
    description: 'Of the contracts signed in the period, the share that closed.',
    numerator: { metric: 'closings', label: 'closings' }, denominator: { metric: 'contracts_signed', label: 'contracts signed' },
    time_basis: 'closing', sources: ['closing_cases'], exclusions: [], polarity: 'up', min_sample: 10, additive_over_time: false,
    availability: { requires: 'closings', min_records_ever: 5, reason: 'No closings exist in production yet.' },
    v1: { status: 'new', note: '' },
  }),

  /* ── automation · run grain ───────────────────────────────────────────── */
  m('autopilot_runs', {
    family: 'automation', entity: 'run', label: 'Autopilot runs', short: 'Runs',
    description: 'Seller-inbound autopilot evaluations recorded in the period (one per inbound message it handled). Replay-only runs excluded.',
    numerator: { label: 'autopilot runs', def: `${SAE} where not replay_only` },
    time_basis: 'run', sources: [SAE], exclusions: ['replay_only runs.'], polarity: 'neutral', additive_over_time: true,
    v1: { status: 'same', note: '' },
  }),
  m('autopilot_executed', {
    family: 'automation', entity: 'run', label: 'Autopilot executed', short: 'Executed',
    description: 'Runs whose decided action executed.',
    numerator: { label: 'succeeded runs', def: 'status = succeeded' },
    time_basis: 'run', sources: [SAE], exclusions: [], polarity: 'up', additive_over_time: true,
    v1: { status: 'same', note: '' },
  }),
  m('human_intervention_rate', {
    family: 'automation', entity: 'run', label: 'Human-intervention rate', short: 'Human review', unit: 'rate', comparison: 'pts',
    description: 'Of all autopilot runs in the period, the share the autopilot itself routed to a person (unclear / low confidence, missing context, relationship review, automation review). Not a failure rate: holds by the send gate, auto-reply-off and compliance policy are separate classes.',
    numerator: { label: 'runs routed to a human', def: 'blocked with review / unclear / missing_context / low_confidence reasons' }, denominator: { metric: 'autopilot_runs', label: 'autopilot runs' },
    time_basis: 'run', sources: [SAE], exclusions: ['replay_only runs.'], polarity: 'down', min_sample: 30, additive_over_time: false,
    v1: { status: 'same', note: 'Same classes as v1 automation_needs_review.' },
  }),
  m('workflow_hold_rate', {
    family: 'automation', entity: 'run', label: 'Workflow hold rate', short: 'Held %', unit: 'rate', comparison: 'pts',
    description: 'Of all autopilot runs in the period, the share held for ANY reason (send gate, auto-reply off, human review, compliance policy). The hold-class breakdown is additive.',
    numerator: { label: 'held runs', def: 'status = blocked' }, denominator: { metric: 'autopilot_runs', label: 'autopilot runs' },
    time_basis: 'run', sources: [SAE], exclusions: ['replay_only runs.'], polarity: 'neutral', min_sample: 30, additive_over_time: false,
    caveat: 'While the send gate is closed (review-only mode) almost every run is held by design.',
    v1: { status: 'new', note: '' },
  }),

  /* ── buyers ───────────────────────────────────────────────────────────── */
  m('buyer_purchases', {
    family: 'buyers', entity: 'purchase', label: 'Recorded buyer purchases', short: 'Purchases',
    description: 'Arm’s-length purchases by identity-resolved buyers in the period (nominal and distress/transfer deeds excluded).',
    numerator: { label: 'recorded purchases', def: 'mv_comp_market_evidence where buyer_id is not null' },
    time_basis: 'purchase', sources: ['comp_private.mv_comp_market_evidence'], exclusions: ['Nominal-price and distress/transfer deeds.'], polarity: 'neutral', additive_over_time: true,
    freshness: { kind: 'batch', note: 'Recorded-transaction corpus; see DATA THROUGH. Periods after it are not yet recorded, never zero.' },
    v1: { status: 'same', note: '' },
  }),
])

export const METRICS_BY_ID = Object.freeze(Object.fromEntries(METRIC_REGISTRY.map((x) => [x.id, x])))

/** Dimensions: label, entity support comes from each metric; `kind` tells the UI how to draw them. */
export const DIMENSION_REGISTRY = Object.freeze({
  market: { label: 'Market', family: 'GEOGRAPHY', kind: 'category', source: 'properties.canonical_market_id → canonical_markets (the canonical geography resolver; replies inherit the property of the send that prompted them)' },
  state: { label: 'State', family: 'GEOGRAPHY', kind: 'category', source: 'properties.property_address_state' },
  county: { label: 'County', family: 'GEOGRAPHY', kind: 'category', source: 'properties.property_address_county_name / property_county_name' },
  zip: { label: 'ZIP', family: 'GEOGRAPHY', kind: 'category', source: 'left(properties.property_address_zip, 5)' },
  property_type: { label: 'Property type', family: 'PROPERTY', kind: 'category', source: 'properties.property_type' },
  owner_type: { label: 'Owner type', family: 'OWNER', kind: 'category', source: 'properties.owner_type (casing normalised)' },
  campaign: { label: 'Campaign', family: 'CAMPAIGN', kind: 'category', source: 'send_queue.campaign_id → campaigns' },
  campaign_source: { label: 'Campaign source', family: 'CAMPAIGN', kind: 'category', source: 'campaigns.metadata.source (map_area / entity_graph), else the builder’s filters' },
  sender: { label: 'Sender number', family: 'SENDER', kind: 'category', source: 'send_queue.textgrid_number_id → textgrid_numbers' },
  template: { label: 'Template', family: 'TEMPLATE', kind: 'category', source: 'send_queue.template_id → sms_templates.template_id' },
  template_use_case: { label: 'Template use case', family: 'TEMPLATE', kind: 'category', source: 'sms_templates.use_case' },
  touch: { label: 'Touch', family: 'COMMUNICATION', kind: 'ordinal', source: 'send_queue.touch_number (1, 2, 3, 4+)' },
  origin: { label: 'Send origin', family: 'SYSTEM', kind: 'category', source: 'send_queue.source / message_type → system / operator / unlabelled' },
  language: { label: 'Language', family: 'COMMUNICATION', kind: 'category', source: 'send_queue.language' },
  channel: { label: 'Channel', family: 'CHANNEL', kind: 'category', source: 'SMS only — the email channel has never sent (sending is off)' },
  disposition: { label: 'Queue outcome', family: 'COMMUNICATION', kind: 'category', source: 'send_queue.queue_status classified (delivered / sent / undelivered / rejected / held / blocked / expired / cancelled / waiting)' },
  failure_class: { label: 'Failure / hold class', family: 'COMMUNICATION', kind: 'category', source: 'queue_status + reasons + carrier failure bucket' },
  weekday_local: { label: 'Weekday (seller local)', family: 'TIME', kind: 'ordinal', source: 'attempt / reply time in the property’s timezone (deriveTimezoneFromGeography)' },
  hour_local: { label: 'Hour (seller local)', family: 'TIME', kind: 'ordinal', source: 'attempt / reply time in the property’s timezone (deriveTimezoneFromGeography)' },
  intent: { label: 'Reply intent', family: 'SELLER', kind: 'category', source: 'message_events.detected_intent' },
  stage: { label: 'Stage', family: 'PIPELINE', kind: 'ordinal', source: 'canonical S1–S10 (UNIVERSAL_STAGE_ORDER)' },
  from_stage: { label: 'From stage', family: 'PIPELINE', kind: 'ordinal', source: 'acquisition_opportunity_history.previous_value' },
  actor: { label: 'Moved by', family: 'WORKFLOW', kind: 'category', source: 'history source/actor → autopilot / operator' },
  direction: { label: 'Direction', family: 'PIPELINE', kind: 'category', source: 'forward / backward by canonical stage index' },
  hold_class: { label: 'Run outcome', family: 'WORKFLOW', kind: 'category', source: 'seller_automation_executions status + block_reason → executed / send gate / auto-reply off / human review / policy / failed' },
  block_reason: { label: 'Hold reason', family: 'WORKFLOW', kind: 'category', source: 'seller_automation_executions.metadata.block_reason' },
  workflow: { label: 'Workflow', family: 'WORKFLOW', kind: 'category', source: 'seller_automation_executions.workflow_id' },
  buyer_kind: { label: 'Buyer kind', family: 'BUYER', kind: 'category', source: 'mv_comp_market_evidence.buyer_kind' },
  cohort: { label: 'Seller cohort', family: 'SELLER', kind: 'cohort', source: 'a funnel stage of the period (reached / replied / interested / opted out / became opportunity); every entity is narrowed to those sellers’ conversations' },
})

/**
 * SELLER COHORTS — a funnel stage used as a filter ("the 101 sellers who
 * replied"). Each is the exact entity set of a seller-grain registry metric in
 * the window being measured, so the cohort, its KPI and its records are one
 * set. Every other entity (messages, replies, stage moves, autopilot runs,
 * offers, closings) is narrowed to those sellers' conversations.
 */
export const COHORTS = Object.freeze({
  reached: { set: 'sellers_reached', label: 'Reached sellers', metric: 'sellers_reached' },
  replied: { set: 'reached_replied', label: 'Replied sellers', metric: 'reached_replied' },
  interested: { set: 'interested_sellers', label: 'Interested sellers', metric: 'interested_sellers' },
  opted_out: { set: 'opted_out_sellers', label: 'Opted-out sellers', metric: 'opted_out_sellers' },
  opportunity: { set: '__opp_repliers', label: 'Repliers who became opportunities', metric: 'opportunity_rate' },
})

/**
 * MONEY BASES — what each financial figure IS. Never summed into one number;
 * the client shows them side by side with their coverage. Read from the
 * canonical Pipeline Command read models (offers, readiness, lanes), the
 * property record and the closing desk. Current state, not the period.
 */
export const MONEY_BASES = Object.freeze([
  { id: 'asking', label: 'Seller asking', kind: 'stated', source: 'acquisition_opportunities.asking_price (Pipeline Command money.asking)', note: 'What the seller said. Implausible captures (under $5K, or under 5% of the reference value) are excluded and counted.' },
  { id: 'record', label: 'County / AVM estimate', kind: 'estimated', source: 'properties.estimated_value (the property record)', note: 'A county / automated estimate of the property, not an appraisal, not an offer and not revenue.' },
  { id: 'authorized', label: 'Authorized engine offer', kind: 'authorized', source: 'property_acquisition_scores.recommended_cash_offer where the canonical readiness rule says authorized', note: 'Decision Engine offers the spendability rule authorizes (valuation-offer-authority + persisted negotiation verdict). Modeled, not presented.' },
  { id: 'needs_validation', label: 'Engine offer — needs validation', kind: 'modeled', source: 'property_acquisition_scores where readiness = needs_validation', note: 'Priced by the engine but not spendable (tier, coverage or gates). Counted, never summed into value.' },
  { id: 'fee', label: 'Modeled assignment fee', kind: 'modeled', source: 'property_acquisition_scores.expected_assignment_fee (authorized deals only)', note: 'The engine’s expected assignment fee for authorized deals. Modeled, not expected revenue on a contract.' },
  { id: 'presented', label: 'Presented offers', kind: 'presented', source: 'seller_offers binding rows (sent / presented / pending / countered / accepted, not superseded)', note: 'Offers actually put in front of a seller.' },
  { id: 'contract', label: 'Contract value', kind: 'contracted', source: 'closing_cases.seller_contract_price (voided cases excluded)', note: 'Signed purchase price.' },
  { id: 'expected', label: 'Expected gross revenue', kind: 'expected', source: 'closing_cases.expected_gross_revenue', note: 'Revenue the closing desk expects on a contracted deal.' },
  { id: 'actual', label: 'Actual settled revenue', kind: 'actual', source: 'closing_cases.confirmed_gross_revenue (revenue confirmed)', note: 'Money actually received. Never estimated.' },
])

/**
 * EXTERNAL INTELLIGENCE — sources outside the operation (GROWTH). A source
 * is declared here with the metrics it would supply and the semantics they
 * carry; it reports `not_connected` until an adapter exists AND answers.
 * Nothing about it is drawn as data until then.
 */
export const EXTERNAL_SOURCES = Object.freeze([
  {
    id: 'search_console',
    family: 'GROWTH',
    label: 'Google Search Console',
    adapter: null,
    requires: [
      'A verified Search Console property for the LeadCommand site (domain or URL-prefix)',
      'A Google service credential with read access to that property, configured on the API',
      'A read adapter that answers with its own data-through date',
    ],
    metrics: [
      { id: 'gsc_clicks', label: 'Clicks', unit: 'count', definition: 'Clicks from Google Search results to the site.' },
      { id: 'gsc_impressions', label: 'Impressions', unit: 'count', definition: 'Times a site URL appeared in a search result the user saw.' },
      { id: 'gsc_ctr', label: 'CTR', unit: 'rate', definition: 'Clicks ÷ impressions, in the same window.' },
      { id: 'gsc_position', label: 'Average position', unit: 'position', definition: 'The mean of the topmost position the site held in results, weighted by impressions. It is not rank tracking: one query can have many positions, and fewer impressions can raise it.' },
    ],
    dimensions: ['query', 'page', 'country', 'device', 'date', 'search appearance'],
    freshness: 'Search Console reports with a 2–3 day lag; a connected source shows its own data-through date.',
  },
])
export function externalSources() {
  return EXTERNAL_SOURCES.map((s) => ({
    ...s,
    status: s.adapter ? 'connected' : 'not_connected',
    reason: s.adapter ? null : 'Not connected. No Search Console property or credential is configured on the API, and no read adapter exists yet — nothing is shown until the source answers.',
  }))
}

/**
 * FILTER FIELDS. Every field here is real (populated in production, measured
 * 2026-09-30 over the 12,120 properties ever messaged) AND viable: filters
 * apply to the period's ACTIVITY cohort (at most the period's messages,
 * replies, transitions and runs — 19,040 send rows in the whole corpus),
 * joined by primary key. Nothing here scans the 168K-row property universe.
 */
const OPS = {
  category: ['in', 'not_in', 'eq', 'neq', 'exists', 'missing'],
  number: ['gt', 'lt', 'between', 'eq', 'exists', 'missing'],
  boolean: ['is_true', 'is_false', 'exists', 'missing'],
  time: ['before', 'after', 'between'],
}
const f = (id, spec) => ({ id, operators: OPS[spec.type], viability: 'bounded_cohort', ...spec })
export const FILTER_FIELDS = Object.freeze([
  f('market', { family: 'GEOGRAPHY', label: 'Market', type: 'category', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '100% of messaged properties', source: 'properties.canonical_market_id' }),
  f('state', { family: 'GEOGRAPHY', label: 'State', type: 'category', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '100%', source: 'properties.property_address_state' }),
  f('county', { family: 'GEOGRAPHY', label: 'County', type: 'category', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '~100%', source: 'properties.property_address_county_name' }),
  f('zip', { family: 'GEOGRAPHY', label: 'ZIP', type: 'category', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '100%', source: 'properties.property_address_zip' }),
  f('property_type', { family: 'PROPERTY', label: 'Property type', type: 'category', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '100% (Single Family 8,874 · Multi-Family 3,017 · Apartment 200 · other 29)', source: 'properties.property_type' }),
  f('equity_percent', { family: 'PROPERTY', label: 'Equity %', type: 'number', unit: '%', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '~100%', source: 'properties.equity_percent' }),
  f('estimated_value', { family: 'PROPERTY', label: 'Estimated value', type: 'number', unit: '$', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '~100%', source: 'properties.estimated_value (county/AVM estimate, not an appraisal)' }),
  f('year_built', { family: 'PROPERTY', label: 'Year built', type: 'number', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '99%', source: 'properties.year_built' }),
  f('building_sqft', { family: 'PROPERTY', label: 'Building sq ft', type: 'number', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '100%', source: 'properties.building_square_feet' }),
  f('bedrooms', { family: 'PROPERTY', label: 'Bedrooms', type: 'number', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '99.7%', source: 'properties.total_bedrooms' }),
  f('units', { family: 'PROPERTY', label: 'Units', type: 'number', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '86%', source: 'properties.units_count' }),
  f('tax_delinquent', { family: 'PROPERTY', label: 'Tax delinquent', type: 'boolean', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '~100% (1,052 true)', source: 'properties.tax_delinquent' }),
  f('active_lien', { family: 'PROPERTY', label: 'Active lien', type: 'boolean', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '100%', source: 'properties.active_lien' }),
  f('ownership_years', { family: 'OWNER', label: 'Years owned', type: 'number', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '96%', source: 'properties.ownership_years' }),
  f('owner_type', { family: 'OWNER', label: 'Owner type', type: 'category', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '94%', source: 'properties.owner_type (casing normalised)' }),
  f('corporate_owner', { family: 'OWNER', label: 'Corporate owner', type: 'boolean', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '~100%', source: 'properties.is_corporate_owner' }),
  f('out_of_state_owner', { family: 'OWNER', label: 'Out-of-state owner', type: 'boolean', applies: ['seller', 'message', 'reply', 'opportunity', 'transition', 'run'], coverage: '~100%', source: 'properties.out_of_state_owner' }),
  f('campaign', { family: 'CAMPAIGN', label: 'Campaign', type: 'category', applies: ['seller', 'message', 'reply'], coverage: 'rows with a campaign_id', source: 'send_queue.campaign_id' }),
  f('campaign_source', { family: 'CAMPAIGN', label: 'Campaign source', type: 'category', applies: ['seller', 'message', 'reply'], coverage: 'campaign rows', source: 'campaigns.metadata.source' }),
  f('include_test_campaigns', { family: 'SYSTEM', label: 'Include test / proof campaigns', type: 'boolean', applies: ['seller', 'message', 'reply'], coverage: 'structural flags + name', source: 'campaigns.candidate_source / metadata proof flags / name', system: true }),
  f('sender', { family: 'SENDER', label: 'Sender number', type: 'category', applies: ['seller', 'message', 'reply'], coverage: '98% of sent rows (194 legacy rows have no sender)', source: 'send_queue.textgrid_number_id' }),
  f('template', { family: 'TEMPLATE', label: 'Template', type: 'category', applies: ['seller', 'message', 'reply'], coverage: '96% of sent rows', source: 'send_queue.template_id' }),
  f('template_use_case', { family: 'TEMPLATE', label: 'Template use case', type: 'category', applies: ['seller', 'message', 'reply'], coverage: 'rows with a catalogued template', source: 'sms_templates.use_case' }),
  f('touch', { family: 'COMMUNICATION', label: 'Touch number', type: 'number', applies: ['seller', 'message', 'reply'], coverage: 'campaign rows', source: 'send_queue.touch_number' }),
  f('disposition', { family: 'COMMUNICATION', label: 'Queue outcome', type: 'category', applies: ['message'], coverage: '100%', source: 'send_queue.queue_status (classified)' }),
  f('failure_class', { family: 'COMMUNICATION', label: 'Failure / hold class', type: 'category', applies: ['message'], coverage: '100%', source: 'queue_status + reasons + carrier bucket' }),
  f('intent', { family: 'SELLER', label: 'Reply intent', type: 'category', applies: ['reply'], coverage: '96% of replies classified', source: 'message_events.detected_intent' }),
  f('channel', { family: 'CHANNEL', label: 'Channel', type: 'category', applies: ['seller', 'message', 'reply'], coverage: 'SMS only', source: 'SMS (email has never sent)' }),
  f('origin', { family: 'SYSTEM', label: 'Send origin', type: 'category', applies: ['seller', 'message'], coverage: '100% (April–May legacy rows are "unlabelled")', source: 'send_queue.source / message_type' }),
  f('language', { family: 'COMMUNICATION', label: 'Message language', type: 'category', applies: ['seller', 'message'], coverage: 'rows with a language', source: 'send_queue.language' }),
  f('hour_local', { family: 'TIME', label: 'Hour (seller local)', type: 'number', applies: ['seller', 'message', 'reply'], coverage: 'rows with a resolvable property timezone', source: 'property state/ZIP → IANA timezone' }),
  f('weekday_local', { family: 'TIME', label: 'Weekday (seller local)', type: 'category', applies: ['seller', 'message', 'reply'], coverage: 'rows with a resolvable property timezone', source: 'property state/ZIP → IANA timezone' }),
  f('stage', { family: 'PIPELINE', label: 'Stage', type: 'category', applies: ['opportunity', 'transition'], coverage: '100%', source: 'canonical stage codes' }),
  f('hold_class', { family: 'WORKFLOW', label: 'Run outcome', type: 'category', applies: ['run'], coverage: '100%', source: 'seller_automation_executions' }),
])

/** Fields considered and NOT exposed, with the reason — shown in the builder so the absence is explained. */
export const NON_VIABLE_FIELDS = Object.freeze([
  { field: 'final_acquisition_score / ai_score / deal_strength_score / motivation scores', reason: 'Model scores are not facts; the Lab exposes no AI scores.' },
  { field: 'properties.normalized_asset_class / asset_type / property_group', reason: '0% populated on messaged properties.' },
  { field: 'properties.is_preforeclosure / foreclosure_status', reason: '0% populated on messaged properties.' },
  { field: 'properties.seller_tags_text', reason: '2.5% populated (299 of 12,120).' },
  { field: 'properties.timezone', reason: '2.5% populated; local time is derived from state/ZIP instead.' },
  { field: 'message body text search', reason: 'Would scan message bodies interactively; use Inbox search.' },
  { field: 'properties never contacted (the 168K universe)', reason: 'Analytics measures activity; the universe is Entity Graph’s domain.' },
  { field: 'email channel', reason: 'No email has ever been sent (sending is hard-off pending Brevo/DNS).' },
  { field: 'buyer_offers / buyer_agreements', reason: '0 rows in production.' },
  { field: 'BUYER family (buyer kind, buyer entity, repeat buyer)', reason: 'The recorded-transaction corpus (comp_private) is reachable only through the security-definer analytics_performance RPC, with its own ZIP geography; it is shown in BUYERS mode with its DATA-THROUGH date, but it cannot filter seller activity.' },
])

/** The v1 → lab-v2 change log, summarised for the inspector and the report. */
export const DEFINITION_CHANGES = Object.freeze(
  METRIC_REGISTRY.filter((x) => x.v1?.status === 'changed').map((x) => ({ metric: x.id, label: x.label, note: x.v1.note })),
)

/** A trimmed registry the client can hold (no functions). */
export function publicRegistry() {
  return {
    version: DEFINITION_VERSION,
    entities: ENTITIES,
    timeBases: TIME_BASES,
    metrics: METRIC_REGISTRY,
    dimensions: DIMENSION_REGISTRY,
    filters: FILTER_FIELDS,
    nonViable: NON_VIABLE_FIELDS,
    changes: DEFINITION_CHANGES,
    cohorts: Object.fromEntries(Object.entries(COHORTS).map(([k, v]) => [k, { label: v.label, metric: v.metric }])),
    money: MONEY_BASES,
    external: externalSources(),
  }
}

export default METRIC_REGISTRY
