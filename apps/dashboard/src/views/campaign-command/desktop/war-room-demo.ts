/**
 * DEMO DATA — development only, `?demo=1`, clearly labelled on screen.
 *
 * Production has no campaign sending at the moment this was built (every
 * live campaign is stalled or waiting for its window), so the states the war
 * room must show — a live refill, a daily cap reached, a window about to
 * open — cannot be seen on real data. These fixtures drive the SAME
 * components through the SAME model; every action is disabled while they are
 * on screen. Loaded with a dynamic import behind `import.meta.env.DEV`, so it
 * never ships in a production bundle.
 */
import type { CockpitRead, CockpitTargetRow } from './cockpit-api'
import type { BookCampaign, CampaignGeo, CampaignIntel, CommandBook, FleetNumber, ReplyBook, ReplyBucketKey, SeriesBucket } from './war-room-api'

const H = 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
/** deterministic noise in [0,1) — never Math.random: the demo is reproducible */
const noise = (i: number) => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x) }

type Spec = {
  id: string
  name: string
  status: string
  kind: string
  explicit?: number | null
  tz: string
  open: boolean
  total: number
  ready: number
  planned: number
  held: number
  heldBy?: Record<string, number>
  queue?: number
  due?: number
  sent: number
  delivered: number
  replies: number
  buckets?: Partial<Record<'interested' | 'not_interested' | 'wrong_number' | 'opt_out' | 'ambiguous' | 'other', number>>
  feeder?: Partial<NonNullable<BookCampaign['feeder']>> | null
  scheduledFor?: number | null
  missedFor?: number | null
  activatedHoursAgo?: number | null
  dailyCap?: number
  market: string
}

/** the next time the local clock in `tz` reads `minutes` past midnight */
function nextLocal(tz: string, now: number, minutes: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
  const at = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const ahead = (minutes - at + 1440) % 1440
  return now + (ahead || 1440) * 60_000
}

function windowOf(open: boolean, tz: string, now: number) {
  return open
    ? { open: true, reason: 'in_window', window: '08:00–21:00', closes_at: iso(nextLocal(tz, now, 21 * 60)), next_open_at: null, timezone: tz, source: 'campaign' as const, policy_version: 'contact_window_v1_0800_2100_local_fail_closed' }
    : { open: false, reason: 'before_window', window: '08:00–21:00', closes_at: null, next_open_at: iso(nextLocal(tz, now, 8 * 60)), timezone: tz, source: 'campaign' as const, policy_version: 'contact_window_v1_0800_2100_local_fail_closed' }
}

function feeder(now: number, over: Partial<NonNullable<BookCampaign['feeder']>> = {}): NonNullable<BookCampaign['feeder']> {
  return {
    at: iso(now - 4 * 60_000 - 22_000), inserted: 100, bound: 'buffer', reason: null, stalled: false, ready_remaining: 83, active_live_rows: 117,
    sent_today: 214, batch_limit: 100, spam_retries: 0, last_refill_at: iso(now - 4 * 60_000 - 22_000), skipped_counts_by_reason: {}, skip_summary: null, routing_blocks_by_market: {},
    ...over,
  }
}

const zeroBuckets = { interested: 0, not_interested: 0, wrong_number: 0, opt_out: 0, ambiguous: 0, other: 0 }

function bookRow(s: Spec, now: number): BookCampaign {
  return {
    id: s.id, name: s.name, status: s.status, archived: false, created_at: iso(now - 80 * H), updated_at: iso(now - 60_000),
    source: { kind: s.kind, explicit_count: s.explicit ?? null, area_property_count: s.kind === 'map_area' ? s.explicit ?? null : null, filter_count: s.kind === 'filters' ? 2 : 0, market_values: [] },
    timezone: s.tz, window: windowOf(s.open, s.tz, now),
    schedule: { scheduled_for: s.scheduledFor ? iso(s.scheduledFor) : null, missed_for: s.missedFor ? iso(s.missedFor) : null, activated_at: s.activatedHoursAgo ? iso(now - s.activatedHoursAgo * H) : null, paused_at: null, resumed_at: null, completed_at: s.status === 'completed' ? iso(now - 30 * H) : null, last_transition_reason: null },
    caps: { daily_cap: s.dailyCap ?? 750, total_cap: 1000 },
    targets: { total: s.total, ready: s.ready, planned: s.planned, held: s.held, other: 0, held_by_reason: s.heldBy ?? (s.held ? { entity_contact_requires_review: Math.round(s.held * 0.8), missing_identity_linkage: s.held - Math.round(s.held * 0.8) } : {}) },
    queue: { live: s.queue ?? 0, due: s.due ?? 0, overdue: 0, next_at: s.queue ? iso(now + 38_000) : null },
    sends: { sellers_dispatched: s.sent, sellers_delivered: s.delivered, last_sent_at: s.sent ? iso(now - 14_000) : null, sent_today: s.sent ? Math.min(s.sent, 214) : 0, truncated: false },
    replies: { sellers_replied: s.replies, sellers_asked_to_stop: s.buckets?.opt_out ?? 0, buckets: { ...zeroBuckets, ...s.buckets }, latest_reply_at: s.replies ? iso(now - 26 * 60_000) : null, truncated: false },
    feeder: s.feeder === null ? null : feeder(now, s.feeder ?? {}),
    quarantined: false,
  }
}

