import { callBackend } from '../../../lib/api/backendClient'

/**
 * CAMPAIGN COCKPIT — the desktop operating room's reads.
 *
 * All GET, all read-only (apps/api/src/lib/domain/campaigns/campaign-cockpit.js).
 * A section the server could not read comes back null and is named in
 * `unavailable`; the UI says "unavailable", never 0.
 */

export type CockpitWindow = {
  open: boolean | null
  reason?: string
  window?: string
  closes_at?: string | null
  next_open_at?: string | null
  timezone: string | null
  source: 'campaign' | 'operator'
  policy_version?: string
}

export type CockpitLineage = {
  kind: 'map_area' | 'entity_graph' | 'filters' | 'selection' | 'none'
  declared_source: string | null
  explicit_property_count: number | null
  area: null | { bbox: number[] | null; vertices: number | null; truncated: boolean; property_count: number | null; label: string | null; polygon_stored: boolean }
  handoff_mode: string | null
  filters: Array<{ domain: string; field_key: string; category: string | null; operator: string | null; value: { kind: string; count?: number; sample?: string[]; value?: unknown } }>
  market_values: string[]
  timezone: string | null
  stage_code: string | null
  template_use_case: string | null
  campaign_type: string | null
  channel: 'sms'
}

export type CockpitLiveQueue = {
  live: number
  due: number
  overdue: number
  oldest_due_at: string | null
  next_scheduled_at: string | null
  release_reasons: Record<string, number>
  /** When the processor last picked up one of these rows (row metadata). */
  last_claimed_at?: string | null
  /** When it last put one back without sending, and why. */
  last_released_at?: string | null
  last_release_reason?: string | null
}

export type CockpitSender = {
  phone: string
  label: string | null
  market: string | null
  known: boolean
  status: string | null
  health_state: string | null
  health_reason: string | null
  cooling_until: string | null
  spam_flagged_at: string | null
  operator_blocked: boolean
  daily_limit: number | null
  carrying_campaign: boolean
  campaign_queued: number
  campaign_sent_today: number
  campaign_last_sent_at: string | null
  last_used_at: string | null
}

export type CockpitEvent = {
  id: string
  type: string
  severity: string
  title: string | null
  description: string | null
  at: string
  rows_created: number | null
  blockers: string[]
}

export type CockpitExceptionGroup = { failure_category: string; count: number; severity?: string; sample_reasons?: string[]; latest_at?: string | null }

export type CockpitRead = {
  ok: true
  campaign_id: string
  at: string
  name: string
  status: string
  lineage: CockpitLineage
  lifecycle: {
    created_at: string | null
    scheduled_for: string | null
    activated_at: string | null
    paused_at: string | null
    resumed_at: string | null
    completed_at: string | null
    last_transition_reason: string | null
    last_transition_at: string | null
    execution_heartbeat_at: string | null
    schedule_missed_for: string | null
    schedule_missed_at: string | null
  }
  flags: {
    auto_queue_enabled: boolean
    auto_send_enabled: boolean
    auto_reply_mode: string | null
    emergency_stop_at: string | null
    production_launch: boolean
    quarantine: null | { reason: string | null; detail: string | null; quarantined_at: string | null; target_rows: number | null; selected_properties: number | null; rows_outside_selection: number | null }
  }
  caps: {
    daily_cap: number | null
    total_cap: number | null
    market_cap: number | null
    per_sender_cap: number | null
    configured_per_number_cap: number | null
    batch_max: number | null
    send_interval_seconds: number | null
  }
  targets: null | {
    total: number
    by_status: Record<string, number>
    held_by_reason: Record<string, number>
    advisories: Record<string, Record<string, number>>
    ready: number
    held: number
    committed: number
  }
  send_states: null | { by_status: Record<string, number>; sent: number; delivered: number; failed: number }
  queue: null | (CockpitLiveQueue & {
    proof: number
    by_status: Record<string, number>
    processing: number
    spam_retries: number
    latest_scheduled_at: string | null
    by_sender: Record<string, number>
    truncated: boolean
  })
  sends: {
    sent_today: number | null
    day_start: string
    day_timezone: string
    day_timezone_basis: 'campaign' | 'feeder_default'
    last_sent_at: string | null
    first_sent_at: string | null
    failed_last_hour: number | null
  }
  feed: null | {
    limit: number
    bound: string
    buffer_need: number
    daily_remaining: number | null
    total_remaining: number | null
    buffer_target: number
    chunk: number
  }
  window: CockpitWindow
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
  feeder: {
    heartbeat_at: string | null
    last_batch_at: string | null
    campaign_last: null | {
      at: string | null
      inserted: number
      bound: string | null
      reason: string | null
      stalled: boolean
      ready_remaining: number
      active_live_rows: number
      last_refill_at: string | null
      skipped_counts_by_reason: Record<string, number>
      /** "84 sender blocked by operator (Miami, FL: +1305… blocked by operator; …)" */
      skip_summary?: string | null
      /** Per market: why no sender could carry these sellers, number by number. */
      routing_blocks_by_market?: Record<string, { targets: number; reason: string; senders: Array<{ phone_number: string | null; state: string }> }>
    }
  }
  senders: CockpitSender[]
  email: { campaign_rows: number | null; sender_identities: number | null }
  responses: null | {
    sellers_messaged: number
    sellers_replied: number
    reply_messages: number
    sellers_asked_to_stop: number
    latest_reply_at: string | null
    truncated: boolean
    intents: Record<string, number>
    latest: Array<{ seller_phone: string; seller_name: string | null; message: string | null; intent: string | null; asked_to_stop: boolean; thread_key: string | null; at: string }>
  }
  exceptions: null | {
    run_id: string | null
    execution: { total: number; truncated: boolean; groups: CockpitExceptionGroup[] }
    target_preparation: { total: number; truncated: boolean; groups: CockpitExceptionGroup[] }
  }
  geography: null | { markets: Array<{ market: string | null; state: string | null; targets: number }>; market_count: number; total: number; truncated: boolean }
  timeline: { events: CockpitEvent[]; idle_feeder_checks: null | { count: number; last_at: string | null } }
  unavailable: string[]
}

