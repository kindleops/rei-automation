import type { CampaignWizardDraft, CampaignFilterGroups } from './campaignWizardAdapter'
import type { CreateCampaignPayload } from './campaigns.types'

export const MARKET_TIMEZONES: Record<string, string> = {
  'los angeles, ca': 'America/Los_Angeles',
  'miami, fl': 'America/New_York',
  'jacksonville, fl': 'America/New_York',
  'dallas, tx': 'America/Chicago',
  'houston, tx': 'America/Chicago',
  'minneapolis, mn': 'America/Chicago',
  'charlotte, nc': 'America/New_York',
  'atlanta, ga': 'America/New_York',
  'memphis, tn': 'America/Chicago',
}

export interface LaunchPersistSettings {
  daily_cap: string
  per_sender_cap: string
  per_market_cap: string
  max_targets: string
  spread_interval_seconds: string
  contact_window_start: string
  contact_window_end: string
}

function clean(value: unknown): string {
  return String(value ?? '').trim()
}

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function filterFieldKey(filter: { fieldKey?: string; field_key?: string }): string {
  return clean(filter.fieldKey || filter.field_key).toLowerCase()
}

function filterValues(filter: { value?: unknown }): string[] {
  const raw = filter.value
  if (Array.isArray(raw)) return raw.map((item) => clean(item)).filter(Boolean)
  const single = clean(raw)
  return single ? [single] : []
}

export function extractMarketFromFilterDraft(draft: CampaignWizardDraft): { market: string | null; state: string | null } {
  const groups = draft.target_filters as CampaignFilterGroups
  let market: string | null = null
  let state: string | null = null

  for (const filter of groups.properties || []) {
    const key = filterFieldKey(filter)
    const values = filterValues(filter)
    if (!values.length) continue
    if (key === 'properties.market' || key.endsWith('.market')) market = values[0]
    if (key === 'properties.property_address_state' || key.endsWith('.property_address_state')) state = values[0].toUpperCase()
  }

  if (!state && market) {
    const match = /,\s*([A-Za-z]{2})$/.exec(market)
    if (match) state = match[1].toUpperCase()
  }

  return { market, state }
}

export function resolveCampaignTimezone(market: string | null): string {
  const normalized = clean(market).toLowerCase()
  if (normalized && MARKET_TIMEZONES[normalized]) return MARKET_TIMEZONES[normalized]
  if (normalized.includes('los angeles') || normalized.includes('california')) return 'America/Los_Angeles'
  if (normalized.includes('miami') || normalized.includes('florida')) return 'America/New_York'
  if (normalized.includes('dallas') || normalized.includes('houston') || normalized.includes('texas')) return 'America/Chicago'
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'
}

export function isInsideContactWindow(
  timezone: string,
  windowStart = '08:00',
  windowEnd = '21:00',
  now = new Date(),
): boolean {
  const parseMinutes = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clean(value))
    if (!match) return null
    return Number(match[1]) * 60 + Number(match[2])
  }
  const startMin = parseMinutes(windowStart)
  const endMin = parseMinutes(windowEnd)
  if (startMin == null || endMin == null) return true

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map((part) => [part.type, part.value]))
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute)
  if (!Number.isFinite(nowMin)) return true
  return nowMin >= startMin && nowMin < endMin
}

export function buildCampaignPersistPayload(
  draft: CampaignWizardDraft,
  launch: LaunchPersistSettings,
  serializeFilterGroups: (groups: CampaignFilterGroups) => Record<string, unknown>,
): Record<string, unknown> {
  const { market, state } = extractMarketFromFilterDraft(draft)
  const timezone = resolveCampaignTimezone(market)
  const dailyCap = parsePositiveInt(launch.daily_cap, 750)
  const batchMax = Math.min(parsePositiveInt(launch.max_targets, 50), 50)
  const totalCap = parsePositiveInt(launch.max_targets, dailyCap)

  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    status: 'draft',
    campaign_type: 'outbound_sms',
    template_use_case: draft.template_use_case,
    stage_code: draft.stage_code,
    market,
    state,
    daily_cap: dailyCap,
    total_cap: totalCap,
    batch_max: batchMax,
    market_cap: parsePositiveInt(launch.per_market_cap, 400),
    per_sender_cap: parsePositiveInt(launch.per_sender_cap, 150),
    send_interval_seconds: parsePositiveInt(launch.spread_interval_seconds, 45),
    contact_window_start: launch.contact_window_start || '08:00',
    contact_window_end: launch.contact_window_end || '21:00',
    auto_queue_enabled: true,
    metadata: {
      launch_timezone: timezone,
      timezone,
      template_use_case: draft.template_use_case,
      stage_code: draft.stage_code,
      target_filters: {
        catalog_version: 'locked_approved_campaign_fields_v1',
        filter_mode: 'grouped_source_of_truth_domains',
        ...serializeFilterGroups(draft.target_filters),
      },
    },
    target_filters: {
      catalog_version: 'locked_approved_campaign_fields_v1',
      filter_mode: 'grouped_source_of_truth_domains',
      ...serializeFilterGroups(draft.target_filters),
    },
  }
}

export function buildActivateNowPayload(
  launch: LaunchPersistSettings,
  campaignId: string,
  timezone: string,
): Record<string, unknown> {
  const batchMax = Math.min(parsePositiveInt(launch.max_targets, 50), 50)
  const insideWindow = isInsideContactWindow(timezone, launch.contact_window_start, launch.contact_window_end)
  const scheduledAt = insideWindow
    ? new Date(Date.now() + 60_000).toISOString()
    : undefined

  return {
    confirm_live: true,
    no_send: false,
    force_live: true,
    explicit_operator_action: true,
    trigger_immediate_processor: true,
    batch_max: batchMax,
    limit: batchMax,
    max_targets: parsePositiveInt(launch.max_targets, batchMax),
    daily_cap: parsePositiveInt(launch.daily_cap, 750),
    per_sender_cap: parsePositiveInt(launch.per_sender_cap, 150),
    per_market_cap: parsePositiveInt(launch.per_market_cap, 400),
    total_cap: parsePositiveInt(launch.max_targets, 750),
    spread_interval_seconds: parsePositiveInt(launch.spread_interval_seconds, 45),
    contact_window_start: launch.contact_window_start || '08:00',
    contact_window_end: launch.contact_window_end || '21:00',
    first_scheduled_at: scheduledAt,
    scheduled_for: scheduledAt,
    activation_idempotency_key: `mobile-activate:${campaignId}:${Date.now()}`,
    lock_owner: 'mobile_activate_now',
    reason: 'operator:mobile_activate_now',
  }
}

export type { CreateCampaignPayload }