function fleet(now: number, market: string, campaignSent: number): FleetNumber[] {
  const base = (phone: string, label: string, mkt: string, state: FleetNumber['state'], sentToday: number, carrying: boolean, i: number): FleetNumber => ({
    phone, label, market: mkt, in_campaign_market: mkt === market, status: state === 'paused' ? 'paused' : 'active', health_state: state === 'cooling' ? 'cooling' : 'unverified',
    health_reason: state === 'cooling' ? 'spam_flagged_operator_note' : 'no_structured_health_evidence', cooling_until: null, spam_flagged_at: state === 'cooling' ? iso(now - 20 * 24 * H) : null,
    state, state_reason: state === 'blocked' ? 'blocked_by_operator' : null, eligible: state === 'unverified' || state === 'active', daily_limit: 800, limit: 800, limit_basis: 'system',
    sent_today: sentToday, router_counter: sentToday + (i === 0 ? 207 : 0), remaining_today: state === 'unverified' ? 800 - sentToday : 0,
    campaign: {
      carrying, queued: carrying ? 39 : 0, sent_today: carrying ? Math.round(sentToday * 0.92) : 0, last_sent_at: carrying ? iso(now - (14 + i * 9) * 1000) : null,
      left_us: carrying ? Math.round(campaignSent / 3) : 0, delivered: carrying ? Math.round((campaignSent / 3) * 0.957) : 0, filtered: carrying ? 4 : 0, failed: carrying ? 2 : 0,
      sellers: carrying ? Math.round(campaignSent / 3) : 0, sellers_replied: carrying ? 6 : 0, sample_ok: carrying,
    },
    last_used_at: iso(now - 30_000),
  })
  return [
    base('+16125092623', 'MINNEAPOLIS 3', market, 'unverified', 421, true, 0),
    base('+16125092382', 'MINNEAPOLIS 2', market, 'unverified', 233, true, 1),
    base('+16128060495', 'MINNEAPOLIS', market, 'unverified', 46, true, 2),
    base('+13058975670', 'MIAMI', 'Miami, FL', 'blocked', 0, false, 3),
    base('+17866052999', 'MIAMI (cooling)', 'Miami, FL', 'cooling', 0, false, 4),
    base('+13057604780', 'MIAMI 2', 'Miami, FL', 'paused', 0, false, 5),
  ]
}

function series(now: number, sent: number, delivered: number, replies: number): { grain: 'hour'; step_ms: number; start: string; buckets: SeriesBucket[] } {
  const step = H
  const start = Math.floor((now - 30 * H) / step) * step
  const n = Math.floor((now - start) / step) + 1
  const buckets: SeriesBucket[] = []
  let s = 0; let d = 0; let r = 0
  for (let i = 0; i < n; i += 1) {
    const t = start + i * step
    const hourCt = new Date(t).getUTCHours() - 5
    const inWindow = ((hourCt + 24) % 24) >= 8 && ((hourCt + 24) % 24) < 21
    const sendsHere = inWindow ? Math.round(16 + noise(i) * 14) : 0
    const take = Math.min(sendsHere, sent - s)
    const del = Math.min(Math.round(take * 0.955), delivered - d)
    const rep = inWindow && noise(i + 7) > 0.55 ? 1 + (noise(i + 3) > 0.8 ? 1 : 0) : 0
    const repHere = Math.max(0, Math.min(rep, replies - r))
    s += take; d += del; r += repHere
    buckets.push({ t: iso(t), queued: inWindow ? Math.round(take * 1.05) : 0, sent: take, delivered: del, failed: take - del, replies: repHere })
  }
  return { grain: 'hour', step_ms: step, start: iso(start), buckets }
}

