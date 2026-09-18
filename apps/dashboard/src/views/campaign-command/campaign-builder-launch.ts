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
  /**
   * The operator's intended first send, as a local datetime string.
   *
   * It was absent here, which meant the whole schedule lived in React state:
   * an operator set a start time on the phone, the draft saved without it, and
   * a reload silently reset it to "two hours from now". A schedule that does
   * not survive a reload is not a schedule.
   */
  first_scheduled_at?: string
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

/**
 * @param isUpdate  When updating an existing campaign, lifecycle status is NOT
 *   written. This payload hard-set `status: 'draft'`, so every autosave demoted
 *   a campaign the preflight had just driven to `built` — and Schedule then
 *   failed with campaign_status_not_queueable while the operator was looking at
 *   a valid "50 SCHEDULABLE". Autosaving targeting must not rewind lifecycle.
 */
export function buildCampaignPersistPayload(
  draft: CampaignWizardDraft,
  launch: LaunchPersistSettings,
  serializeFilterGroups: (groups: CampaignFilterGroups) => Record<string, unknown>,
  isUpdate = false,
): Record<string, unknown> {
  const { market, state } = extractMarketFromFilterDraft(draft)
  const timezone = resolveCampaignTimezone(market)
  const dailyCap = parsePositiveInt(launch.daily_cap, 750)
  const batchMax = Math.min(parsePositiveInt(launch.max_targets, 50), 50)
  const totalCap = parsePositiveInt(launch.max_targets, dailyCap)

  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    ...(isUpdate ? {} : { status: 'draft' }),
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
      /**
       * PLANNED, not canonical. `campaigns.scheduled_for` is owned by the
       * state machine and is only meaningful paired with `status='scheduled'`
       * — writing it on a draft would claim a campaign is scheduled when no
       * transition has happened and no activation will ever fire. This records
       * the operator's INTENT so the builder can restore it, and the canonical
       * schedule is still set by the `schedule` lifecycle action.
       */
      planned_first_scheduled_at: clean(launch.first_scheduled_at) || null,
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

/**
 * REHYDRATE THE LAUNCH CONFIGURATION FROM A SAVED CAMPAIGN.
 *
 * The builder persisted pacing to real columns — `daily_cap`,
 * `per_sender_cap`, `market_cap`, `send_interval_seconds`,
 * `contact_window_start/end` — and then never read a single one of them back.
 * Loading a saved draft rebuilt the whole launch panel from DEFAULTS, so an
 * operator who set a 60/hr pace and a 09:00-18:00 window on their phone came
 * back to 750/day and 08:00-21:00, with nothing to indicate their settings had
 * been discarded rather than never saved.
 *
 * Only values the campaign actually carries are applied; anything absent keeps
 * the caller's default rather than inventing a zero.
 */
export function hydrateLaunchSettings<T extends LaunchPersistSettings>(
  current: T,
  campaign: Record<string, unknown> | null | undefined,
): T {
  if (!campaign) return current

  const metadata = (campaign.metadata && typeof campaign.metadata === 'object'
    ? campaign.metadata
    : {}) as Record<string, unknown>

  const next: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) }
  const put = (key: string, value: unknown) => {
    const text = clean(value)
    if (text) next[key] = text
  }

  put('daily_cap', campaign.daily_cap)
  put('per_sender_cap', campaign.per_sender_cap)
  put('per_market_cap', campaign.market_cap)
  put('max_targets', campaign.total_cap ?? campaign.batch_max)
  put('spread_interval_seconds', campaign.send_interval_seconds)
  put('contact_window_start', campaign.contact_window_start)
  put('contact_window_end', campaign.contact_window_end)

  /**
   * The canonical `scheduled_for` wins when the campaign really is scheduled —
   * that is the live schedule the activation cron will act on. A draft falls
   * back to the recorded intent.
   */
  const canonical = clean(campaign.scheduled_for)
  const planned = clean(metadata.planned_first_scheduled_at)
  const scheduled = canonical || planned
  if (scheduled) {
    const asDate = new Date(scheduled)
    if (!Number.isNaN(asDate.getTime())) {
      next.first_scheduled_at = toLocalDateTimeInputValue(asDate)
    }
  }

  return next as T
}

/**
 * A `datetime-local` input speaks the BROWSER's wall clock, so the value must
 * be built from local parts. Using `toISOString().slice(0,16)` here — the
 * obvious-looking one-liner — shifts the displayed time by the UTC offset, so a
 * campaign scheduled for 09:00 reads back as 14:00 and an operator "correcting"
 * it would move the real send.
 */
export function toLocalDateTimeInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
