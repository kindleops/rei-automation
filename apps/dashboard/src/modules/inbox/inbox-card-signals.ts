import {
  LIFECYCLE_STAGE_META,
  LIFECYCLE_STAGE_ORDER,
  type LifecycleStageCode,
} from '../../domain/lead-state/universal-lead-state-registry'

/**
 * Card-level derivations for the Inbox thread card: stage badge, message state,
 * date + time, and the property signal tile model.
 *
 * Everything here answers a question the card asks and nothing else. No
 * fetching, no formatting of things the card does not show.
 */

const clean = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim()

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const normalizeKey = (value: unknown): string =>
  clean(value).toLowerCase().replace(/[\s\-/]+/g, '_')

// ───────────────────────────────────────────────────────────────────────────
// STAGE
// ───────────────────────────────────────────────────────────────────────────

/**
 * Aliases that are genuinely the SAME stage under another name, taken from the
 * registry's own alias table. Deliberately NOT the registry's
 * `normalizeLifecycleStage`, which coerces anything unrecognised to
 * `ownership_confirmation` — correct for a pipeline that must place every
 * record somewhere, and wrong here: it would stamp S1 on a thread that has no
 * stage at all.
 *
 * Measured over 9,778 threads on 2026-09-14: 5,967 carry a canonical lifecycle
 * stage and 3,811 carry none. The 3,811 must show no badge. A fabricated S1
 * claims an ownership check that never happened.
 */
const STAGE_CODE_ALIASES: Record<string, LifecycleStageCode> = {
  ownership_check: 'ownership_confirmation',
  ownership: 'ownership_confirmation',
  interest_probe: 'offer_interest',
  interest_qualification: 'offer_interest',
  price_discovery: 'asking_price',
  pricing: 'asking_price',
  condition: 'property_condition',
  condition_details: 'property_condition',
  underwriting: 'property_condition',
  offer_reveal: 'offer',
  offer_sent: 'offer',
  contract_sent: 'formal_contract',
  contract_to_close: 'formal_contract',
  closing: 'prepared_to_close',
  title_closing: 'prepared_to_close',
}

const STAGE_CODES = new Set<string>(LIFECYCLE_STAGE_ORDER)

export type InboxStageBadge = {
  code: LifecycleStageCode
  /** 1-10, the ordinal position in the canonical acquisition order. */
  number: number
  /** "S4" */
  short: string
  /** "S4 · Property Condition" — for the accessible label, not the badge face. */
  label: string
  /** Funnel band, for the restrained colour progression. */
  band: 'early' | 'mid' | 'execution'
}

/**
 * The canonical acquisition stage for a thread, or null.
 *
 * Reads ONLY the canonical stage fields. `stage` / `legacy_stage` /
 * `conversation_status` are deliberately not consulted: the hydrated view's
 * `stage` column carries statuses and buckets (`waiting`, `new_reply`,
 * `needs_response`), which is what made a stage badge impossible to trust.
 */
export function resolveInboxStageBadge(source: Record<string, unknown> | null | undefined): InboxStageBadge | null {
  if (!source) return null
  const candidates = [
    source.acquisition_stage,
    source.acquisitionStage,
    source.seller_stage,
    source.sellerStage,
    source.lifecycle_stage,
    source.lifecycleStage,
  ]

  for (const candidate of candidates) {
    const key = normalizeKey(candidate)
    if (!key) continue
    const code = (STAGE_CODES.has(key) ? key : STAGE_CODE_ALIASES[key]) as LifecycleStageCode | undefined
    if (!code) continue
    const meta = LIFECYCLE_STAGE_META[code]
    if (!meta) continue
    return {
      code,
      number: meta.number,
      short: `S${meta.number}`,
      label: `S${meta.number} · ${meta.label}`,
      band: meta.number <= 3 ? 'early' : meta.number <= 6 ? 'mid' : 'execution',
    }
  }
  return null
}

// ───────────────────────────────────────────────────────────────────────────
// MESSAGE DIRECTION + DELIVERY STATE
// ───────────────────────────────────────────────────────────────────────────

export type InboxMessageState = {
  direction: 'inbound' | 'outbound'
  /** "Inbound · New reply", "Outbound · Delivered" */
  label: string
  tone: 'inbound' | 'inbound-new' | 'delivered' | 'sent' | 'failed' | 'scheduled' | 'queued' | 'suppressed'
  arrow: '↙' | '↗'
}

