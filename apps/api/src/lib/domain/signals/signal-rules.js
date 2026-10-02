/**
 * SIGNAL CENTER — built-in rule registry (v1).
 *
 * Code owns a rule's SEMANTICS (what it reads, how its condition is computed);
 * the signal_rules row owns whether it is ARMED (is_enabled) and may override
 * condition numbers. A row whose rule_key is not listed here is never evaluated
 * (there is no evaluator for it). Every rule is seeded DISARMED by the migration
 * (PROPOSED_20261001131000_signal_center.sql) with the same keys.
 *
 * Sources are only facts that exist in production today:
 *   event   the platform event envelope (listPlatformEvents) — source_system +
 *           envelope event_type. Never raw automation_events.
 *   metric  the Analytics Lab metric engine (evaluate/breakdown), per campaign or
 *           per sender number, honouring min_sample (insufficient_sample never fires).
 *   state   canonical state reads: queue processor health, the New Replies bucket.
 *   monitor IC monitor metrics — NO rule in v1 (the intelligence schema does not
 *           exist in production; nothing writes monitor rows).
 *
 * Not in v1 (and why):
 *   closing milestones on a watched seller/property — closing envelope events carry
 *   only the closing id (no seller / property ref), so a seller watch cannot match
 *   them without inventing a join. Watch the closing itself in a later version.
 */

export const NOTIFICATION_TYPES = Object.freeze({
  watch: 'signal_watch_activity',
  campaign: 'signal_campaign_health',
  sender: 'signal_sender_health',
  queue: 'signal_queue_stalled',
  backlog: 'signal_reply_backlog',
})

const rule = (r) => Object.freeze({ cooldown_seconds: 3600, replaces_legacy: [], condition: {}, ...r })

/** Rate-rule defaults: a trailing window vs the subject's own baseline (the window
 *  immediately before it). `floor`/`ceiling` are absolute; `min_shift_pts` + a
 *  significant two-proportion test is the relative trigger. settle_minutes ends the
 *  window early so sends still awaiting a carrier receipt do not read as undelivered. */
const RATE_DOWN = { window_hours: 24, settle_minutes: 30, baseline_days: 7, min_n: 30, direction: 'down', floor: 0.7, min_shift_pts: 15, alpha: 0.05, escalate_below: 0.5 }
const FILTER_UP = { window_hours: 24, baseline_days: 7, min_n: 30, direction: 'up', ceiling: 0.1, min_shift_pts: 8, alpha: 0.05, escalate_above: 0.25 }