function slimIntel(s: Spec, now: number): CampaignIntel {
  return {
    ok: true, campaign_id: s.id, at: iso(now), timezone: s.tz, day_start: iso(now - 9 * H),
    rows: { total: 0, read: 0, truncated: false, campaign_texts: 0, conversation: 0, proof: 0 },
    sellers: { left_us: 0, delivered: 0, replied: 0 },
    delivery: { total: 0, left_us: 0, accepted: 0, delivered: 0, awaiting_receipt: 0, filtered: 0, invalid_destination: 0, soft_bounce: 0, carrier_dnc: 0, carrier_undelivered: 0, provider_refused: 0, held_at_send: 0, expired_unsent: 0, cancelled: 0, waiting: 0, other: 0, classes: {}, receipt_lag: 0, carrier_verdicts_truncated: false },
    retries: { originals_filtered: 0, recycled: 0, no_retry: 0, retry_rows: 0, retry_delivered: 0, retry_filtered: 0, retry_failed: 0, retry_waiting: 0, no_retry_reasons: {} },
    series: null,
    batches: { list: [], placed_passes: 0, empty_passes: 0, latest_pass: null },
    feeder: { buffer_target: 150, chunk: 100 },
    replies: { sellers_messaged: 0, sellers_replied: 0, reply_messages: 0, sellers_asked_to_stop: 0, truncated: false, buckets: { ...zeroBuckets }, intents: {}, list: [] },
    outcomes: { basis: 'replied_sellers', opportunities: [], stage_moves: 0, opportunities_moved: 0, offers: [], closings: [] },
    templates: [],
    fleet: { numbers: fleet(now, s.market, 0).map((n) => ({ ...n, in_campaign_market: n.market === s.market, campaign: { ...n.campaign, carrying: false, queued: 0, sent_today: 0, last_sent_at: null, left_us: 0, delivered: 0, filtered: 0, failed: 0, sellers: 0, sellers_replied: 0, sample_ok: false } })), system_cap: 800, campaign_cap: null, blocked_count: 8, today_truncated: false },
    routing: [{ market: s.market, targets: s.total, ready: s.ready, numbers: s.market === 'Miami, FL' ? 3 : 1, eligible: s.market === 'Miami, FL' ? 0 : 1, by_state: s.market === 'Miami, FL' ? { blocked: 1, cooling: 1, paused: 1 } : { unverified: 1 }, remaining_today: s.market === 'Miami, FL' ? 0 : 800 }],
    audience: { total: s.total, truncated: false, markets: { [s.market]: s.total }, ready_by_market: { [s.market]: s.ready }, zones: { [s.tz]: s.total } },
    caps: { daily_cap: s.dailyCap ?? 750, total_cap: 1000, market_cap: 400, batch_max: 100, per_sender_cap: null, system_per_number_cap: 800, send_interval_seconds: 45 },
    unavailable: [],
  }
}