const STATUS_FIELDS = [
  'latest_delivery_status',
  'latestDeliveryStatus',
  'delivery_status',
  'deliveryStatus',
  'latest_provider_delivery_status',
  'provider_delivery_status',
  'raw_carrier_status',
  'raw_status',
  'queue_status',
  'queueStatus',
]

function statusTokens(row: Record<string, unknown>): string[] {
  return STATUS_FIELDS
    .map((field) => clean(row[field]).toLowerCase())
    .filter(Boolean)
}

function firstPresent(row: Record<string, unknown>, ...fields: string[]): string {
  for (const field of fields) {
    const value = clean(row[field])
    if (value) return value
  }
  return ''
}

function truthy(row: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.some((field) => row[field] === true || clean(row[field]).toLowerCase() === 'true')
}

/**
 * WHAT ACTUALLY HAPPENED TO THE MESSAGE.
 *
 * The previous resolver ended with
 *   `if (hasDelivered || sentAt || latestDirection === 'outbound') -> Delivered`
 * so EVERY outbound thread with no delivery evidence whatsoever was labelled
 * "Delivered". Measured 2026-09-14: `latest_delivery_status` is null on the
 * majority of outbound threads and `failed_transport` on others — the null ones
 * were all reading "Delivered" beside a message the provider never confirmed.
 *
 * Delivery is now claimed only on provider evidence, and the unconfirmed case
 * says "Sent", which is what the system actually knows.
 */
export function resolveInboxMessageState(
  row: Record<string, unknown> | null | undefined,
  latestDirection: string,
  options: { unread?: boolean } = {},
): InboxMessageState | null {
  if (!row) return null
  const direction = clean(latestDirection).toLowerCase()

  const tokens = statusTokens(row)
  const has = (...needles: string[]) => tokens.some((token) => needles.some((needle) => token.includes(needle)))

  /*
   * SUPPRESSION IS CHECKED BEFORE DIRECTION, AND THAT ORDER IS THE POINT.
   *
   * This test used to live INSIDE the outbound branch, below an inbound branch
   * that returned early. So a suppressed thread whose last message was inbound
   * never reached it: it was labelled "Inbound · New reply" in actionable cyan.
   *
   * Measured on the live list -- "Bertha A Daniels", inbox_bucket=suppressed,
   * rendered as a new reply awaiting an answer. That is not a cosmetic bug: the
   * card was inviting an operator to reply to someone who had opted out, and
   * the suppression state it was supposed to show was unreachable for exactly
   * the threads where a seller had spoken last.
   *
   * Suppression is a property of the CONTACT, not of the last message, so it
   * is resolved before any direction is considered.
   */
  if (truthy(row, 'suppressed', 'isSuppressed', 'is_suppressed') || has('suppress', 'blocked', 'dnc')) {
    const arrow = direction === 'inbound' ? '↙' : '↗'
    return { direction: direction === 'inbound' ? 'inbound' : 'outbound', label: 'Suppressed', tone: 'suppressed', arrow }
  }

  if (direction === 'inbound') {
    return options.unread
      ? { direction: 'inbound', label: 'Inbound · New reply', tone: 'inbound-new', arrow: '↙' }
      : { direction: 'inbound', label: 'Inbound', tone: 'inbound', arrow: '↙' }
  }
  if (direction !== 'outbound') return null

  const failedAt = firstPresent(row, 'latest_failed_at', 'latestFailedAt', 'failed_at', 'failedAt')
  const failureReason = firstPresent(row, 'latest_failure_reason', 'latestFailureReason', 'failure_reason', 'error_message')
  const isFinalFailure = truthy(row, 'is_final_failure', 'isFinalFailure', 'latest_is_final_failure')
  if (isFinalFailure || failedAt || failureReason || has('fail', 'undeliv', 'rejected', 'error')) {
    return { direction: 'outbound', label: 'Outbound · Failed', tone: 'failed', arrow: '↗' }
  }

  // Scheduled outranks queued: a row with a future send time is scheduled even
  // though it is also sitting in the queue.
  const scheduledFor = firstPresent(row, 'next_scheduled_for', 'nextScheduledFor', 'scheduled_for', 'scheduledFor')
  if (scheduledFor || has('scheduled')) {
    return { direction: 'outbound', label: 'Outbound · Scheduled', tone: 'scheduled', arrow: '↗' }
  }
  if (has('queued', 'pending', 'approved', 'ready', 'processing', 'sending', 'manual_review')) {
    return { direction: 'outbound', label: 'Outbound · Queued', tone: 'queued', arrow: '↗' }
  }

  // DELIVERED REQUIRES PROVIDER EVIDENCE. Nothing else may claim it.
  const deliveredAt = firstPresent(row, 'latest_delivered_at', 'latestDeliveredAt', 'delivered_at', 'last_delivered_at')
  if (deliveredAt || has('deliver')) {
    return { direction: 'outbound', label: 'Outbound · Delivered', tone: 'delivered', arrow: '↗' }
  }

  const sentAt = firstPresent(row, 'latest_sent_at', 'latestSentAt', 'sent_at', 'sentAt')
  if (sentAt || has('sent', 'accepted')) {
    return { direction: 'outbound', label: 'Outbound · Sent', tone: 'sent', arrow: '↗' }
  }

  /**
   * NO EVIDENCE MEANS NO CLAIM -- not even "Sent".
   *
   * The compact list row omits `latest_delivery_status` on purpose: it is
   * budgeted at <=50 keys, the budget is asserted in
   * inbox-live-v2-service.test.mjs, and canonical-inbox-row-contract.js says
   * so in as many words. So on the All Threads bucket the card genuinely does
   * not know what happened to the message.
   *
   * Falling through to "Sent" there looked harmless and was not: 64 of 200
   * threads are `failed_transport`, and every one of them would have read
   * "Outbound · Sent". Direction is the only thing actually known, so
   * direction is all this says.
   */
  return { direction: 'outbound', label: 'Outbound', tone: 'sent', arrow: '↗' }
}