export const BUILT_IN_RULES = Object.freeze([
  rule({
    rule_key: 'watch.seller_replied', label: 'Watched seller replied',
    description: 'A watched seller or property replied, asked for a call, opted out, or the reply was hostile / wrong person.',
    source_kind: 'event', event_source: 'inbox', scope: 'watched', severity: 'attention', cooldown_seconds: 0,
    event_types: ['seller.replied', 'seller.call_request', 'seller.hostile', 'seller.wrong_person', 'seller.opted_out'],
    notification_type: NOTIFICATION_TYPES.watch,
  }),
  rule({
    rule_key: 'watch.message_failed', label: 'Message to a watched seller failed',
    description: 'A conversation message to a watched seller or property failed to send or deliver.',
    source_kind: 'event', event_source: 'queue', scope: 'watched', severity: 'warning', cooldown_seconds: 0,
    event_types: ['message.failed'], notification_type: NOTIFICATION_TYPES.watch,
  }),
  rule({
    rule_key: 'watch.deal_movement', label: 'Watched deal moved',
    description: 'Stage moved, a deal opened, an offer was set or the seller countered on a watched seller or property.',
    source_kind: 'event', event_source: 'pipeline', scope: 'watched', severity: 'info', cooldown_seconds: 0,
    event_types: ['stage.advanced', 'stage.regressed', 'deal.opened', 'deal.status_changed', 'offer.generated', 'offer.countered'],
    notification_type: NOTIFICATION_TYPES.watch,
  }),
  rule({
    rule_key: 'watch.campaign_lifecycle', label: 'Watched campaign changed state',
    description: 'A watched campaign was blocked, paused, failed or completed.',
    source_kind: 'event', event_source: 'campaign', scope: 'watched', severity: 'attention', cooldown_seconds: 0,
    event_types: ['campaign.blocked', 'campaign.paused', 'campaign.failed', 'campaign.completed'],
    notification_type: NOTIFICATION_TYPES.watch,
  }),
  rule({
    rule_key: 'campaign.execution_exception', label: 'Campaign execution needs an operator',
    description: 'The campaign execution observatory reported a campaign run held, stalled, start-missed or failed.',
    source_kind: 'event', event_source: 'workflow', scope: 'campaign', severity: 'warning', cooldown_seconds: 3600,
    event_types: ['workflow.held', 'workflow.failed'], notification_type: NOTIFICATION_TYPES.campaign,
    replaces_legacy: ['campaign_stale_heartbeat', 'campaign_no_sends_despite_active'],
  }),
  rule({
    rule_key: 'campaign.delivery_rate_drop', label: 'Campaign delivery rate dropped',
    description: "Carrier-confirmed delivery over the trailing window fell below the floor, or significantly below the campaign's own baseline.",
    source_kind: 'metric', metric_id: 'delivery_rate', dimension: 'campaign', scope: 'dimension', severity: 'warning', cooldown_seconds: 21600,
    condition: RATE_DOWN, notification_type: NOTIFICATION_TYPES.campaign, replaces_legacy: ['campaign_delivery_rate_falling'],
  }),
  rule({
    rule_key: 'campaign.opt_out_rate_spike', label: 'Campaign opt-out rate spiked',
    description: "Reached sellers opting out over the trailing window rose above the ceiling, or significantly above the campaign's own baseline.",
    source_kind: 'metric', metric_id: 'opt_out_rate', dimension: 'campaign', scope: 'dimension', severity: 'warning', cooldown_seconds: 21600,
    condition: { window_hours: 72, baseline_days: 14, min_n: 30, direction: 'up', ceiling: 0.08, min_shift_pts: 4, alpha: 0.05, escalate_above: 0.12 },
    notification_type: NOTIFICATION_TYPES.campaign, replaces_legacy: ['campaign_opt_out_spike'],
  }),
  rule({
    rule_key: 'campaign.content_filter_spike', label: 'Campaign content filtering spiked',
    description: "Carrier spam/content filtering over the trailing window rose above the ceiling, or significantly above the campaign's own baseline.",
    source_kind: 'metric', metric_id: 'content_filter_rate', dimension: 'campaign', scope: 'dimension', severity: 'warning', cooldown_seconds: 21600,
    condition: FILTER_UP, notification_type: NOTIFICATION_TYPES.campaign,
  }),
  rule({
    rule_key: 'sender.delivery_degraded', label: 'Sender number delivery degraded',
    description: "A sender number's carrier-confirmed delivery fell below the floor or significantly below its own baseline.",
    source_kind: 'metric', metric_id: 'delivery_rate', dimension: 'sender', scope: 'dimension', severity: 'warning', cooldown_seconds: 21600,
    condition: RATE_DOWN, notification_type: NOTIFICATION_TYPES.sender, replaces_legacy: ['sender_delivery_spike_failure'],
  }),
  rule({
    rule_key: 'sender.content_filter_spike', label: 'Sender number content filtering spiked',
    description: "A sender number's carrier spam/content filtering rose above the ceiling or significantly above its own baseline.",
    source_kind: 'metric', metric_id: 'content_filter_rate', dimension: 'sender', scope: 'dimension', severity: 'critical', cooldown_seconds: 21600,
    condition: FILTER_UP, notification_type: NOTIFICATION_TYPES.sender, replaces_legacy: ['sender_content_filter_spike'],
  }),
  rule({
    rule_key: 'queue.stalled', label: 'Send queue stalled',
    description: 'Due sends are lagging or stale while the queue processor is live (queue processor health: degraded).',
    source_kind: 'state', state_id: 'queue_processor', scope: 'global', severity: 'critical', cooldown_seconds: 3600,
    notification_type: NOTIFICATION_TYPES.queue, replaces_legacy: ['platform_queue_processor_degraded', 'campaign_pacing_behind'],
  }),
  rule({
    rule_key: 'inbox.new_replies_backlog', label: 'New Replies backlog',
    description: 'Seller replies are waiting in New Replies longer than the allowed wait.',
    source_kind: 'state', state_id: 'new_replies_backlog', scope: 'global', severity: 'attention', cooldown_seconds: 3600,
    condition: { max_wait_minutes: 120, min_threads: 1 }, notification_type: NOTIFICATION_TYPES.backlog,
  }),
])

