/**
 * CAMPAIGN COMPOSER 2.0 — wire types of /api/cockpit/campaigns/composer
 * (apps/api/src/lib/domain/campaigns/campaign-composer.js). The server owns
 * every number; these types only name what it returns.
 */

export type Bucket = { value: string; label: string; count: number }

export type ComposerAudience = {
  ok: true
  at: string
  strategy: { use_case: string; stage_code: string }
  matched: number | null
  addressable: number | null
  reachable: number | null
  sms_eligible: number | null
  clean: number | null
  eligible_in_audience: number | null
  exclusions: {
    suppressed: number | null
    dnc: number | null
    wrong_number: number | null
    no_phone: number | null
    sms_ineligible: number | null
    no_sender_route: number | null
    pending_prior_touch: number | null
    active_queue: number | null
  }
  build: {
    ok: boolean
    error?: string
    /** true once the whole cohort was counted by the build's own pipeline (part=cohort) */
    whole_cohort?: boolean
    capped_by_build_limit?: boolean
    build_limit?: number
    timings_ms?: { read: number; total: number }
    requested_limit?: number | null
    simulated_limit?: number | null
    capped_by_preview?: boolean
    rows_read?: number | null
    recipients?: number | null
    duplicates_collapsed?: number | null
    built?: number | null
    ready?: number | null
    held?: number | null
    held_by_reason?: Record<string, number>
    sendable_now?: number | null
    no_sendable_number?: number | null
    sender_markets?: Array<{ market: string; sellers: number | null; sendable: boolean | null; route_tier: string | null; block_reason: string | null; summary: string | null }>
    /** greeting personalization of the ready set (whole cohort only) */
    personalization?: Personalization | null
    /** ready sellers a sender can carry whose greeting renders (whole cohort only) */
    sendable_after_personalization?: number | null
  }
  /** the location-only universe the targeting filters narrowed (null when uncountable) */
  universe?: { count: number | null; location_filters: string[]; targeting_filters: string[] } | null
  /** the projection's last measured field coverage (null until measured) */
  graph_coverage?: GraphCoverage | null
  distributions: { markets: Bucket[]; languages: Bucket[]; property_types: Bucket[]; zips: Bucket[]; zones: Bucket[] }
  zones: { scanned: number; unresolved: number }
  inapplicable_filters: Array<Record<string, unknown>>
  unsupported_filters: Array<Record<string, unknown>>
  dropped_filter_count: number
  graph_freshness: { latest_generated_at?: string; refresh_finished_at?: string; refresh_status?: string }
  graph_unavailable: boolean
  warnings: string[]
  samples: ComposerSample[]
}

/** first_name: on file · deed_name: greets by the deed owner's name · none: the render lint refuses it */
export type Personalization = { first_name: number | null; deed_name: number | null; none: number | null }

export type GraphCoverage = {
  measured_at: string | null
  sample_rows: number | null
  latest_built_at: string | null
  oldest_enriched_at: string | null
  latest_enriched_at: string | null
  /** column → share of rows with a value, 0..1 */
  coverage: Record<string, number>
}

export type ComposerSample = {
  id: string
  property_id: string | null
  recipient: string | null
  place: string | null
  market: string | null
  language: string | null
  ok: boolean
  text: string | null
  template_id: string | null
  template_language?: string | null
  reason: string | null
}

export type SenderState = 'active' | 'unverified' | 'paused' | 'blocked' | 'cooling' | 'ineligible' | 'cap_reached'

export type FleetNumber = {
  phone: string | null
  label: string | null
  market: string | null
  state: string | null
  sender_state: SenderState
  reason: string | null
  eligible: boolean
  cooling_until: string | null
  limit: number | null
  limit_basis: 'system' | 'number' | null
  sent_today: number
  remaining_today: number
}

