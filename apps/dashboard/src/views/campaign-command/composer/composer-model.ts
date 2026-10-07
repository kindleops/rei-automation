/**
 * CAMPAIGN COMPOSER 2.0 — the composition model. Pure.
 *
 * The Composer renders domain state; it never decides eligibility. What lives
 * here is arithmetic over numbers the server returned (segment widths, the
 * capacity instrument, zone waves on a time axis) and the checklist that maps
 * those numbers to readiness lines. Anything the server has not answered is
 * `checking` or `unavailable` — never a zero, never a guess.
 */
import type { ComposerAudience, ComposerCohort, ComposerCoverage, ComposerFleet, ComposerTemplates, CoverageMarket, ServerReadiness } from './composer-types'
import { reasonWords } from './composer-format'

/* ── composition ─────────────────────────────────────────────────────────── */

export type FilterClause = {
  id: string
  domain: string
  category: string
  fieldKey: string
  label: string
  operator: string
  value: unknown
}

export type ComposerSourceKind = 'market' | 'zip' | 'county' | 'filters' | 'map_area' | 'graph_selection' | 'property_set' | 'reengagement' | 'draft'
export type ComposerSource = { kind: ComposerSourceKind; label: string; detail?: string | null; campaign_id?: string | null }

export type StartPlan = { mode: 'now' | 'at'; at: string | null }
/** 'all' = every eligible seller (no total cap) · 'custom' = the stated number · null = not chosen */
export type CampaignSize = 'all' | 'custom' | null

export type Composition = {
  name: string
  description: string
  template_use_case: string
  stage_code: string
  filters: FilterClause[]
  source: ComposerSource | null
  daily_cap: string
  /** the operator's explicit Campaign size choice; null = not chosen yet (launch blocked) */
  campaign_size: CampaignSize
  total_cap: string
  per_sender_cap: string
  send_interval_seconds: string
  contact_window_start: string
  contact_window_end: string
  start: StartPlan
}

/**
 * Defaults: 750/day, 45 s, 08:00–21:00. Stated, editable, never hidden.
 * Campaign size has NO default (owner rule 2026-10-03): the old silent 1,000
 * cap built 552 of Minneapolis' 2,552 ready sellers without anyone choosing it.
 */
export const COMPOSER_DEFAULTS = Object.freeze({ total_cap: '', daily_cap: '750', send_interval_seconds: '45', window_start: '08:00', window_end: '21:00' })

export function emptyComposition(): Composition {
  return {
    name: '',
    description: '',
    template_use_case: 'ownership_check',
    stage_code: 'S1',
    filters: [],
    source: null,
    daily_cap: COMPOSER_DEFAULTS.daily_cap,
    campaign_size: null,
    total_cap: COMPOSER_DEFAULTS.total_cap,
    per_sender_cap: '',
    send_interval_seconds: COMPOSER_DEFAULTS.send_interval_seconds,
    contact_window_start: COMPOSER_DEFAULTS.window_start,
    contact_window_end: COMPOSER_DEFAULTS.window_end,
    start: { mode: 'now', at: null },
  }
}

export const DOMAINS = ['properties', 'prospects', 'master_owners', 'phones', 'outreach', 'sender_coverage'] as const

/** Grouped filters in the exact shape the campaign endpoints read (metadata.target_filters). */
export function serializeClauses(filters: FilterClause[]): Record<string, Array<Record<string, unknown>>> {
  const out: Record<string, Array<Record<string, unknown>>> = Object.fromEntries(DOMAINS.map((d) => [d, []]))
  for (const f of filters) {
    if (!hasValue(f)) continue
    const domain = (DOMAINS as readonly string[]).includes(f.domain) ? f.domain : 'properties'
    out[domain].push({ field_key: f.fieldKey, operator: f.operator, value: f.value, domain, category: f.category })
  }
  return out
}

export function hasValue(f: Pick<FilterClause, 'operator' | 'value'>): boolean {
  if (['is_empty', 'is_not_empty', 'is_true', 'is_false'].includes(f.operator)) return true
  const v = f.value
  if (Array.isArray(v)) return v.some((x) => String(x ?? '').trim() !== '')
  if (v && typeof v === 'object') return true
  return String(v ?? '').trim() !== ''
}

let clauseSeq = 0
export const clauseId = () => `cz${Date.now().toString(36)}${(clauseSeq++).toString(36)}`

/** Rehydrate a saved campaign's grouped filters into clauses. */
export function clausesFromTargetFilters(groups: unknown, labelOf: (key: string) => string = (k) => k): FilterClause[] {
  const out: FilterClause[] = []
  if (!groups || typeof groups !== 'object') return out
  for (const domain of DOMAINS) {
    const list = (groups as Record<string, unknown>)[domain]
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      const fieldKey = String(r.field_key ?? r.fieldKey ?? '').trim()
      if (!fieldKey) continue
      out.push({ id: clauseId(), domain, category: String(r.category ?? ''), fieldKey, label: labelOf(fieldKey), operator: String(r.operator ?? 'is_any_of'), value: r.value })
    }
  }
  return out
}

/** The source a composition's filters amount to, when nothing more specific was recorded. */
export function inferSource(filters: FilterClause[]): ComposerSource | null {
  if (!filters.length) return null
  const area = filters.find((f) => f.fieldKey === 'properties.drawn_area')
  if (area) return { kind: 'map_area', label: 'Map area' }
  const ids = filters.find((f) => f.fieldKey === 'properties.property_id')
  if (ids) {
    const n = Array.isArray(ids.value) ? ids.value.length : 1
    return { kind: 'property_set', label: `${n.toLocaleString('en-US')} selected ${n === 1 ? 'property' : 'properties'}` }
  }
  const market = filters.find((f) => f.fieldKey === 'properties.market')
  if (market && filters.length === 1) {
    const values = Array.isArray(market.value) ? market.value.map(String) : [String(market.value)]
    return { kind: 'market', label: values.length > 2 ? `${values.length} markets` : values.join(' + ') }
  }
  return { kind: 'filters', label: `${filters.length} ${filters.length === 1 ? 'filter' : 'filters'}` }
}