export const RULES_BY_KEY = Object.freeze(Object.fromEntries(BUILT_IN_RULES.map((r) => [r.rule_key, r])))

/**
 * Legacy notification-scanner checks and what retires them. Counter-based
 * campaign checks read denormalised campaigns.*_count columns (historically wrong:
 * reply/opt-out counts were always 0). `replacement: null` = retire without a
 * signal replacement (owner decision), listed so nothing is silently dropped.
 */
export const LEGACY_SCAN_RETIREMENT = Object.freeze([
  { legacy: 'campaign_delivery_rate_falling', scanner: 'scanCampaignNotifications', basis: 'campaigns.delivered_count / sent_count (lifetime counters)', replacement: 'campaign.delivery_rate_drop' },
  { legacy: 'campaign_opt_out_spike', scanner: 'scanCampaignNotifications', basis: 'campaigns.opt_out_count / sent_count (lifetime counters)', replacement: 'campaign.opt_out_rate_spike' },
  { legacy: 'campaign_stale_heartbeat', scanner: 'scanCampaignNotifications', basis: 'campaigns.execution_heartbeat_at age', replacement: 'campaign.execution_exception' },
  { legacy: 'campaign_no_sends_despite_active', scanner: 'scanCampaignNotifications', basis: 'campaigns.sent_count = 0 (counter)', replacement: 'campaign.execution_exception' },
  { legacy: 'campaign_pacing_behind', scanner: 'scanCampaignNotifications', basis: 'campaigns.queued_count vs sent_count (counters)', replacement: 'queue.stalled' },
  { legacy: 'campaign_daily_cap_hit', scanner: 'scanCampaignNotifications', basis: 'lifetime sent_count compared with a DAILY cap (wrong unit)', replacement: null },
  { legacy: 'campaign_reply_rate_strong', scanner: 'scanCampaignNotifications', basis: 'campaigns.replied_count (counter, historically 0)', replacement: null },
  { legacy: 'sender_delivery_spike_failure', scanner: 'scanSenderHealthNotifications', basis: 'message_events 48h, own failure-rate math', replacement: 'sender.delivery_degraded' },
  { legacy: 'sender_content_filter_spike', scanner: 'scanSenderHealthNotifications', basis: 'v1 content-block regex (Lab: missed every carrier spam filter)', replacement: 'sender.content_filter_spike' },
  { legacy: 'platform_queue_processor_degraded', scanner: 'scanPlatformHealthNotifications', basis: 'queue processor health = degraded', replacement: 'queue.stalled' },
])

/** Effective rule = code definition + the row's arming and condition overrides. */
export function effectiveRule(def, row = null) {
  const overrides = row?.condition && typeof row.condition === 'object' ? row.condition : {}
  return {
    ...def,
    id: row?.id ?? null,
    is_enabled: row?.is_enabled === true,
    severity: row?.severity && ['info', 'attention', 'warning', 'critical'].includes(row.severity) ? row.severity : def.severity,
    cooldown_seconds: Number.isFinite(Number(row?.cooldown_seconds)) ? Number(row.cooldown_seconds) : def.cooldown_seconds,
    condition: { ...def.condition, ...overrides },
  }
}