export type ComposerFleet = {
  ok: true
  at: string
  numbers: FleetNumber[]
  markets: Array<{ market: string; state: string | null; numbers: number; by_state: Record<string, number>; capacity_per_day: number; remaining_today: number; unavailable_per_day: number; unknown_limit: number }>
  blocklist_readable: boolean
  system: {
    per_number_cap: number | null
    processor_mode: string | null
    emergency_stop_at: string | null
    outbound_sms_enabled: boolean | null
    contact_window: { start: string; end: string }
    auto_reply_mode: string | null
    followup_automation_mode: string | null
  }
}

export type TemplateLanguage = { language: string; templates: number; sendable: number; paused: number; blocked: number; inactive: number }
export type GovernedTemplate = {
  template_id: string
  name: string
  language: string
  rotation_status: string | null
  selectable: boolean
  reason: string | null
  notes: string | null
  daily_cap: number | null
  performance: { sample: number; reply_rate: number | null; delivery_rate: number | null; opt_out_rate: number | null } | null
  performance_sample: number | null
}
export type ComposerStrategy = {
  use_case: string
  stage_code: string
  label: string
  touch: string
  languages: TemplateLanguage[]
  templates: number
  sendable: number
  governed: GovernedTemplate[]
}
export type ComposerTemplates = { ok: true; at: string; governance_readable: boolean; strategies: ComposerStrategy[] }

export type ServerReadiness = {
  state: 'ready' | 'warnings' | 'blocked' | string | null
  blockers: string[]
  blocker_codes: string[]
  warnings: string[]
  launch_ready: number | null
  ready: number | null
  routable: number | null
  counts: Record<string, number>
  language_coverage: Array<{ language: string; sellers: number; renders: boolean | null; reason: string | null }>
  sender_coverage: Array<{ market: string; sellers: number; sendable: boolean | null }>
  template_readiness: string | null
}

export type PrepareResult = { ok: true; campaign_id: string; build: Record<string, unknown>; readiness: ServerReadiness }
export type LaunchResult = {
  ok: true
  campaign_id: string
  idempotent?: boolean
  mode: 'now' | 'at'
  scheduled_for: string | null
  state: string | null
  eligible: number
  inserted: number | null
  readiness?: ServerReadiness
}
export type ComposerFailure = { ok: false; status?: number; error: string; message?: string | null; readiness?: ServerReadiness; blockers?: string[]; missed?: string }

export type ComposerCohort = {
  ok: true
  at: string
  queue_eligible_in_audience: number
  rows_read: number
  capped_by_build_limit: boolean
  build_limit: number
  recipients: number
  duplicates_collapsed: number
  ready: number
  held: number
  held_by_reason: Record<string, number>
  sendable_now: number | null
  no_sendable_number: number | null
  sender_markets: NonNullable<ComposerAudience['build']['sender_markets']>
  personalization?: Personalization | null
  sendable_after_personalization?: number | null
  ready_by_zone: Record<string, number>
  ready_by_market: Record<string, number>
  timings_ms: { read: number; total: number }
}

export type CoverageStatus = 'LOCAL' | 'REGIONAL' | 'DEGRADED' | 'UNCOVERED'
export type CoverageMarket = {
  market_id: string | null
  market: string
  targets: number
  coverage: CoverageStatus
  serving_pool: string | null
  serving_tier: string | null
  label?: string | null
  healthy_numbers: number
  daily_capacity: number
  unavailable: Array<{ pool: string; tier?: string; reasons: Array<{ phone: string; reason: string }> }>
  shared_numbers?: number
  note?: string
}
export type CoverageTotals = { distinct_healthy_numbers: number; distinct_daily_capacity: number; targets: number }
/** /composer?part=coverage — the canonical routing engine's answer (sender-routing-service readAudienceSenderCoverage). */
export type ComposerCoverage = {
  ok: true
  at: string
  engine: 'legacy_router' | 'sender_routing_v2' | null
  gate?: string
  graph_version?: string
  markets: CoverageMarket[]
  totals: CoverageTotals
  v2_preview: null | { label: string; graph_status?: string; graph_version?: string; seed_backfill_simulated?: boolean; markets: CoverageMarket[]; totals: CoverageTotals }
}