function intel(s: Spec, now: number): CampaignIntel {
  if (!s.sent) return slimIntel(s, now)
  const left = Math.round(s.sent * 1.03)
  return {
    ok: true, campaign_id: s.id, at: iso(now), timezone: s.tz, day_start: iso(now - 9 * H),
    rows: { total: left + (s.queue ?? 0) + 60, read: left + (s.queue ?? 0) + 60, truncated: false, campaign_texts: left + (s.queue ?? 0) + 48, conversation: 12, proof: 0 },
    sellers: { left_us: s.sent, delivered: s.delivered, replied: s.replies },
    delivery: {
      total: left + (s.queue ?? 0) + 48, left_us: left, accepted: left, delivered: s.delivered + 6, awaiting_receipt: 5, filtered: 6, invalid_destination: 3, soft_bounce: 1, carrier_dnc: 0, carrier_undelivered: 2,
      provider_refused: 1, held_at_send: 4, expired_unsent: 0, cancelled: 12, waiting: s.queue ?? 0, other: 0, classes: {}, receipt_lag: 0, carrier_verdicts_truncated: false,
    },
    retries: { originals_filtered: 9, recycled: 9, no_retry: 4, retry_rows: 9, retry_delivered: 7, retry_filtered: 1, retry_failed: 0, retry_waiting: 1, no_retry_reasons: { 'Hard Bounce': 3, Other: 1 } },
    series: series(now, s.sent, s.delivered, s.replies),
    batches: {
      list: [17, 16, 15].map((n, i) => ({
        n, run_id: `demo-run-${n}`, started_at: iso(now - (i * 2 + 0.07) * H), finished_at: iso(now - (i * 2 + 0.07) * H + 3.7 * 60_000), duration_ms: i === 0 ? 222_000 : 31_000 + i * 900,
        ready: 183 - i * 100, planned: 100, created: 100, matched_rows: 100, blocked_counts: (i === 0 ? { per_sender_cap_reached: 4 } : {}) as Record<string, number>,
        senders: [{ value: '+16125092623', count: 48 }, { value: '+16125092382', count: 37 }, { value: '+16128060495', count: 15 }], templates: 9,
        outcome: i === 0 ? { queued_now: 7, left_us: 93, delivered: 91, filtered: 1, failed: 1, held: 0, cancelled: 0, replied: 4 } : { queued_now: 0, left_us: 100, delivered: 96, filtered: 2, failed: 2, held: 0, cancelled: 0, replied: 6 - i },
      })),
      placed_passes: 17, empty_passes: 212, latest_pass: null,
    },
    feeder: { buffer_target: 150, chunk: 100 },
    replies: {
      sellers_messaged: s.sent, sellers_replied: s.replies, reply_messages: s.replies + 9, sellers_asked_to_stop: s.buckets?.opt_out ?? 0, truncated: false,
      buckets: { ...zeroBuckets, ...s.buckets }, intents: {},
      list: Array.from({ length: s.replies }, (_, i) => {
        const keys = Object.entries({ ...zeroBuckets, ...s.buckets }).flatMap(([k, n]) => Array.from({ length: n }, () => k))
        const bucket = (keys[i] ?? 'ambiguous') as ReplyBucketKey
        return {
          seller_phone: `+1612555${String(1000 + i).slice(-4)}`, seller_name: ['M. Halvorsen', 'D. Okafor', 'R. Lindqvist', 'J. Abdi', 'K. Nguyen', 'T. Brennan'][i % 6], intent: bucket === 'interested' ? 'asks_offer' : bucket === 'not_interested' ? 'not_interested' : bucket === 'wrong_number' ? 'wrong_number' : bucket === 'opt_out' ? 'opt_out' : 'unclear',
          bucket, asked_to_stop: bucket === 'opt_out', thread_key: null, message: bucket === 'interested' ? 'What would you offer?' : bucket === 'not_interested' ? 'Not selling right now.' : null,
          first_reply_at: iso(now - (i * 1.7 + 0.4) * H), latest_reply_at: iso(now - (i * 1.7 + 0.4) * H), messages: 1,
        }
      }),
    },
    outcomes: {
      basis: 'replied_sellers',
      opportunities: [
        { id: 'demo-opp-1', thread_key: null, master_owner_id: null, property_id: null, stage: 'offer', status: 'active', created_at: iso(now - 20 * H), recommended_offer: 168600, current_offer: null, latest_intent: 'asks_offer', seller: 'M. Halvorsen', address: '4321 Garfield Ave S', moves: [{ from: 'asking_price', to: 'offer', at: iso(now - 3 * H), actor: 'autopilot' }] },
        { id: 'demo-opp-2', thread_key: null, master_owner_id: null, property_id: null, stage: 'property_condition', status: 'active', created_at: iso(now - 14 * H), recommended_offer: 150400, current_offer: null, latest_intent: 'asking_price_provided', seller: 'D. Okafor', address: '2810 Columbus Ave', moves: [{ from: 'offer_interest', to: 'property_condition', at: iso(now - 6 * H), actor: 'autopilot' }] },
        { id: 'demo-opp-3', thread_key: null, master_owner_id: null, property_id: null, stage: 'offer_interest', status: 'active', created_at: iso(now - 5 * H), recommended_offer: null, current_offer: null, latest_intent: 'interested', seller: 'R. Lindqvist', address: '1907 Bryant Ave N', moves: [{ from: 'ownership_confirmation', to: 'offer_interest', at: iso(now - 2 * H), actor: 'autopilot' }] },
      ],
      stage_moves: 3, opportunities_moved: 3,
      offers: [{ id: 'demo-offer-1', opportunity_id: 'demo-opp-1', status: 'sent', type: 'cash', direction: 'outbound', price: 161000, sent_at: iso(now - 2 * H), accepted_at: null, accepted_price: null }],
      closings: [],
    },
    templates: [
      { template_id: '211393', name: 'Ownership check · v8', use_case: 'ownership_check', language: 'English', stage_code: 'S1', variant_group: 'S1|ownership_check|English', asset_scope: 'Any Residential', active: true, blocked_by_operator: false, quarantined: false, quarantine_reason: null, attempted: 142, delivered: 135, filtered: 3, failed: 4, sellers_first_reached: 131, sellers_replied: 9, sample_ok: true },
      { template_id: '840902', name: 'Ownership check · correct contact v3', use_case: 'ownership_check', language: 'English', stage_code: 'S1', variant_group: 'S1|ownership_check|English', asset_scope: 'Single family', active: true, blocked_by_operator: false, quarantined: false, quarantine_reason: null, attempted: 96, delivered: 92, filtered: 1, failed: 3, sellers_first_reached: 90, sellers_replied: 6, sample_ok: true },
      { template_id: '204513', name: 'Local investor opener', use_case: 'ownership_check', language: 'English', stage_code: 'S1', variant_group: 'S1|ownership_check|English', asset_scope: 'Any Residential', active: true, blocked_by_operator: true, quarantined: false, quarantine_reason: null, attempted: 12, delivered: 2, filtered: 10, failed: 0, sellers_first_reached: 2, sellers_replied: 0, sample_ok: false },
    ],
    fleet: { numbers: fleet(now, s.market, s.sent), system_cap: 800, campaign_cap: null, blocked_count: 8, today_truncated: false },
    routing: [{ market: s.market, targets: s.total, ready: s.ready, numbers: 3, eligible: 3, by_state: { unverified: 3 }, remaining_today: 1100 }],
    audience: { total: s.total, truncated: false, markets: { [s.market]: s.total }, ready_by_market: { [s.market]: s.ready }, zones: { [s.tz]: s.total } },
    caps: { daily_cap: s.dailyCap ?? 750, total_cap: 1000, market_cap: 400, batch_max: 100, per_sender_cap: null, system_per_number_cap: 800, send_interval_seconds: 45 },
    unavailable: [],
  }
}