/** What a server-side composition carries (the save action's `composition`). Never status / automation. */
export function compositionPayload(c: Composition) {
  return {
    name: c.name.trim(),
    description: c.description,
    template_use_case: c.template_use_case,
    stage_code: c.stage_code,
    target_filters: serializeClauses(c.filters),
    daily_cap: c.daily_cap,
    campaign_size: c.campaign_size,
    total_cap: c.campaign_size === 'custom' ? c.total_cap : '',
    per_sender_cap: c.per_sender_cap,
    send_interval_seconds: c.send_interval_seconds,
    contact_window_start: c.contact_window_start,
    contact_window_end: c.contact_window_end,
    planned_start_at: c.start.mode === 'at' ? c.start.at : null,
    source: c.source,
  }
}

/** The audience read's key: only inputs that change the server's answer. */
export function audienceSpec(c: Composition) {
  return {
    filters: serializeClauses(c.filters),
    template_use_case: c.template_use_case,
    stage_code: c.stage_code,
    total_cap: c.campaign_size === 'custom' ? c.total_cap : '',
    daily_cap: c.daily_cap,
  }
}

/* ── numbers ─────────────────────────────────────────────────────────────── */

export const n0 = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
export const fmt = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—')

/** Parse an operator cap: '' → null (unset), '0' → 0 (send nothing, D9b), invalid → NaN. */
export function parseCap(value: string): number | null {
  const s = String(value ?? '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n >= 0 ? n : Number.NaN
}

export type Segment = { key: string; label: string; count: number; tone: 'exec' | 'ok' | 'attn' | 'crit' | 'neutral' | 'flow'; explain: string }

/** The matched universe, partitioned by the graph's own exclusions (one unit: properties). */
export function universeSegments(a: ComposerAudience | null): Segment[] {
  if (!a || a.matched === null) return []
  const ex = a.exclusions
  const suppressed = n0(ex.suppressed) + n0(ex.dnc) + n0(ex.wrong_number)
  const parts: Segment[] = [
    { key: 'clean', label: 'Clean', count: n0(a.clean), tone: 'exec', explain: 'Reachable, SMS-eligible, not suppressed' },
    { key: 'suppressed', label: 'Suppressed', count: suppressed, tone: 'attn', explain: 'Opted out, DNC or wrong number — never messaged' },
    { key: 'no_phone', label: 'No phone', count: n0(ex.no_phone), tone: 'neutral', explain: 'No reachable phone on the property' },
    { key: 'sms_ineligible', label: 'Not SMS-capable', count: n0(ex.sms_ineligible), tone: 'neutral', explain: 'Phone exists but cannot receive SMS' },
  ]
  const known = parts.reduce((s, p) => s + p.count, 0)
  const other = Math.max(0, n0(a.matched) - known)
  if (other > 0) parts.push({ key: 'other', label: 'Other', count: other, tone: 'neutral', explain: 'Overlapping or unclassified graph exclusions' })
  return parts.filter((p) => p.count > 0)
}

/** The simulated build (one unit: recipients), what Build will actually write. */
export function buildSegments(a: ComposerAudience | null): Segment[] {
  const b = a?.build
  if (!b || !b.ok) return []
  const held = n0(b.held)
  const noRoute = n0(b.no_sendable_number)
  return [
    { key: 'ready', label: 'Ready', count: eligibleOf(a) ?? 0, tone: 'ok' as const, explain: 'Will be scheduled' },
    { key: 'no_route', label: 'No sender route', count: noRoute, tone: 'attn' as const, explain: 'No sendable number in their market today' },
    { key: 'held', label: 'Held', count: held, tone: 'attn' as const, explain: 'Held at build (identity review, linkage)' },
    { key: 'dupes', label: 'Duplicate phones', count: n0(b.duplicates_collapsed), tone: 'neutral' as const, explain: 'One phone, several properties — messaged once' },
  ].filter((p) => p.count > 0)
}

/** Eligible = the build's ready recipients that a sender can carry. Null until the server answers. */
export function eligibleOf(a: ComposerAudience | null): number | null {
  const b = a?.build
  if (!b || !b.ok || b.ready === null || b.ready === undefined) return null
  // whole cohort: ready, carried by a sender, and the greeting renders (render lint counted)
  if (typeof b.sendable_after_personalization === 'number') return Math.max(0, b.sendable_after_personalization)
  // sample: carried by a sender and the language has a template (render's language hold counted)
  if (typeof b.sendable_after_language === 'number') return Math.max(0, b.sendable_after_language)
  // the planner's router answered per market: sendable_now is the ready set a sender can carry
  if (typeof b.sendable_now === 'number') return Math.max(0, b.sendable_now)
  return Math.max(0, n0(b.ready) - n0(b.no_sendable_number))
}

export type SendableBlocker = {
  /** "0 sendable · 2,249 eligible · no sending number in St. Louis, MO — add a number or enable a regional pool" */
  text: string
  /** true when nothing in the audience can be sent (the headline reads 0 because of routing) */
  zero: boolean
  markets: Array<{ market: string; sellers: number; why: string }>
}

const listMarkets = (names: string[]) =>
  names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more ${names.length - 2 === 1 ? 'market' : 'markets'}`

/**
 * Why the eligible count is lower than the audience because of SENDER ROUTING —
 * never a bare 0. Read from the server's own answers only: the whole-cohort
 * router (build.sender_markets, the planner's chooseTextgridNumber per market)
 * and the graph's no_sender_coverage exclusion. Null when routing removes no one.
 * The UI states it; it decides nothing (no number is bought, no pool enabled).
 */
export function sendableBlocker(a: ComposerAudience | null): SendableBlocker | null {
  const b = a?.build
  if (!a || !b || !b.ok) return null
  const eligible = eligibleOf(a)
  if (eligible === null) return null
  const routed = (b.sender_markets ?? []).filter((m) => m.sendable === false && n0(m.sellers) > 0)
  const graphNoRoute = n0(a.exclusions?.no_sender_route)
  const noRoute = routed.length ? routed.reduce((s, m) => s + n0(m.sellers), 0) : n0(b.no_sendable_number)
  if (noRoute <= 0 && graphNoRoute <= 0) return null
  const markets = routed.map((m) => ({
    market: m.market,
    sellers: n0(m.sellers),
    why: m.block_reason === 'NO_VALID_LOCAL_TEXTGRID_NUMBER' || !m.block_reason
      ? `no sending number in ${m.market}`
      : `no eligible sender in ${m.market} (${reasonWords(m.block_reason)})`,
  }))
  const noNumber = markets.filter((m) => m.why.startsWith('no sending number')).map((m) => m.market)
  const other = markets.filter((m) => !m.why.startsWith('no sending number')).map((m) => m.market)
  const whyText = markets.length
    ? [
        noNumber.length ? `no sending number in ${listMarkets(noNumber)}` : null,
        other.length ? `no eligible sender in ${listMarkets(other)} (blocked, paused or cooling)` : null,
      ].filter(Boolean).join('; ')
    : 'no sending number in their market'
  const action = noNumber.length || !markets.length ? 'add a number or enable a regional pool' : 'restore a healthy sender or enable a regional pool'
  const zero = eligible === 0
  const eligibleCount = typeof a.eligible_in_audience === 'number' && a.eligible_in_audience > 0 ? a.eligible_in_audience : null
  const text = zero
    ? [
        '0 sendable',
        eligibleCount !== null ? `${fmt(eligibleCount)} eligible` : graphNoRoute > 0 ? `${fmt(graphNoRoute)} without a sender route` : null,
        `${whyText} — ${action}`,
      ].filter(Boolean).join(' · ')
    : noRoute > 0
      ? `${fmt(noRoute)} ready ${noRoute === 1 ? 'seller is' : 'sellers are'} not sendable · ${whyText} — ${action}`
      : `${fmt(graphNoRoute)} ${graphNoRoute === 1 ? 'property has' : 'properties have'} no sender route · ${whyText} — ${action}`
  return { text, zero, markets }
}

/**
 * Fold the whole-cohort count (the build's pipeline over every readable row)
 * into the audience: eligible, holds, routes and recipient zones become
 * authoritative; the preview keeps its samples and graph exclusions.
 */
export function withCohort(a: ComposerAudience | null, cohort: ComposerCohort | null): ComposerAudience | null {
  if (!a || !cohort) return a
  const zones = Object.entries(cohort.ready_by_zone).map(([value, count]) => ({ value, label: value, count }))
  return {
    ...a,
    build: {
      ok: true,
      whole_cohort: true,
      capped_by_build_limit: cohort.capped_by_build_limit,
      build_limit: cohort.build_limit,
      timings_ms: cohort.timings_ms,
      requested_limit: cohort.build_limit,
      simulated_limit: cohort.build_limit,
      rows_read: cohort.rows_read,
      recipients: cohort.recipients,
      duplicates_collapsed: cohort.duplicates_collapsed,
      built: cohort.recipients,
      ready: cohort.ready,
      held: cohort.held,
      held_by_reason: cohort.held_by_reason,
      sendable_now: cohort.sendable_now,
      no_sendable_number: cohort.no_sendable_number,
      sender_markets: cohort.sender_markets,
      personalization: cohort.personalization ?? null,
      language_holds: cohort.language_holds ?? null,
      sendable_after_personalization: cohort.sendable_after_personalization ?? null,
    },
    distributions: {
      ...a.distributions,
      zones: zones.filter((z) => z.value !== 'unresolved'),
      // every ready seller's market, so routing coverage is asked about the whole cohort
      markets: Object.keys(cohort.ready_by_market).length
        ? Object.entries(cohort.ready_by_market).map(([value, count]) => ({ value, label: value, count })).sort((x, y) => y.count - x.count)
        : a.distributions.markets,
    },
    zones: { scanned: cohort.ready, unresolved: cohort.ready_by_zone.unresolved ?? 0 },
  }
}

/** True when the simulated build read fewer rows than the audience holds (the count is a sample of the cohort). */
export function buildIsPartial(a: ComposerAudience | null): boolean {
  const b = a?.build
  if (!b?.ok) return false
  if (b.whole_cohort) return Boolean(b.capped_by_build_limit)
  return n0(a?.eligible_in_audience) > n0(b.rows_read) && n0(b.rows_read) >= n0(b.simulated_limit)
}

export const HELD_REASON_WORDS: Record<string, string> = {
  entity_contact_requires_review: 'Entity contact needs review',
  missing_identity_linkage: 'Missing identity linkage',
  missing_timezone: 'Timezone unavailable',
  invalid_timezone: 'Timezone invalid',
  recipient_timezone_unresolved: 'Timezone unavailable',
}
export const heldWords = (key: string) => HELD_REASON_WORDS[key] ?? key.replace(/_/g, ' ')

/* ── fleet + capacity ────────────────────────────────────────────────────── */

const stateOfMarket = (market: string | null | undefined) => {
  const m = /,\s*([A-Za-z]{2})\s*$/.exec(String(market ?? ''))
  return m ? m[1].toUpperCase() : null
}

/**
 * The audience's markets with their seller counts — the input of the routing
 * engine's coverage read. Whole-cohort ready sellers per market once counted,
 * else the sample's market split.
 */
export function coverageMarkets(a: ComposerAudience | null): Array<{ market: string; state: string | null; targets: number }> {
  return (a?.distributions.markets ?? [])
    .filter((m) => m.value && m.value !== 'unknown')
    .map((m) => ({ market: m.value, state: stateOfMarket(m.value), targets: m.count }))
}

const UNAVAILABLE_WORDS: Record<string, string> = {
  health_cooling: 'cooling', cooling_until: 'cooling', blocked_by_operator: 'blocked', status_paused: 'paused', daily_limit_reached: 'at cap',
}
export const unavailableWord = (reason: string) => {
  const r = reason.replace(/^outbound_number_/, '')
  return UNAVAILABLE_WORDS[r] ?? (r.startsWith('health_') ? 'unhealthy' : r.replace(/_/g, ' '))
}

/** Numbers the engine cannot use for these markets, by reason (each number once). */
export function unavailableSummary(markets: CoverageMarket[]): { count: number; text: string | null } {
  const seen = new Map<string, string>()
  for (const m of markets) for (const u of m.unavailable ?? []) for (const r of u.reasons ?? []) seen.set(`${u.pool}:${r.phone}`, unavailableWord(r.reason))
  const by: Record<string, number> = {}
  for (const w of seen.values()) by[w] = (by[w] ?? 0) + 1
  const text = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ')
  return { count: seen.size, text: text || null }
}

export type CapacityPlan = {
  /** what the dispatching engine's healthy numbers can still send today (each number counted once) */
  available_per_day: number
  unavailable_count: number
  unavailable_reason: string | null
  uncovered_markets: string[]
  uncovered_targets: number
  covered_targets: number
  /** what the contact window admits at the campaign's spacing (modeled) */
  window_per_day: number | null
  planned_per_day: number | null
  /** the modeled sends/day: min(daily cap, routed capacity, window) */
  effective_per_day: number | null
  binding: 'daily_cap' | 'sender_capacity' | 'contact_window' | 'cap_zero' | null
  over_capacity: boolean
}

export function windowMinutes(start: string, end: string): number | null {
  const p = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const a = p(start)
  const b = p(end)
  if (a === null || b === null || b <= a) return null
  return b - a
}

/** Capacity from the canonical routing engine's coverage (never the raw fleet). */
export function capacityPlan(coverage: ComposerCoverage | null, c: Pick<Composition, 'daily_cap' | 'send_interval_seconds' | 'contact_window_start' | 'contact_window_end'>): CapacityPlan {
  const markets = coverage?.markets ?? []
  const available = coverage ? n0(coverage.totals.distinct_daily_capacity) : 0
  const uncovered = markets.filter((m) => m.coverage === 'UNCOVERED')
  const unavailable = unavailableSummary(markets)
  const minutes = windowMinutes(c.contact_window_start, c.contact_window_end)
  const interval = Number(c.send_interval_seconds)
  const windowPerDay = minutes && interval > 0 ? Math.floor((minutes * 60) / interval) : null
  const cap = parseCap(c.daily_cap)
  const planned = cap === null || Number.isNaN(cap) ? null : cap
  const candidates: Array<[CapacityPlan['binding'], number]> = []
  if (planned !== null) candidates.push(['daily_cap', planned])
  if (coverage) candidates.push(['sender_capacity', available])
  if (windowPerDay !== null) candidates.push(['contact_window', windowPerDay])
  candidates.sort((x, y) => x[1] - y[1])
  return {
    available_per_day: available,
    unavailable_count: unavailable.count,
    unavailable_reason: unavailable.text,
    uncovered_markets: uncovered.map((m) => m.market),
    uncovered_targets: uncovered.reduce((s, m) => s + n0(m.targets), 0),
    covered_targets: markets.filter((m) => m.coverage !== 'UNCOVERED').reduce((s, m) => s + n0(m.targets), 0),
    window_per_day: windowPerDay,
    planned_per_day: planned,
    effective_per_day: candidates.length ? candidates[0][1] : null,
    binding: planned === 0 ? 'cap_zero' : candidates[0]?.[0] ?? null,
    over_capacity: Boolean(coverage) && planned !== null && planned > available,
  }
}

/** Snap a dragged volume back to what the fleet can carry, with the reason. */
export function snapVolume(requested: number, plan: CapacityPlan): { value: number; snapped: boolean; reason: string | null } {
  if (requested <= plan.available_per_day) return { value: Math.max(0, Math.round(requested)), snapped: false, reason: null }
  const over = Math.round(requested - plan.available_per_day)
  return {
    value: plan.available_per_day,
    snapped: true,
    reason: `+${over.toLocaleString('en-US')}/day unavailable${plan.unavailable_reason ? `: ${plan.unavailable_reason}` : ': no further routed sender capacity'}`,
  }
}

/** Estimated days to finish, with the held set as the uncertainty (they may clear review). */
export function completionEstimate(eligible: number | null, held: number | null, perDay: number | null): { low: number; high: number } | null {
  if (eligible === null || !perDay || perDay <= 0 || eligible <= 0) return null
  const low = Math.ceil(eligible / perDay)
  const high = Math.ceil((eligible + Math.max(0, held ?? 0)) / perDay)
  return { low, high }
}

/* ── time: recipient zones, windows, missed starts ───────────────────────── */

const ZONE_ORDER = ['America/New_York', 'America/Detroit', 'America/Indiana/Indianapolis', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu']
export const ZONE_SHORT: Record<string, string> = {
  'America/New_York': 'ET', 'America/Detroit': 'ET', 'America/Indiana/Indianapolis': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT',
  'America/Phoenix': 'MST', 'America/Los_Angeles': 'PT', 'America/Anchorage': 'AKT', 'Pacific/Honolulu': 'HT',
}

/** UTC offset (minutes) of a zone at an instant. */
export function zoneOffset(zone: string, at: Date): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(at).map((p) => [p.type, p.value]))
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute))
  return Math.round((local - Math.floor(at.getTime() / 60000) * 60000) / 60000)
}

/** The instant a zone's local HH:MM falls on the local date of `day`. */
export function zonedInstant(zone: string, day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number)
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(day).map((p) => [p.type, p.value]))
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), h, m)
  const off = zoneOffset(zone, new Date(guess))
  return new Date(guess - off * 60000)
}

export type ZoneWave = { zone: string; short: string; count: number; windows: Array<{ start: number; end: number }> }

/**
 * Recipient-local contact windows on one absolute axis, east to west. Only
 * zones the cohort actually has; an unresolved zone is never placed on any.
 */
export function zoneWaves(zones: Array<{ value: string; count: number }>, window: { start: string; end: string }, from: number, hours: number): ZoneWave[] {
  const to = from + hours * 3600_000
  const ordered = [...zones].filter((z) => z.value && z.value !== 'unresolved' && z.count > 0)
    .sort((a, b) => (ZONE_ORDER.indexOf(a.value) + 1 || 99) - (ZONE_ORDER.indexOf(b.value) + 1 || 99))
  return ordered.map((z) => {
    const windows: Array<{ start: number; end: number }> = []
    for (let d = -1; d <= Math.ceil(hours / 24) + 1; d += 1) {
      const day = new Date(from + d * 86400_000)
      const s = zonedInstant(z.value, day, window.start).getTime()
      const e = zonedInstant(z.value, day, window.end).getTime()
      if (e > from && s < to && !windows.some((w) => w.start === s)) windows.push({ start: Math.max(s, from), end: Math.min(e, to) })
    }
    return { zone: z.value, short: ZONE_SHORT[z.value] ?? z.value.split('/').pop()!.replace(/_/g, ' '), count: z.count, windows: windows.sort((a, b) => a.start - b.start) }
  })
}

/** Is any recipient zone's window open at `at`? Per zone — never one campaign zone. */
export function openZonesAt(waves: ZoneWave[], at: number): string[] {
  return waves.filter((w) => w.windows.some((x) => at >= x.start && at < x.end)).map((w) => w.short)
}

export type ScheduleCheck =
  | { state: 'ok'; text: string; openZones: string[] }
  | { state: 'warn'; text: string; openZones: string[]; nextOpenAt: number | null }
  | { state: 'missed'; text: string }
  | { state: 'invalid'; text: string }

/** The D4 rule from the operator's side: a start is now, or in the future; a passed start is Start now / Reschedule. */
export function checkSchedule(start: StartPlan, waves: ZoneWave[], now: number): ScheduleCheck {
  let at = now
  if (start.mode === 'at') {
    const t = Date.parse(start.at ?? '')
    if (!Number.isFinite(t)) return { state: 'invalid', text: 'Start time is not a valid date' }
    if (t <= now + 60_000) return { state: 'missed', text: 'That start has passed — it will not fire late. Start now, or reschedule.' }
    at = t
  }
  if (!waves.length) return { state: 'ok', text: start.mode === 'now' ? 'Starts on launch' : 'Scheduled start', openZones: [] }
  const open = openZonesAt(waves, at)
  if (open.length) return { state: 'ok', text: `Texting hours open in ${open.join(', ')}`, openZones: open }
  const next = waves.flatMap((w) => w.windows.map((x) => x.start)).filter((s) => s > at).sort((a, b) => a - b)[0] ?? null
  return { state: 'warn', text: 'Outside every recipient’s texting hours — nothing sends until a window opens', openZones: [], nextOpenAt: next }
}

/* ── readiness ───────────────────────────────────────────────────────────── */

export type CheckState = 'checking' | 'ok' | 'warn' | 'block'
export type Layer = 'audience' | 'strategy' | 'delivery' | 'schedule' | 'launch'
export type ReadinessCheck = { key: string; label: string; state: CheckState; text: string; layer: Layer }
export type ReadinessView = { state: 'checking' | 'ready' | 'warning' | 'blocked'; checks: ReadinessCheck[]; blockers: number; warnings: number }

export type ReadinessInput = {
  composition: Composition
  audience: ComposerAudience | null
  audienceError: string | null
  audienceLoading: boolean
  templates: ComposerTemplates | null
  fleet: ComposerFleet | null
  coverage: ComposerCoverage | null
  coverageError?: string | null
  online: boolean
  now: number
  waves: ZoneWave[]
  server?: ServerReadiness | null
}

export function deriveReadiness(i: ReadinessInput): ReadinessView {
  const checks: ReadinessCheck[] = []
  const add = (key: string, label: string, layer: Layer, state: CheckState, text: string) => checks.push({ key, label, layer, state, text })
  const c = i.composition
  const a = i.audience

  if (!i.online) add('connection', 'Connection', 'launch', 'block', 'Connection lost — readiness can’t be verified')

  // audience
  if (!c.filters.length) add('audience', 'Audience', 'audience', 'block', 'Choose or drop an audience')
  else if (i.audienceError) add('audience', 'Audience', 'audience', 'block', `Audience couldn’t be read — ${i.audienceError}`)
  else if (!a || i.audienceLoading) add('audience', 'Audience', 'audience', 'checking', 'Counting the cohort…')
  else {
    const eligible = eligibleOf(a)
    if (a.graph_unavailable) add('audience', 'Audience', 'audience', 'block', 'The target graph is unavailable')
    else if (!a.build.whole_cohort && eligible !== null && eligible > 0) add('audience', 'Audience', 'audience', 'checking', `Counting the whole cohort — ${fmt(eligible)} eligible in the first ${fmt(a.build.rows_read)} read`)
    else if (eligible === null) add('audience', 'Audience', 'audience', 'block', `Build simulation failed${a.build.error ? ` — ${a.build.error}` : ''}`)
    else if (eligible === 0) {
      const blocker = sendableBlocker(a)
      add('audience', 'Audience', 'audience', 'block', blocker?.zero ? blocker.text : 'Zero eligible prospects')
    }
    else add('audience', 'Audience', 'audience', 'ok', `${fmt(eligible)} eligible`)
    const dropped = a.dropped_filter_count + a.inapplicable_filters.length
    if (dropped) add('filters', 'Filters', 'audience', 'warn', `${dropped} ${dropped === 1 ? 'filter' : 'filters'} can’t narrow this audience`)
    const suppressed = n0(a.exclusions.suppressed) + n0(a.exclusions.dnc) + n0(a.exclusions.wrong_number)
    add('suppression', 'Suppression', 'audience', 'ok', suppressed ? `${fmt(suppressed)} suppressed — excluded` : 'No suppressed prospects matched')
  }

  // strategy / templates
  const strategy = i.templates?.strategies.find((s) => s.use_case === c.template_use_case)
  if (!i.templates) add('templates', 'Templates', 'strategy', 'checking', 'Reading template coverage…')
  else if (!strategy || strategy.sendable === 0) add('templates', 'Templates', 'strategy', 'block', 'No sendable template for this strategy')
  else {
    const failed = (a?.samples ?? []).filter((s) => !s.ok)
    const allFailed = (a?.samples?.length ?? 0) > 0 && failed.length === a!.samples.length
    if (allFailed) add('templates', 'Templates', 'strategy', 'block', `No sample rendered — ${reasonWords(failed[0]?.reason) || 'render failed'}`)
    else if (failed.length) add('templates', 'Templates', 'strategy', 'warn', `${failed.length} of ${a!.samples.length} samples didn’t render (${reasonWords(failed[0].reason).toLowerCase()}) — those sellers are held at build`)
    else add('templates', 'Templates', 'strategy', a?.samples?.length ? 'ok' : 'checking', `${fmt(strategy.sendable)} sendable templates`)
    if (!i.templates.governance_readable) add('governance', 'Governance', 'strategy', 'warn', 'Template governance unreadable — the plan refuses governed templates')
  }

  // delivery
  const markets = coverageMarkets(a)
  if (i.coverageError && !i.coverage) add('senders', 'Sender routing', 'delivery', 'block', `Routing coverage couldn’t be read — ${i.coverageError}`)
  else if (!i.coverage || (a && !markets.length && c.filters.length)) add('senders', 'Sender routing', 'delivery', 'checking', 'Asking the routing engine…')
  {
    const plan = capacityPlan(i.coverage, c)
    if (i.coverage) {
      const total = plan.covered_targets + plan.uncovered_targets
      if (total > 0 && plan.covered_targets === 0) add('senders', 'Sender routing', 'delivery', 'block', `No route for ${plan.uncovered_markets.join(', ')}`)
      else if (plan.uncovered_targets) add('senders', 'Sender routing', 'delivery', 'warn', `No route for ${plan.uncovered_markets.join(', ')} — ${fmt(plan.uncovered_targets)} sellers won’t send`)
      else if (total > 0) add('senders', 'Sender routing', 'delivery', i.coverage.markets.some((m) => m.coverage === 'DEGRADED') ? 'warn' : 'ok', `Every market routed · ${fmt(i.coverage.totals.distinct_healthy_numbers)} healthy ${i.coverage.totals.distinct_healthy_numbers === 1 ? 'number' : 'numbers'}`)
    }
    const cap = parseCap(c.daily_cap)
    if (Number.isNaN(cap)) add('capacity', 'Capacity', 'delivery', 'block', 'Daily cap must be a whole number')
    else if (cap === null) add('capacity', 'Capacity', 'delivery', 'block', 'Set a daily cap')
    else if (cap === 0) add('capacity', 'Capacity', 'delivery', 'block', 'Daily cap 0 — sends nothing')
    else if (plan.over_capacity) add('capacity', 'Capacity', 'delivery', 'warn', `Planned ${fmt(cap)}/day exceeds ${fmt(plan.available_per_day)}/day routable today`)
    else add('capacity', 'Capacity', 'delivery', 'ok', `${fmt(plan.effective_per_day)}/day modeled`)
    const sizeCheck = campaignSizeCheck(c, eligibleOf(a))
    add('size', 'Campaign size', 'delivery', sizeCheck.state, sizeCheck.text)
    const sys = i.fleet?.system
    if (!sys) { /* brakes read with the system controls below */ }
    else if (sys.emergency_stop_at) add('brakes', 'System brakes', 'launch', 'warn', 'Emergency stop is active — rows hydrate, nothing transmits')
    else if (sys.outbound_sms_enabled === false) add('brakes', 'System brakes', 'launch', 'block', 'Outbound SMS is disabled')
    else if ((sys.processor_mode ?? '').toLowerCase() === 'off') add('brakes', 'System brakes', 'launch', 'warn', 'Queue processor is off — rows wait')
  }

  // schedule / windows
  if (windowMinutes(c.contact_window_start, c.contact_window_end) === null) add('windows', 'Contact windows', 'schedule', 'block', 'Contact window is invalid')
  else if (a && a.zones.unresolved > 0) add('windows', 'Contact windows', 'schedule', 'warn', `Timezone unavailable for ${fmt(a.zones.unresolved)} of ${fmt(a.zones.scanned)} read — held, never defaulted`)
  else if (a) add('windows', 'Contact windows', 'schedule', 'ok', `${i.waves.length} recipient ${i.waves.length === 1 ? 'zone' : 'zones'}`)
  const sched = checkSchedule(c.start, i.waves, i.now)
  if (sched.state === 'missed' || sched.state === 'invalid') add('schedule', 'Schedule', 'schedule', 'block', sched.text)
  else add('schedule', 'Schedule', 'schedule', sched.state === 'warn' ? 'warn' : 'ok', sched.text)

  // automation (shown, never changed here)
  add('automation', 'Automation', 'strategy', 'ok', 'Auto send and auto reply unchanged by this composition')

  if (!c.name.trim()) add('name', 'Name', 'launch', 'block', 'Name the campaign')

  // the server's own preflight, once prepared, is authoritative
  if (i.server) {
    for (const [idx, b] of i.server.blockers.entries()) add(`server-b${idx}`, 'Preflight', 'launch', 'block', b)
    for (const [idx, w] of i.server.warnings.slice(0, 4).entries()) add(`server-w${idx}`, 'Preflight', 'launch', 'warn', w)
    if (!(n0(i.server.launch_ready) > 0)) add('server-zero', 'Preflight', 'launch', 'block', 'Preflight found zero launch-ready prospects')
  }

  const blockers = checks.filter((x) => x.state === 'block').length
  const warnings = checks.filter((x) => x.state === 'warn').length
  const checking = checks.some((x) => x.state === 'checking')
  return {
    state: blockers ? 'blocked' : checking ? 'checking' : warnings ? 'warning' : 'ready',
    checks: [...checks].sort((x, y) => rank(x.state) - rank(y.state)),
    blockers,
    warnings,
  }
}
const rank = (s: CheckState) => (s === 'block' ? 0 : s === 'warn' ? 1 : s === 'checking' ? 2 : 3)

/* ── diff + copy ─────────────────────────────────────────────────────────── */

const DIFF_FIELDS: Array<[keyof Composition, string]> = [
  ['name', 'Name'], ['template_use_case', 'Strategy'], ['daily_cap', 'Daily cap'], ['campaign_size', 'Campaign size choice'], ['total_cap', 'Campaign size'],
  ['per_sender_cap', 'Per-number cap'], ['send_interval_seconds', 'Spacing'], ['contact_window_start', 'Window opens'], ['contact_window_end', 'Window closes'],
]

/** What an edit changes against the saved draft. */
export function compositionDiff(base: Composition | null, next: Composition): Array<{ label: string; from: string; to: string }> {
  if (!base) return []
  const out: Array<{ label: string; from: string; to: string }> = []
  for (const [key, label] of DIFF_FIELDS) {
    const a = String(base[key] ?? '')
    const b = String(next[key] ?? '')
    if (a !== b) out.push({ label, from: a || '—', to: b || '—' })
  }
  const fa = JSON.stringify(serializeClauses(base.filters))
  const fb = JSON.stringify(serializeClauses(next.filters))
  if (fa !== fb) out.push({ label: 'Audience', from: `${base.filters.length} filters`, to: `${next.filters.length} filters` })
  const sa = base.start.mode === 'at' ? base.start.at ?? '' : 'now'
  const sb = next.start.mode === 'at' ? next.start.at ?? '' : 'now'
  if (sa !== sb) out.push({ label: 'Start', from: sa, to: sb })
  return out
}

export function launchSentence(eligible: number, start: StartPlan): string {
  const who = `${fmt(eligible)} eligible ${eligible === 1 ? 'prospect' : 'prospects'}`
  return start.mode === 'now'
    ? `${who} will start now through recipient-local contact windows.`
    : `${who} will be scheduled through recipient-local contact windows.`
}

/** The Composer reads launch failures in plain words; the code stays visible for support. */
export const LAUNCH_ERROR_WORDS: Record<string, string> = {
  launch_blocked: 'Preflight blocked the launch',
  zero_eligible: 'Zero eligible prospects — nothing to launch',
  eligible_changed: 'The eligible count changed since you reviewed it',
  start_in_past: 'That start has passed — Start now, or reschedule',
  start_invalid: 'The start time is invalid',
  readiness_unavailable: 'Readiness couldn’t be verified — nothing was launched',
  campaign_not_editable: 'This campaign is no longer a draft',
  build_failed: 'Targets couldn’t be built',
  composer_write_failed: 'The server refused the request',
  network: 'Connection lost — nothing was launched',
  already_launched: 'This campaign was already launched (another tab or operator)',
  launch_in_progress: 'A launch for this campaign is already running — wait for it',
  campaign_not_launchable: 'This campaign is no longer a draft',
  launch_claim_unavailable: 'The launch couldn’t be claimed safely — nothing was launched',
}

/* ── audience funnel (owner rule 2026-10-03: every count auditable) ───────── */

export type FunnelReason = { label: string; count: number }
export type FunnelStage = {
  key: string
  label: string
  /** null = this stage was not measured (never a guess) */
  count: number | null
  /** removed at this stage relative to the previous measured stage */
  dropped: number | null
  /** graph = whole graph count · cohort = the build's whole-cohort pipeline · sample = the first N rows Build reads */
  basis: 'graph' | 'cohort' | 'sample'
  reasons: FunnelReason[]
  note?: string
}

const reason = (label: string, count: number | null | undefined): FunnelReason | null => (count && count > 0 ? { label, count } : null)
const present = (xs: Array<FunnelReason | null>): FunnelReason[] => xs.filter((x): x is FunnelReason => x !== null).sort((x, y) => y.count - x.count)

/** "Farsi 6 · Thai 3 · Pashto 1", largest first. */
export function languageBreakdown(byLanguage: Record<string, number> = {}): string {
  return Object.entries(byLanguage).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([l, n]) => `${l} ${fmt(n)}`).join(' · ')
}

/**
 * market universe → filters matched → reachable phone → verified SMS-capable →
 * not suppressed / not recently touched → built (deduped, holds) →
 * message language supported → personalization present → routing eligible. Units: graph rows (properties)
 * through "queue-ready", recipients after. Every count is a server number;
 * a stage the server did not measure says so.
 */
export function audienceFunnel(a: ComposerAudience | null, labelOf: (key: string) => string = (k) => k): FunnelStage[] {
  if (!a || a.matched === null) return []
  const ex = a.exclusions
  const b = a.build
  const stages: FunnelStage[] = []
  const push = (s: Omit<FunnelStage, 'dropped'>) => {
    const prev = [...stages].reverse().find((x) => x.count !== null)
    stages.push({ ...s, dropped: s.count !== null && prev && prev.count !== null ? Math.max(0, prev.count - s.count) : null })
  }
  const universe = a.universe?.count ?? null
  push({
    key: 'universe', label: 'Market universe', basis: 'graph', count: universe ?? a.matched, reasons: [],
    note: universe === null ? 'Location-only count unavailable — showing the matched audience' : undefined,
  })
  push({
    key: 'filters', label: 'Filters matched', basis: 'graph', count: a.matched,
    reasons: (a.universe?.targeting_filters ?? []).map((k) => ({ label: labelOf(k), count: 0 })),
    note: a.universe?.targeting_filters?.length ? undefined : 'No targeting filters beyond location',
  })
  push({ key: 'reachable', label: 'Reachable phone', basis: 'graph', count: a.reachable, reasons: present([reason('No phone on file', ex.no_phone)]) })
  push({
    key: 'sms', label: 'Verified SMS-capable', basis: 'graph', count: a.sms_eligible,
    reasons: present([reason('Landline or unknown phone type', ex.sms_ineligible), reason('Wrong number', ex.wrong_number)]),
  })
  push({
    key: 'clean', label: 'Not suppressed or recently touched', basis: 'graph', count: a.eligible_in_audience,
    reasons: present([
      reason('Opted out / suppressed', ex.suppressed), reason('DNC', ex.dnc),
      reason('Texted in the last 30 days', ex.pending_prior_touch), reason('Already queued', ex.active_queue),
      reason('No sender route (graph)', ex.no_sender_route),
    ]),
  })
  if (!b.ok) return stages
  const basis: FunnelStage['basis'] = b.whole_cohort ? 'cohort' : 'sample'
  const sampleNote = b.whole_cohort ? undefined : `Sample — the first ${fmt(b.rows_read)} rows Build reads (Campaign size caps it); counting the whole cohort…`
  push({
    key: 'built', label: 'Built (one per phone, holds applied)', basis, count: b.ready ?? null, note: sampleNote,
    reasons: present([
      reason('Duplicate phone — messaged once', b.duplicates_collapsed),
      ...Object.entries(b.held_by_reason ?? {}).map(([k, v]) => reason(HELD_REASON_WORDS[k] ?? k.replace(/_/g, ' '), v)),
    ]),
  })
  // The renderer refuses a seller whose language has no supported template
  // (unsupported_language). Counted server-side with the renderer's predicate.
  const lh = b.language_holds
  const ready = b.ready ?? null
  if (lh) {
    push({
      key: 'language', label: 'Message language supported', basis,
      count: ready !== null ? Math.max(0, ready - n0(lh.held)) : null,
      reasons: lh.held > 0 ? [{ label: `No approved template in their language — ${languageBreakdown(lh.by_language)}`, count: lh.held }] : [],
    })
  } else {
    push({ key: 'language', label: 'Message language supported', basis, count: null, reasons: [], note: 'Language holds not measured by this server' })
  }
  const p = b.personalization
  if (p) {
    // lint refusals among the language-supported (held ones are already out)
    const refused = Math.max(0, n0(p.none) - n0(lh?.held_and_refused))
    push({
      key: 'personalization', label: 'Greeting personalization present', basis,
      count: ready !== null ? Math.max(0, ready - n0(lh?.held) - refused) : null,
      reasons: present([reason('No first name, company owner — render lint refuses', refused)]),
      note: p.deed_name ? `${fmt(p.deed_name)} have no first name on file and greet by the deed owner’s name` : undefined,
    })
  } else {
    push({ key: 'personalization', label: 'Greeting personalization present', basis, count: null, reasons: [], note: 'Measured on the whole-cohort count only' })
  }
  push({
    key: 'routing', label: 'Routing eligible (sender can carry)', basis, count: eligibleOf(a),
    reasons: present([reason('No sendable number in their market', b.no_sendable_number)]),
  })
  return stages
}

export type Freshness = { asOf: string | null; ageHours: number | null; stale: boolean; label: string; coverage: FunnelReason[] | null; coverageAt: string | null }

const COVERAGE_LABELS: Record<string, string> = {
  seller_first_name: 'First name', language: 'Language', gender: 'Gender', age_bucket: 'Age', income: 'Income',
  phone_type: 'Phone type', phone_owner: 'Carrier', phone_activity_status: 'Phone activity', last_outbound_at: 'Last outbound',
  units_count: 'Units', beds: 'Beds', year_built: 'Year built', building_condition: 'Condition', property_flags_text: 'Property flags',
  matching_flags_text: 'Seller flags', aos_score: 'Acquisition score (canonical)',
}

/** "Audience data as of …, N hours old" plus measured field coverage, from the server's timestamps. */
export function audienceFreshness(a: ComposerAudience | null, nowMs: number = Date.now()): Freshness | null {
  if (!a) return null
  const times = [a.graph_coverage?.latest_enriched_at, a.graph_freshness?.latest_generated_at, a.graph_freshness?.refresh_finished_at]
    .map((t) => (t ? Date.parse(t) : NaN)).filter((t) => Number.isFinite(t))
  const asOfMs = times.length ? Math.max(...times) : null
  const ageHours = asOfMs === null ? null : Math.max(0, Math.round((nowMs - asOfMs) / 3_600_000))
  const ageText = ageHours === null ? 'age unknown' : ageHours < 48 ? `${ageHours} ${ageHours === 1 ? 'hour' : 'hours'} old` : `${Math.round(ageHours / 24)} days old`
  const cov = a.graph_coverage?.coverage ?? null
  return {
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    ageHours,
    stale: ageHours === null || ageHours > 36,
    label: asOfMs === null ? 'Audience data age unknown' : `Audience data as of ${new Date(asOfMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${ageText}`,
    coverage: cov ? Object.entries(COVERAGE_LABELS).filter(([k]) => typeof cov[k] === 'number').map(([k, label]) => ({ label, count: Math.round(cov[k] * 100) })) : null,
    coverageAt: a.graph_coverage?.measured_at ?? null,
  }
}

/**
 * The numbers on the "All eligible" size choice. The choice builds the SENDABLE
 * cohort (eligibleOf: one per phone, sender-carried, personalization holds
 * applied) — the same number the headline and campaignSizeCheck use — never the
 * graph's queue-ready property count (`eligible_in_audience`, before the
 * one-per-phone dedupe). The property count is shown beside it, labelled, when
 * the two differ. Until the whole cohort is counted the chip carries no number
 * (a first-N-rows sample is not the size of "all").
 */
export function campaignSizeAllChoice(a: ComposerAudience | null): { count: number | null; detail: string | null } {
  const properties = typeof a?.eligible_in_audience === 'number' ? a.eligible_in_audience : null
  const whole = Boolean(a?.build?.ok && a.build.whole_cohort)
  const count = whole ? eligibleOf(a) : null
  if (count === null) return { count: null, detail: properties === null ? null : `${fmt(properties)} eligible properties · counting sendable phones…` }
  const phones = `${fmt(count)} unique sendable ${count === 1 ? 'phone' : 'phones'}`
  return { count, detail: properties !== null && properties !== count ? `${fmt(properties)} eligible properties · ${phones}` : phones }
}

/**
 * Campaign size, stated: launch is blocked until the operator picks "All
 * eligible" or a number. A number is never silently applied, and neither is All.
 */
export function campaignSizeCheck(c: Pick<Composition, 'campaign_size' | 'total_cap'>, eligible: number | null): { state: 'ok' | 'warn' | 'block'; text: string; builds: number | null } {
  if (c.campaign_size === null) return { state: 'block', text: 'Choose a campaign size — All eligible, or a number', builds: null }
  if (c.campaign_size === 'all') return { state: 'ok', text: eligible === null ? 'All eligible' : `All eligible — ${fmt(eligible)}`, builds: eligible }
  const size = parseCap(c.total_cap)
  if (Number.isNaN(size)) return { state: 'block', text: 'Campaign size must be a whole number', builds: null }
  if (size === null) return { state: 'block', text: 'Enter a campaign size, or choose All eligible', builds: null }
  if (size === 0) return { state: 'block', text: 'Campaign size 0 — sends nothing', builds: 0 }
  if (eligible !== null && size < eligible) return { state: 'warn', text: `Builds ${fmt(size)} of ${fmt(eligible)} eligible — ${fmt(eligible - size)} left out by the size you set`, builds: size }
  return { state: 'ok', text: eligible === null ? `${fmt(size)} sellers` : `${fmt(Math.min(size, eligible))} sellers (size ${fmt(size)})`, builds: eligible === null ? size : Math.min(size, eligible) }
}
