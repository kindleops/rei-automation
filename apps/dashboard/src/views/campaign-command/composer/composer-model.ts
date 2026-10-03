/**
 * CAMPAIGN COMPOSER 2.0 — the composition model. Pure.
 *
 * The Composer renders domain state; it never decides eligibility. What lives
 * here is arithmetic over numbers the server returned (segment widths, the
 * capacity instrument, zone waves on a time axis) and the checklist that maps
 * those numbers to readiness lines. Anything the server has not answered is
 * `checking` or `unavailable` — never a zero, never a guess.
 */
import type { ComposerAudience, ComposerFleet, ComposerTemplates, FleetNumber, ServerReadiness } from './composer-types'
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

export type Composition = {
  name: string
  description: string
  template_use_case: string
  stage_code: string
  filters: FilterClause[]
  source: ComposerSource | null
  daily_cap: string
  total_cap: string
  per_sender_cap: string
  send_interval_seconds: string
  contact_window_start: string
  contact_window_end: string
  start: StartPlan
}

/** The legacy builder's defaults (CreateCampaignModal): 1,000 targets, 750/day, 45 s, 08:00–21:00. Stated, editable, never hidden. */
export const COMPOSER_DEFAULTS = Object.freeze({ total_cap: '1000', daily_cap: '750', send_interval_seconds: '45', window_start: '08:00', window_end: '21:00' })