function core(s: Spec, now: number): CockpitRead {
  const b = bookRow(s, now)
  return {
    ok: true, campaign_id: s.id, at: iso(now), name: s.name, status: s.status,
    lineage: {
      kind: s.kind as CockpitRead['lineage']['kind'], declared_source: s.kind, explicit_property_count: s.explicit ?? null,
      area: s.kind === 'map_area' ? { bbox: [-93.32, 44.97, -93.27, 45.06], vertices: 68, truncated: false, property_count: s.explicit ?? null, label: null, polygon_stored: false } : null,
      handoff_mode: null, filters: s.kind === 'filters' ? [{ domain: 'properties', field_key: 'properties.final_acquisition_score', category: 'Distress & Motivation', operator: 'gte', value: { kind: 'text', value: '75' } }] : [],
      market_values: [], timezone: s.tz, stage_code: 'S1', template_use_case: 'ownership_check', campaign_type: 'outbound_sms', channel: 'sms',
    },
    lifecycle: { created_at: iso(now - 80 * H), scheduled_for: b.schedule?.scheduled_for ?? null, activated_at: b.schedule?.activated_at ?? null, paused_at: null, resumed_at: null, completed_at: b.schedule?.completed_at ?? null, last_transition_reason: null, last_transition_at: null, execution_heartbeat_at: iso(now - 260_000), schedule_missed_for: b.schedule?.missed_for ?? null, schedule_missed_at: null },
    flags: { auto_queue_enabled: true, auto_send_enabled: false, auto_reply_mode: null, emergency_stop_at: null, production_launch: true, quarantine: null },
    caps: { daily_cap: s.dailyCap ?? 750, total_cap: 1000, market_cap: 400, per_sender_cap: null, configured_per_number_cap: 800, batch_max: 100, send_interval_seconds: 45 },
    targets: { total: s.total, by_status: { planned: s.planned, ready: s.ready, blocked: s.held }, held_by_reason: b.targets!.held_by_reason, advisories: {}, ready: s.ready, held: s.held, committed: s.planned },
    send_states: { by_status: {}, sent: s.sent, delivered: s.delivered, failed: 0 },
    queue: s.queue ? { live: s.queue, due: s.due ?? 0, overdue: 0, oldest_due_at: null, next_scheduled_at: iso(now + 38_000), release_reasons: {}, last_claimed_at: iso(now - 40_000), last_released_at: null, last_release_reason: null, proof: 0, by_status: { scheduled: s.queue }, processing: 2, spam_retries: 1, latest_scheduled_at: iso(now + 2 * H), by_sender: {}, truncated: false } : { live: 0, due: 0, overdue: 0, oldest_due_at: null, next_scheduled_at: null, release_reasons: {}, proof: 0, by_status: {}, processing: 0, spam_retries: 0, latest_scheduled_at: null, by_sender: {}, truncated: false },
    sends: { sent_today: Math.min(s.sent, 214), day_start: iso(now - 9 * H), day_timezone: s.tz, day_timezone_basis: 'campaign', last_sent_at: s.sent ? iso(now - 14_000) : null, first_sent_at: s.sent ? iso(now - 50 * H) : null, failed_last_hour: 1 },
    feed: { limit: 33, bound: s.feeder?.bound ?? 'buffer', buffer_need: 33, daily_remaining: 536, total_remaining: 580, buffer_target: 150, chunk: 100 },
    window: windowOf(s.open, s.tz, now),
    processor: { mode: 'live', execution_mode: 'normal', auto_send: true, auto_enqueue: true, outbound_sms: true, emergency_stop_at: null, heartbeat_at: iso(now - 31_000), last_claimed_at: iso(now - 40_000) },
    feeder: { heartbeat_at: iso(now - 4 * 60_000 - 22_000), last_batch_at: iso(now - 4 * 60_000 - 22_000), campaign_last: b.feeder ? { at: b.feeder.at, inserted: b.feeder.inserted, bound: b.feeder.bound, reason: b.feeder.reason, stalled: b.feeder.stalled, ready_remaining: b.feeder.ready_remaining, active_live_rows: b.feeder.active_live_rows, last_refill_at: b.feeder.last_refill_at, skipped_counts_by_reason: b.feeder.skipped_counts_by_reason, skip_summary: null, routing_blocks_by_market: {} } : null },
    senders: [], email: { campaign_rows: 0, sender_identities: 0 },
    responses: { sellers_messaged: s.sent, sellers_replied: s.replies, reply_messages: s.replies + 9, sellers_asked_to_stop: s.buckets?.opt_out ?? 0, latest_reply_at: iso(now - 26 * 60_000), truncated: false, intents: {}, latest: [] },
    exceptions: null,
    geography: { markets: [{ market: s.market, state: s.market.slice(-2), targets: s.total }], market_count: 1, total: s.total, truncated: false },
    timeline: {
      events: [
        { id: 'demo-ev-1', type: 'campaign.activated', severity: 'success', title: 'Campaign activated', description: null, at: iso(now - 50 * H), rows_created: null, blockers: [] },
        { id: 'demo-ev-2', type: 'campaign.targets_built', severity: 'success', title: 'Targets built', description: null, at: iso(now - 51 * H), rows_created: null, blockers: [] },
      ],
      idle_feeder_checks: { count: 212, last_at: iso(now - 9 * 60_000) },
    },
    unavailable: [],
  }
}