export type CockpitTargetRow = {
  id: string
  property_id: string | null
  master_owner_id: string | null
  prospect_id: string | null
  seller: string | null
  property: string | null
  market: string | null
  state: string | null
  phone: string | null
  target_status: string | null
  block_reason: string | null
  identity_status: string | null
  routing_status: string | null
  suppression_status: string | null
  template_status: string | null
  priority_score: number | null
  touch_number: number | null
  queue: null | { id: string; status: string | null; scheduled_for: string | null; sent_at: string | null; delivered_at: string | null; reason: string | null; from: string | null; updated_at: string | null }
  queue_rows: number
  proof_rows: number
  thread_key: string | null
  reply: null | { at: string; intent: string | null; thread_key: string | null; asked_to_stop: boolean; messages: number }
}

export type CockpitTargetPage = {
  ok: true
  campaign_id: string
  page: number
  page_size: number
  total: number
  total_pages: number
  status: string
  search: string | null
  truncated: { queue: boolean; replies: boolean }
  targets: CockpitTargetRow[]
}

export type CohortPoints = {
  ok: true
  campaign_id: string
  basis: 'source_cohort' | 'audience'
  source_kind: CockpitLineage['kind']
  total_ids: number
  located: number
  missing: number
  truncated: boolean
  points: Array<{ id: string; lat: number; lng: number; label: string | null }>
}

export type MarketIndex = {
  ok: true
  campaigns: Record<string, { top: Array<{ market: string; targets: number }>; market_count: number }>
  markets: Array<{ market: string; targets: number }>
  truncated: boolean
}

type Envelope = { ok?: boolean; error?: string; message?: string }

async function read<T extends Envelope>(path: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
  const res = await callBackend<T>(path, { signal, timeoutMs })
  if (!res.ok) {
    // The upstream body (when there is one) says why; otherwise the client does.
    const upstream = res.upstream as Envelope | undefined
    throw new Error(upstream?.message || upstream?.error || res.message || res.error || 'unavailable')
  }
  const body = res.data
  if (!body || body.ok === false) throw new Error((body && (body.message || body.error)) || 'unavailable')
  return body
}

export function fetchCampaignCockpit(campaignId: string, signal?: AbortSignal): Promise<CockpitRead> {
  return read<CockpitRead>(`/api/cockpit/campaigns/${encodeURIComponent(campaignId)}/cockpit`, signal)
}

export function fetchCockpitTargets(
  campaignId: string,
  params: { page: number; pageSize: number; status: string; search: string },
  signal?: AbortSignal,
): Promise<CockpitTargetPage> {
  const q = new URLSearchParams({ page: String(params.page), page_size: String(params.pageSize), status: params.status })
  if (params.search.trim()) q.set('search', params.search.trim())
  return read<CockpitTargetPage>(`/api/cockpit/campaigns/${encodeURIComponent(campaignId)}/cockpit/targets?${q.toString()}`, signal, 45_000)
}

export function fetchCohortPoints(campaignId: string): Promise<CohortPoints> {
  return read<CohortPoints>(`/api/cockpit/campaigns/${encodeURIComponent(campaignId)}/cockpit/cohort`, undefined, 45_000)
}

export function fetchMarketIndex(signal?: AbortSignal): Promise<MarketIndex> {
  return read<MarketIndex>('/api/cockpit/campaigns/markets', signal, 45_000)
}