export function emptyComposition(): Composition {
  return {
    name: '',
    description: '',
    template_use_case: 'ownership_check',
    stage_code: 'S1',
    filters: [],
    source: null,
    daily_cap: COMPOSER_DEFAULTS.daily_cap,
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
    total_cap: c.total_cap,
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
    total_cap: c.total_cap,
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
  // the planner's router answered per market: sendable_now is the ready set a sender can carry
  if (typeof b.sendable_now === 'number') return Math.max(0, b.sendable_now)
  return Math.max(0, n0(b.ready) - n0(b.no_sendable_number))
}

/** True when the simulated build read fewer rows than the audience holds (the count is a sample of the cohort). */
export function buildIsPartial(a: ComposerAudience | null): boolean {
  const b = a?.build
  if (!b?.ok) return false
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

/** The numbers that can serve this audience: its markets' states (exact market + approved state fallback). */
export function relevantFleet(fleet: ComposerFleet | null, audience: ComposerAudience | null): FleetNumber[] {
  if (!fleet) return []
  const states = new Set((audience?.distributions.markets ?? []).map((m) => stateOfMarket(m.value)).filter(Boolean) as string[])
  if (!states.size) return fleet.numbers
  return fleet.numbers.filter((n) => n.state && states.has(n.state))
}

export type FleetTally = Record<'active' | 'cooling' | 'paused' | 'blocked' | 'cap_reached' | 'other', number>

export function tallyFleet(numbers: FleetNumber[]): FleetTally {
  const t: FleetTally = { active: 0, cooling: 0, paused: 0, blocked: 0, cap_reached: 0, other: 0 }
  for (const n of numbers) {
    if (n.eligible) t.active += 1
    else if (n.sender_state === 'cooling') t.cooling += 1
    else if (n.sender_state === 'paused') t.paused += 1
    else if (n.sender_state === 'blocked') t.blocked += 1
    else if (n.sender_state === 'cap_reached') t.cap_reached += 1
    else t.other += 1
  }
  return t
}

export type CapacityPlan = {
  /** senders the router would use today, at their effective per-number limit */
  available_per_day: number
  /** limits of numbers that exist but can't send (cooling, blocked, paused …) */
  unavailable_per_day: number
  unavailable_reason: string | null
  remaining_today: number
  unknown_limits: number
  /** what the contact window admits at the campaign's spacing (modeled) */
  window_per_day: number | null
  planned_per_day: number | null
  /** the modeled sends/day: min(daily cap, senders, window) */
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

export function capacityPlan(numbers: FleetNumber[], c: Pick<Composition, 'daily_cap' | 'send_interval_seconds' | 'contact_window_start' | 'contact_window_end'>): CapacityPlan {
  let available = 0
  let unavailable = 0
  let remaining = 0
  let unknown = 0
  const why: Record<string, number> = {}
  for (const n of numbers) {
    if (n.limit === null) { unknown += 1; continue }
    if (n.eligible || n.sender_state === 'cap_reached') available += n.limit
    else {
      unavailable += n.limit
      why[n.sender_state] = (why[n.sender_state] ?? 0) + 1
    }
    remaining += n.remaining_today
  }
  const reason = Object.keys(why).length
    ? Object.entries(why).sort((a, b) => b[1] - a[1]).map(([state, count]) => `${count} ${state === 'cap_reached' ? 'at cap' : state}`).join(', ')
    : null
  const minutes = windowMinutes(c.contact_window_start, c.contact_window_end)
  const interval = Number(c.send_interval_seconds)
  const windowPerDay = minutes && interval > 0 ? Math.floor((minutes * 60) / interval) : null
  const cap = parseCap(c.daily_cap)
  const planned = cap === null || Number.isNaN(cap) ? null : cap
  const candidates: Array<[CapacityPlan['binding'], number]> = []
  if (planned !== null) candidates.push(['daily_cap', planned])
  candidates.push(['sender_capacity', available])
  if (windowPerDay !== null) candidates.push(['contact_window', windowPerDay])
  candidates.sort((a, b) => a[1] - b[1])
  const binding = planned === 0 ? 'cap_zero' : candidates[0]?.[0] ?? null
  return {
    available_per_day: available,
    unavailable_per_day: unavailable,
    unavailable_reason: reason,
    remaining_today: remaining,
    unknown_limits: unknown,
    window_per_day: windowPerDay,
    planned_per_day: planned,
    effective_per_day: candidates.length ? candidates[0][1] : null,
    binding,
    over_capacity: planned !== null && planned > available,
  }
}

/** Snap a dragged volume back to what the fleet can carry, with the reason. */
export function snapVolume(requested: number, plan: CapacityPlan): { value: number; snapped: boolean; reason: string | null } {
  if (requested <= plan.available_per_day) return { value: Math.max(0, Math.round(requested)), snapped: false, reason: null }
  const over = Math.round(requested - plan.available_per_day)
  return {
    value: plan.available_per_day,
    snapped: true,
    reason: `+${over.toLocaleString('en-US')}/day unavailable${plan.unavailable_reason ? `: ${plan.unavailable_reason}` : ': no further sender capacity'}`,
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
    else if (eligible === null) add('audience', 'Audience', 'audience', 'block', `Build simulation failed${a.build.error ? ` — ${a.build.error}` : ''}`)
    else if (eligible === 0) add('audience', 'Audience', 'audience', 'block', 'Zero eligible prospects')
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
  if (!i.fleet) add('senders', 'Sender health', 'delivery', 'checking', 'Reading the sender fleet…')
  else {
    const nums = relevantFleet(i.fleet, a)
    const t = tallyFleet(nums)
    if (!t.active) add('senders', 'Sender health', 'delivery', 'block', nums.length ? `No sendable number — ${[t.cooling && `${t.cooling} cooling`, t.blocked && `${t.blocked} blocked`, t.paused && `${t.paused} paused`].filter(Boolean).join(', ')}` : 'No sender numbers in these markets')
    else add('senders', 'Sender health', 'delivery', t.cooling + t.blocked + t.paused ? 'warn' : 'ok', `${t.active} sendable${t.cooling + t.blocked + t.paused ? ` · ${t.cooling + t.blocked + t.paused} unavailable` : ''}`)
    const noRoute = n0(a?.build?.no_sendable_number)
    if (a && noRoute) add('routing', 'Routing', 'delivery', eligibleOf(a) ? 'warn' : 'block', `${fmt(noRoute)} ready sellers have no sender route`)
    else if (a) add('routing', 'Routing', 'delivery', 'ok', 'Every ready seller has a route')
    const plan = capacityPlan(nums, c)
    const cap = parseCap(c.daily_cap)
    if (Number.isNaN(cap)) add('capacity', 'Capacity', 'delivery', 'block', 'Daily cap must be a whole number')
    else if (cap === null) add('capacity', 'Capacity', 'delivery', 'block', 'Set a daily cap')
    else if (cap === 0) add('capacity', 'Capacity', 'delivery', 'block', 'Daily cap 0 — sends nothing')
    else if (plan.over_capacity) add('capacity', 'Capacity', 'delivery', 'warn', `Planned ${fmt(cap)}/day exceeds ${fmt(plan.available_per_day)}/day available`)
    else add('capacity', 'Capacity', 'delivery', 'ok', `${fmt(plan.effective_per_day)}/day modeled`)
    const total = parseCap(c.total_cap)
    if (Number.isNaN(total)) add('size', 'Campaign size', 'delivery', 'block', 'Campaign size must be a whole number')
    else if (total === 0) add('size', 'Campaign size', 'delivery', 'block', 'Campaign size 0 — sends nothing')
    else if (total === null) add('size', 'Campaign size', 'delivery', 'warn', 'No total cap — the whole cohort is eligible')
    const sys = i.fleet.system
    if (sys.emergency_stop_at) add('brakes', 'System brakes', 'launch', 'warn', 'Emergency stop is active — rows hydrate, nothing transmits')
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
  ['name', 'Name'], ['template_use_case', 'Strategy'], ['daily_cap', 'Daily cap'], ['total_cap', 'Campaign size'],
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