function geo(s: Spec): CampaignGeo {
  const states: CampaignGeo['states'] = ['held', 'ready', 'planned', 'queued', 'sent', 'delivered', 'failed', 'replied', 'opportunity']
  const points: Array<[number, number, number]> = []
  for (let i = 0; i < s.total; i += 1) {
    // a drawn area: a skewed lens north of downtown
    const a = noise(i) * Math.PI * 2
    const r = Math.sqrt(noise(i + 101))
    const lat = 45.015 + Math.sin(a) * r * 0.042
    const lng = -93.295 + Math.cos(a) * r * 0.026 + (lat - 45.015) * 0.18
    const x = noise(i + 33)
    const st = i < s.held ? 0 : x < 0.04 ? 8 : x < 0.07 ? 7 : x < 0.1 ? 6 : x < 0.62 ? 5 : x < 0.7 ? 4 : x < 0.86 ? 3 : 1
    points.push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5, st])
  }
  return { ok: true, campaign_id: s.id, states, total_targets: s.total, sampled: false, located: s.total, unlocated: 0, rows_truncated: false, points, counties: [{ county: 'Hennepin', state: 'MN', targets: s.total, held: s.held, sent: s.sent, delivered: s.delivered, replied: s.replies, failed: 9, opportunities: 3 }], county_count: 1 }
}

const FIRST = ['Linda', 'James', 'Maria', 'Robert', 'Patricia', 'Michael', 'Barbara', 'David', 'Susan', 'Thomas', 'Karen', 'Daniel', 'Nancy', 'Paul', 'Sandra', 'Mark']
const LAST = ['Olson', 'Nguyen', 'Peterson', 'Hansen', 'Garcia', 'Larson', 'Anderson', 'Schmidt', 'Carlson', 'Johnson', 'Moua', 'Lindqvist']
const STREET = ['Lyndale Ave S', 'Bryant Ave N', 'E Lake St', 'Penn Ave N', 'Chicago Ave', 'Nicollet Ave', 'Cedar Ave S', 'W 38th St', 'Fremont Ave N', 'Bloomington Ave']
const REPLY_INTENT: Record<string, string> = { interested: 'interested', not_interested: 'not_interested', wrong_number: 'wrong_number', opt_out: 'opt_out', ambiguous: 'unclear', other: 'who_is_this' }