// ───────────────────────────────────────────────────────────────────────────
// DATE + TIME
// ───────────────────────────────────────────────────────────────────────────

/**
 * "Sep 12 · 10:42 AM" / "Today · 10:42 AM".
 *
 * The card showed date OR time, never both (`dayLabel === 'Today' ? timeLabel :
 * dayLabel`), so an operator triaging a day's replies could not tell 8am from
 * 6pm without opening each one.
 */
export function formatCardDateTime(
  timestamp: { dayLabel: string; timeLabel: string } | null | undefined,
): string {
  const day = clean(timestamp?.dayLabel)
  const time = clean(timestamp?.timeLabel)
  if (!day || day === '—') return time || '—'
  if (!time) return day
  return `${day} · ${time}`
}

// ───────────────────────────────────────────────────────────────────────────
// PROPERTY SIGNAL TILE MODEL
// ───────────────────────────────────────────────────────────────────────────

export type PropertyTileGlyph = 'sfr' | 'multifamily' | 'condo' | 'townhome' | 'land' | 'commercial' | 'generic'

export type PropertySignalTileModel = {
  /** "SFR", "Multifamily · 8 units", "Land" — already assembled. */
  typeLine: string | null
  /** "$490K" — omitted entirely when unavailable. */
  valueLine: string | null
  /** "97% EQ" — omitted when there is no real equity figure. */
  equityLine: string | null
  /** "HARTFORD, CT" */
  marketLine: string | null
  glyph: PropertyTileGlyph
}

const GLYPH_BY_TYPE: Array<[RegExp, PropertyTileGlyph]> = [
  [/multi|duplex|triplex|fourplex|apartment/i, 'multifamily'],
  [/condo/i, 'condo'],
  [/town/i, 'townhome'],
  [/land|lot|vacant/i, 'land'],
  [/commercial|office|retail|industrial/i, 'commercial'],
  [/single|sfr|residential/i, 'sfr'],
]

export function resolvePropertyTileGlyph(propertyType: unknown): PropertyTileGlyph {
  const text = clean(propertyType)
  if (!text) return 'generic'
  for (const [pattern, glyph] of GLYPH_BY_TYPE) {
    if (pattern.test(text)) return glyph
  }
  return 'generic'
}

function compactMoney(value: number | null): string | null {
  if (value === null || value <= 0) return null
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `$${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')}M`
  }
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return `$${Math.round(value)}`
}

/**
 * The display label for an asset class.
 *
 * Normalised here rather than relying on the caller, because the two Inbox
 * surfaces disagreed: the list passes a pre-labelled `propertyTypeLabel`
 * ("Multifamily") while the conversation header has only the raw column
 * ("Multi-Family"), so the same property read two different ways depending on
 * where you looked at it.
 */
export function formatPropertyTypeLabel(propertyType: unknown): string | null {
  const raw = clean(propertyType)
  if (!raw) return null
  const key = raw.toLowerCase()
  if (key === 'unknown type' || key === 'unknown') return null
  if (/duplex/.test(key)) return 'Duplex'
  if (/triplex/.test(key)) return 'Triplex'
  if (/fourplex|quadplex/.test(key)) return 'Fourplex'
  if (/apartment/.test(key)) return 'Apartment'
  if (/multi/.test(key)) return 'Multifamily'
  if (/single|^sfr$/.test(key)) return 'SFR'
  if (/condo/.test(key)) return 'Condo'
  if (/town/.test(key)) return 'Townhome'
  if (/land|vacant lot/.test(key)) return 'Land'
  if (/commercial|office|retail|industrial/.test(key)) return 'Commercial'
  return raw
}

