import { callBackend } from '../../../lib/api/backendClient'
import type { CockpitWindow } from './cockpit-api'

/**
 * CAMPAIGN COMMAND 3.0 — the war room's reads (all GET, all read-only;
 * apps/api/src/lib/domain/campaigns/campaign-command-intel.js). A section the
 * server could not read is null and named in `unavailable` — the UI says
 * "not available", never 0.
 */

export type WarSystem = {
  processor: {
    mode: string | null
    execution_mode: string | null
    auto_send: boolean | null
    auto_enqueue: boolean | null
    outbound_sms: boolean | null
    emergency_stop_at: string | null
    heartbeat_at: string | null
    last_claimed_at: string | null
  }
  feeder: { heartbeat_at: string | null; last_batch_at: string | null; cadence_minutes: number }
  per_number_cap: number | null
  blocked_sender_count: number
  blocked_template_count: number
}

export type FeederDigest = {
  at: string | null
  inserted: number
  bound: string | null
  reason: string | null
  stalled: boolean
  ready_remaining: number
  active_live_rows: number
  sent_today: number | null
  batch_limit: number | null
  spam_retries: number
  last_refill_at: string | null
  skipped_counts_by_reason: Record<string, number>
  skip_summary: string | null
  routing_blocks_by_market: Record<string, { targets: number; reason: string; senders: Array<{ phone_number: string | null; state: string }> }>
}

export type ReplyBucketKey = 'interested' | 'not_interested' | 'wrong_number' | 'opt_out' | 'ambiguous' | 'other'
export type ReplyBuckets = Record<ReplyBucketKey, number>

export type BookCampaign = {
  id: string
  name: string
  status: string
  archived: boolean
  created_at: string | null
  updated_at: string | null
  completed_at?: string | null
  source: { kind: string; explicit_count?: number | null; area_property_count?: number | null; filter_count?: number; market_values?: string[] }
  timezone?: string | null
  window?: CockpitWindow & { reason?: string }
  schedule?: {
    scheduled_for: string | null
    missed_for: string | null
    activated_at: string | null
    paused_at: string | null
    resumed_at: string | null
    completed_at: string | null
    last_transition_reason: string | null
  }
  caps?: { daily_cap: number | null; total_cap: number | null }
  targets?: { total: number; ready: number; planned: number; held: number; other: number; held_by_reason: Record<string, number> } | null
  queue?: { live: number; due: number; overdue: number; next_at: string | null } | null
  sends?: { sellers_dispatched: number; sellers_delivered: number; last_sent_at: string | null; sent_today: number; truncated: boolean } | null
  replies?: { sellers_replied: number; sellers_asked_to_stop: number; buckets: ReplyBuckets; latest_reply_at: string | null; truncated: boolean } | null
  feeder?: FeederDigest | null
  quarantined?: boolean
}

export type CommandBook = { ok: true; at: string; system: WarSystem; campaigns: BookCampaign[]; unavailable: string[] }
export type ReplyBook = { ok: true; at: string; replies: Record<string, NonNullable<BookCampaign['replies']>>; unavailable: string[] }

export type FunnelCounts = {
  total: number
  left_us: number
  accepted: number
  delivered: number
  awaiting_receipt: number
  filtered: number
  invalid_destination: number
  soft_bounce: number
  carrier_dnc: number
  carrier_undelivered: number
  provider_refused: number
  held_at_send: number
  expired_unsent: number
  cancelled: number
  waiting: number
  other: number
  classes: Record<string, number>
  receipt_lag: number
  carrier_verdicts_truncated: boolean
}

export type SeriesBucket = { t: string; queued: number; sent: number; delivered: number; failed: number; replies: number }

export type Batch = {
  n: number
  run_id: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  ready: number
  planned: number
  created: number
  matched_rows: number
  blocked_counts: Record<string, number>
  senders: Array<{ value?: string; label?: string; count?: number }>
  templates: number
  outcome: { queued_now: number; left_us: number; delivered: number; filtered: number; failed: number; held: number; cancelled: number; replied: number }
}

export type FleetNumber = {
  phone: string
  label: string | null
  market: string | null
  in_campaign_market: boolean
  status: string | null
  health_state: string | null
  health_reason: string | null
  cooling_until: string | null
  spam_flagged_at: string | null
  state: 'active' | 'unverified' | 'paused' | 'blocked' | 'cooling' | 'ineligible' | 'cap_reached'
  state_reason: string | null
  eligible: boolean
  daily_limit: number | null
  limit: number | null
  limit_basis: 'campaign' | 'system' | 'number' | null
  sent_today: number
  router_counter: number | null
  remaining_today: number
  campaign: {
    carrying: boolean
    queued: number
    sent_today: number
    last_sent_at: string | null
    left_us: number
    delivered: number
    filtered: number
    failed: number
    sellers: number
    sellers_replied: number
    sample_ok: boolean
  }
  last_used_at: string | null
}

export type RoutingMarket = { market: string; targets: number; ready: number; numbers: number; eligible: number; by_state: Record<string, number>; remaining_today: number }