/** One row per target, in the cohort's real proportions: held, then texted, then queued, then ready. */
function targetsOf(s: Spec, now: number): CockpitTargetRow[] {
  const replyQueue = Object.entries(s.buckets ?? {}).flatMap(([k, n]) => Array.from({ length: n ?? 0 }, () => REPLY_INTENT[k] ?? 'unclear'))
  const heldCodes = Object.entries(s.heldBy ?? (s.held ? { entity_contact_requires_review: Math.round(s.held * 0.8), missing_identity_linkage: s.held - Math.round(s.held * 0.8) } : {}))
    .flatMap(([code, n]) => Array.from({ length: n }, () => code))
  const queued = s.queue ?? 0
  const area = s.market.endsWith('MN') ? '612' : s.market.endsWith('TX') ? '214' : s.market.endsWith('FL') ? '305' : s.market.endsWith('GA') ? '404' : '213'
  const out: CockpitTargetRow[] = []
  for (let i = 0; i < s.total; i += 1) {
    const sellerName = `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`
    const phone = `+1${area}555${String(100 + (i % 100)).padStart(4, '0')}`
    let status = 'ready'
    let block: string | null = null
    let queue: CockpitTargetRow['queue'] = null
    let reply: CockpitTargetRow['reply'] = null
    const j = i - s.held
    if (i < s.held) { status = 'blocked'; block = heldCodes[i] ?? 'entity_contact_requires_review' }
    else if (j < s.sent) {
      status = 'planned'
      const sentAt = now - (s.sent - j) * 6 * 60_000
      const ok = j < s.delivered
      queue = { id: `${s.id}-q${i}`, status: ok ? 'delivered' : j % 3 === 0 ? 'failed' : 'failed_transport', scheduled_for: iso(sentAt - 40_000), sent_at: iso(sentAt), delivered_at: ok ? iso(sentAt + 9_000) : null, reason: ok ? null : 'carrier_rejected', from: `+1${area}5550${String(10 + (j % 4)).padStart(3, '0')}`, updated_at: iso(sentAt + 9_000) }
      if (ok && j % Math.max(1, Math.floor(s.delivered / Math.max(1, replyQueue.length))) === 0 && replyQueue.length) {
        const intent = replyQueue.shift() as string
        reply = { at: iso(sentAt + 41 * 60_000), intent, thread_key: `${s.id}-t${i}`, asked_to_stop: intent === 'opt_out', messages: 1 + (i % 3) }
      }
    } else if (j < s.sent + queued) {
      status = 'planned'
      const k = j - s.sent
      queue = { id: `${s.id}-q${i}`, status: 'queued', scheduled_for: iso(now + (k + 1) * 20_000 - (k < (s.due ?? 0) ? 60_000 : 0)), sent_at: null, delivered_at: null, reason: null, from: `+1${area}5550${String(10 + (k % 4)).padStart(3, '0')}`, updated_at: iso(now - 4 * 60_000) }
    }
    out.push({
      id: `${s.id}-t${i}`, property_id: `${s.id}-p${i}`, master_owner_id: null, prospect_id: null,
      seller: sellerName, property: `${100 + ((i * 37) % 4800)} ${STREET[i % STREET.length]}, ${s.market}`, market: s.market, state: s.market.slice(-2), phone,
      target_status: status, block_reason: block, identity_status: null, routing_status: null, suppression_status: null, template_status: null,
      priority_score: Math.round(60 + noise(i + 7) * 40), touch_number: 1, queue, queue_rows: queue ? 1 : 0, proof_rows: 0, thread_key: reply?.thread_key ?? null, reply,
    })
  }
  return out
}

export type DemoData = { book: CommandBook; replies: ReplyBook; cores: Record<string, CockpitRead>; intels: Record<string, CampaignIntel>; geos: Record<string, CampaignGeo>; targets: (id: string) => CockpitTargetRow[] }