/**
 * The unit suffix belongs to multifamily and nowhere else.
 *
 * `units_count` is 1 on most SFR rows and 0 on some, so an unconditional
 * "· N units" would read "SFR · 1 units" or "SFR · 0 units" on real data.
 * Duplex/Triplex already name their unit count, so it is not repeated.
 */
export function formatPropertyTypeLine(
  propertyTypeLabel: unknown,
  unitCount: unknown,
): string | null {
  const label = formatPropertyTypeLabel(propertyTypeLabel)
  if (!label) return null
  const glyph = resolvePropertyTileGlyph(label)
  const namesItsOwnUnits = /^(duplex|triplex|fourplex)$/i.test(label)
  const units = num(unitCount)
  if (glyph === 'multifamily' && !namesItsOwnUnits && units !== null && units > 1) {
    return `${label} · ${units} units`
  }
  return label
}

/**
 * Equity as the tile states it.
 *
 * 0% is dropped as meaningless per the card contract, but a NEGATIVE percent is
 * kept — `equity_percent: -3` appears in real rows and "underwater" is exactly
 * the kind of thing an operator needs to see, not hide.
 */
export function formatTileEquity(equityPercent: unknown): string | null {
  const percent = num(equityPercent)
  if (percent === null || percent === 0) return null
  return `${Math.round(percent)}% EQ`
}

/** "Miami, FL" / "Saint Paul" → the tile's short market line. */
export function formatTileMarket(market: unknown, city: unknown, state: unknown): string | null {
  const direct = clean(market)
  if (direct && direct.toLowerCase() !== 'unknown market') return direct.toUpperCase()
  const cityText = clean(city)
  const stateText = clean(state)
  if (cityText && stateText) return `${cityText}, ${stateText}`.toUpperCase()
  if (cityText) return cityText.toUpperCase()
  return null
}

export function buildPropertySignalTileModel(input: {
  propertyTypeLabel?: unknown
  propertyType?: unknown
  unitCount?: unknown
  estimatedValue?: unknown
  equityPercent?: unknown
  market?: unknown
  city?: unknown
  state?: unknown
}): PropertySignalTileModel {
  return {
    typeLine: formatPropertyTypeLine(input.propertyTypeLabel ?? input.propertyType, input.unitCount),
    valueLine: compactMoney(num(input.estimatedValue)),
    equityLine: formatTileEquity(input.equityPercent),
    marketLine: formatTileMarket(input.market, input.city, input.state),
    glyph: resolvePropertyTileGlyph(input.propertyTypeLabel ?? input.propertyType),
  }
}

// ───────────────────────────────────────────────────────────────────────────
// SIGNAL PRIORITISATION
// ───────────────────────────────────────────────────────────────────────────

/**
 * Highest-actionability first. Property type, stage and status are excluded on
 * purpose: they have their own places on the card, and repeating them as
 * motivation tags is what made the chip row unreadable.
 */
const SIGNAL_PRIORITY = [
  'Preforeclosure',
  'Foreclosure',
  'Tax Delinquent',
  'Probate',
  'Vacant',
  'High Equity',
  'Tired Landlord',
  'Absentee',
  'Absentee Owner',
  'Senior Owner',
  'Off Market',
  'Distressed',
  'Long Term Owner',
]

const SIGNAL_RANK = new Map(SIGNAL_PRIORITY.map((label, index) => [label.toLowerCase(), index]))

const SIGNAL_EXCLUDE = new Set([
  'sfr', 'single family', 'multifamily', 'multi-family', 'condo', 'townhome', 'land', 'commercial',
])

export function prioritizeCardSignals(flags: unknown, limit = 2): string[] {
  const list = Array.isArray(flags) ? flags.map(clean).filter(Boolean) : []
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const flag of list) {
    const key = flag.toLowerCase()
    if (SIGNAL_EXCLUDE.has(key) || seen.has(key)) continue
    seen.add(key)
    deduped.push(flag)
  }
  return deduped
    .sort((a, b) => {
      const rankA = SIGNAL_RANK.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      const rankB = SIGNAL_RANK.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
      return rankA - rankB
    })
    .slice(0, Math.max(0, limit))
}