export type TemplatePerf = {
  template_id: string
  name: string | null
  use_case: string | null
  language: string | null
  stage_code: string | null
  variant_group: string | null
  asset_scope: string | null
  active: boolean | null
  blocked_by_operator: boolean
  quarantined: boolean
  quarantine_reason: string | null
  attempted: number
  delivered: number
  filtered: number
  failed: number
  sellers_first_reached: number
  sellers_replied: number
  sample_ok: boolean
}

export type ReplySeller = {
  seller_phone: string
  seller_name: string | null
  intent: string
  bucket: ReplyBucketKey
  asked_to_stop: boolean
  thread_key: string | null
  message: string | null
  first_reply_at: string
  latest_reply_at: string
  messages: number
}

export type AttributedOpportunity = {
  id: string
  thread_key: string | null
  master_owner_id: string | null
  property_id: string | null
  stage: string | null
  status: string | null
  created_at: string | null
  recommended_offer: number | null
  current_offer: number | null
  latest_intent: string | null
  seller: string | null
  address: string | null
  moves: Array<{ from: string | null; to: string | null; at: string | null; actor: string | null }>
}

export type CampaignIntel = {
  ok: true
  campaign_id: string
  at: string
  timezone: string | null
  day_start: string
  rows: { total: number; read: number; truncated: boolean; campaign_texts: number; conversation: number; proof: number } | null
  sellers: { left_us: number; delivered: number; replied: number } | null
  delivery: FunnelCounts | null
  retries: {
    originals_filtered: number
    recycled: number
    no_retry: number
    retry_rows: number
    retry_delivered: number
    retry_filtered: number
    retry_failed: number
    retry_waiting: number
    no_retry_reasons: Record<string, number>
  } | null
  series: { grain: 'hour' | 'day'; step_ms: number; start: string; buckets: SeriesBucket[] } | null
  batches: { list: Batch[]; placed_passes: number; empty_passes: number | null; latest_pass: FeederDigest | null } | null
  feeder: { buffer_target: number; chunk: number }
  replies: {
    sellers_messaged: number
    sellers_replied: number
    reply_messages: number
    sellers_asked_to_stop: number
    truncated: boolean
    buckets: ReplyBuckets
    intents: Record<string, number>
    list: ReplySeller[]
  } | null
  outcomes: {
    basis: string
    opportunities: AttributedOpportunity[]
    stage_moves: number
    opportunities_moved: number
    offers: Array<{ id: string; opportunity_id: string; status: string | null; type: string | null; direction: string | null; price: number | null; sent_at: string | null; accepted_at: string | null; accepted_price: number | null }>
    closings: Array<{ id: string; opportunity_id: string; contract_status: string | null; closing_status: string | null; contract_price: number | null; expected_revenue: number | null; confirmed_revenue: number | null; revenue_status: string | null; closed_at: string | null }>
  } | null
  templates: TemplatePerf[] | null
  fleet: { numbers: FleetNumber[]; system_cap: number | null; campaign_cap: number | null; blocked_count: number; today_truncated: boolean } | null
  routing: RoutingMarket[] | null
  audience: { total: number; truncated: boolean; markets: Record<string, number>; ready_by_market: Record<string, number>; zones: Record<string, number> } | null
  caps: {
    daily_cap: number | null
    total_cap: number | null
    market_cap: number | null
    batch_max: number | null
    per_sender_cap: number | null
    system_per_number_cap: number | null
    send_interval_seconds: number | null
  }
  unavailable: string[]
}

export type GeoStateKey = 'held' | 'ready' | 'planned' | 'queued' | 'sent' | 'delivered' | 'failed' | 'replied' | 'opportunity'

export type CampaignGeo = {
  ok: true
  campaign_id: string
  states: GeoStateKey[]
  total_targets: number
  sampled: boolean
  located: number
  unlocated: number
  rows_truncated: boolean
  /** [lat, lng, state index into `states`] */
  points: Array<[number, number, number]>
  counties: Array<{ county: string | null; state: string | null; targets: number; held: number; sent: number; delivered: number; replied: number; failed: number; opportunities: number }>
  county_count: number
}

type Envelope = { ok?: boolean; error?: string; message?: string }

async function read<T extends Envelope>(path: string, signal?: AbortSignal, timeoutMs = 90_000): Promise<T> {
  const res = await callBackend<T>(path, { signal, timeoutMs })
  if (!res.ok) {
    const upstream = res.upstream as Envelope | undefined
    throw new Error(upstream?.message || upstream?.error || res.message || res.error || 'unavailable')
  }
  const body = res.data
  if (!body || body.ok === false) throw new Error((body && (body.message || body.error)) || 'unavailable')
  return body
}

export const fetchCommandBook = (signal?: AbortSignal) => read<CommandBook>('/api/cockpit/campaigns/command-book', signal)
export const fetchReplyBook = (signal?: AbortSignal) => read<ReplyBook>('/api/cockpit/campaigns/command-book?part=replies', signal)
export const fetchCampaignIntel = (id: string, signal?: AbortSignal) => read<CampaignIntel>(`/api/cockpit/campaigns/${encodeURIComponent(id)}/cockpit/intel`, signal)
export const fetchCampaignGeo = (id: string, signal?: AbortSignal) => read<CampaignGeo>(`/api/cockpit/campaigns/${encodeURIComponent(id)}/cockpit/geo`, signal)