export function demoData(now: number): DemoData {
  const specs: Spec[] = [
    { id: 'demo-live', name: 'Map area · Minneapolis, MN · 944 properties', status: 'active', kind: 'map_area', explicit: 944, tz: 'America/Chicago', open: true, total: 563, ready: 83, planned: 420, held: 60, queue: 117, due: 3, sent: 300, delivered: 287, replies: 18, buckets: { interested: 5, not_interested: 4, wrong_number: 2, opt_out: 3, ambiguous: 3, other: 1 }, activatedHoursAgo: 50, market: 'Minneapolis, MN' },
    { id: 'demo-cap', name: 'Map area · Dallas, TX · 1,600 properties', status: 'active', kind: 'map_area', explicit: 1600, tz: 'America/Chicago', open: true, total: 1310, ready: 503, planned: 750, held: 57, queue: 0, sent: 738, delivered: 702, replies: 41, buckets: { interested: 9, not_interested: 12, wrong_number: 6, opt_out: 5, ambiguous: 7, other: 2 }, feeder: { bound: 'daily_cap_reached', reason: 'daily_cap_reached', inserted: 0, ready_remaining: 503, active_live_rows: 0, sent_today: 750 }, activatedHoursAgo: 14, market: 'Dallas, TX' },
    { id: 'demo-missed', name: '75+ ACQ SCORE', status: 'scheduled', kind: 'filters', tz: 'America/Chicago', open: true, total: 146, ready: 84, planned: 0, held: 62, sent: 0, delivered: 0, replies: 0, feeder: null, scheduledFor: now - 19 * H, missedFor: now - 19 * H, market: 'Miami, FL' },
    { id: 'demo-window', name: 'Entity Graph · 186 properties', status: 'active', kind: 'entity_graph', explicit: 186, tz: 'America/Los_Angeles', open: false, total: 106, ready: 67, planned: 4, held: 35, sent: 4, delivered: 4, replies: 0, feeder: { inserted: 0, bound: 'buffer', ready_remaining: 67, active_live_rows: 0 }, activatedHoursAgo: 70, market: 'Los Angeles, CA' },
    { id: 'demo-nosender', name: 'Map area · Miami, FL · 320 properties', status: 'active', kind: 'map_area', explicit: 320, tz: 'America/New_York', open: true, total: 212, ready: 149, planned: 0, held: 63, sent: 0, delivered: 0, replies: 0, feeder: { inserted: 0, stalled: true, bound: 'buffer', reason: 'no_row_placed', ready_remaining: 149, active_live_rows: 0, skipped_counts_by_reason: { ROUTING_BLOCKED: 96, sender_blocked_by_operator: 53 } }, activatedHoursAgo: 5, market: 'Miami, FL' },
    { id: 'demo-scheduled', name: 'Absentee owners · Atlanta', status: 'scheduled', kind: 'filters', tz: 'America/New_York', open: false, total: 388, ready: 301, planned: 0, held: 87, sent: 0, delivered: 0, replies: 0, feeder: null, scheduledFor: now + 21 * H, market: 'Atlanta, GA' },
    { id: 'demo-done', name: 'Tax Delinquent · Hennepin', status: 'completed', kind: 'filters', tz: 'America/Chicago', open: true, total: 450, ready: 0, planned: 412, held: 38, sent: 412, delivered: 396, replies: 36, buckets: { interested: 6, not_interested: 11, wrong_number: 5, opt_out: 6, ambiguous: 6, other: 2 }, feeder: null, activatedHoursAgo: 200, market: 'Minneapolis, MN' },
    { id: 'demo-built', name: 'Yes', status: 'built', kind: 'filters', tz: 'America/Chicago', open: true, total: 949, ready: 539, planned: 0, held: 410, sent: 0, delivered: 0, replies: 0, feeder: null, market: 'Minneapolis, MN' },
    { id: 'demo-draft', name: 'Map area · Atlanta, GA · 220 properties', status: 'draft', kind: 'map_area', explicit: 220, tz: 'America/New_York', open: false, total: 0, ready: 0, planned: 0, held: 0, sent: 0, delivered: 0, replies: 0, feeder: null, market: 'Atlanta, GA' },
  ]
  const campaigns = specs.map((s) => bookRow(s, now))
  return {
    book: {
      ok: true, at: iso(now), unavailable: [], campaigns,
      system: {
        processor: { mode: 'live', execution_mode: 'normal', auto_send: true, auto_enqueue: true, outbound_sms: true, emergency_stop_at: null, heartbeat_at: iso(now - 31_000), last_claimed_at: iso(now - 40_000) },
        feeder: { heartbeat_at: iso(now - 4 * 60_000 - 22_000), last_batch_at: iso(now - 4 * 60_000 - 22_000), cadence_minutes: 5 },
        per_number_cap: 800, blocked_sender_count: 8, blocked_template_count: 15,
      },
    },
    replies: { ok: true, at: iso(now), unavailable: [], replies: Object.fromEntries(campaigns.map((c) => [c.id, c.replies!])) },
    cores: Object.fromEntries(specs.map((s) => [s.id, core(s, now)])),
    intels: Object.fromEntries(specs.filter((s) => s.sent > 0 || s.total > 0).map((s) => [s.id, intel(s, now)])),
    geos: Object.fromEntries(specs.filter((s) => s.total > 0).map((s) => [s.id, geo(s)])),
    targets: (() => {
      const made = new Map<string, CockpitTargetRow[]>()
      return (id: string) => {
        const spec = specs.find((x) => x.id === id)
        if (!spec) return []
        if (!made.has(id)) made.set(id, targetsOf(spec, now))
        return made.get(id) ?? []
      }
    })(),
  }
}
