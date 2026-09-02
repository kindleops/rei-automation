/**
 * Formatting + labelling for the mobile Seller Command Center.
 *
 * Kept separate from the component so the vocabulary decisions (what an
 * exclusion reason is called, what an identity role means, which system events
 * are worth showing an operator) are reviewable on their own.
 */

export const money = (value: unknown, opts: { compact?: boolean } = {}): string | null => {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null
  if (opts.compact && Math.abs(n) >= 1000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: n >= 1_000_000 ? 2 : 0,
    }).format(n)
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

/**
 * For amounts where 0 encodes "not recorded" rather than "zero dollars".
 * `properties.sale_price` is 0 on ~48% of rows; rendering that as "$0" reads as
 * a real sale for nothing. Loan balance is the opposite case — 0 there really
 * does mean free and clear — so that keeps using `money`.
 */
export const moneyRecorded = (value: unknown, opts: { compact?: boolean } = {}): string | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return null
  return money(n, opts)
}

export const percent = (value: unknown, digits = 0): string | null => {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null
  return `${n.toFixed(digits)}%`
}

export const count = (value: unknown): string | null => {
  const n = Number(value)
  if (value === null || value === undefined || !Number.isFinite(n)) return null
  return new Intl.NumberFormat('en-US').format(n)
}

/** Years must not get a thousands separator: 1975, never "1,975". */
export const year = (value: unknown): string | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return String(Math.trunc(n))
}

/**
 * Counts where 0 means "not recorded" rather than "none". County feeds store 0
 * bedrooms/baths for records they simply do not have, and "0bd" on a 1,400 sqft
 * house reads as a fact rather than a gap.
 */
export const countRecorded = (value: unknown): string | null => {
  const n = Number(value)
  if (!Number.isFinite(n) || n === 0) return null
  return count(n)
}

export const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s ? s : null
}

/** `single_family` / `SOME_CODE` -> `Single Family`. */
export const humanize = (value: unknown): string | null => {
  const s = text(value)
  if (!s) return null
  if (/^[A-Z][a-z]/.test(s) && !s.includes('_')) return s
  return s
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export const shortDate = (value: unknown): string | null => {
  const s = text(value)
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export const relativeTime = (value: unknown): string | null => {
  const s = text(value)
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60_000)
  if (Math.abs(mins) < 1) return 'just now'
  if (Math.abs(mins) < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (Math.abs(hours) < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return `${days}d ago`
  return shortDate(s)
}

/** Street on one line, locality muted on the next. */
export function splitAddress(full: string | null | undefined): { street: string | null; locality: string | null } {
  const s = text(full)
  if (!s) return { street: null, locality: null }
  const parts = s.split(',')
  if (parts.length < 2) return { street: s, locality: null }
  return { street: parts[0].trim(), locality: parts.slice(1).join(',').trim() }
}

/**
 * Operator-facing names for engine exclusion reasons. The engine emits these as
 * snake_case tokens; showing them raw is how "asset_type_mismatch" ended up on
 * screen looking like a system leak.
 */
export const COMP_EXCLUSION_LABELS: Record<string, string> = {
  invalid_sale_price: 'No recorded sale price',
  same_property: 'Same property',
  asset_type_mismatch: 'Different asset type',
  sale_too_old: 'Sale too old',
  outside_radius: 'Too far away',
  outside_zip_without_coordinates: 'Outside ZIP, no coordinates',
  square_feet_outside_range: 'Size too different',
  unit_count_outside_range: 'Unit count too different',
  building_size_outside_range: 'Building size too different',
}

export const compExclusionLabel = (reason: unknown): string => {
  const s = text(reason)
  if (!s) return 'Screened out'
  return COMP_EXCLUSION_LABELS[s] ?? humanize(s) ?? 'Screened out'
}

/**
 * Human labels for activity-timeline event types. The timeline currently leaks
 * table names (`inbox_threads_hydrated`, `property_acquisition_scores`); an
 * operator should read what happened, not where it was stored.
 */
export const ACTIVITY_LABELS: Record<string, string> = {
  inbox_threads_hydrated: 'Conversation synced',
  property_acquisition_scores: 'Acquisition engine run',
  message_events: 'Message',
  universal_lead_state_events: 'Workflow state changed',
  acquisition_opportunity_history: 'Deal record updated',
  send_queue: 'Outbound queued',
  inbox_activity_events: 'Operator action',
}

/**
 * The backend bakes raw enums straight into activity labels — "Strategy ·
 * CASH_ASSIGNMENT", "Status changed · not_contacted". Rewrite those tokens in
 * place, conservatively: only snake_case words and runs of *two or more*
 * consecutive all-caps words are touched, so genuine acronyms (SMS, AOS, LLC,
 * MLS) survive untouched.
 */
export const humanizeEmbeddedTokens = (value: string): string =>
  value
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, (m) => humanize(m) ?? m)
    .replace(/\b[A-Z][A-Z0-9]{1,}(?:\s+[A-Z][A-Z0-9]{1,})+\b/g, (m) => humanize(m) ?? m)

export const activityLabel = (event: { type?: string; label?: string }): string => {
  const label = text(event.label)
  const type = text(event.type)
  // Prefer an explicit label, but never let a raw relation name through.
  if (label && !ACTIVITY_LABELS[label] && !/^[a-z_]+$/.test(label)) {
    return humanizeEmbeddedTokens(label)
  }
  if (type && ACTIVITY_LABELS[type]) return ACTIVITY_LABELS[type]
  if (label && ACTIVITY_LABELS[label]) return ACTIVITY_LABELS[label]
  return humanize(label ?? type) ?? 'Activity'
}

/**
 * Provider phone-type codes. `phones.type` stores single letters; "W" told the
 * operator nothing.
 */
const PHONE_TYPE_CODES: Record<string, string> = {
  w: 'Wireless', m: 'Mobile', c: 'Mobile', l: 'Landline', v: 'VOIP', p: 'Pager',
}

export const phoneType = (value: unknown): string | null => {
  const s = text(value)
  if (!s) return null
  if (s.length <= 2) return PHONE_TYPE_CODES[s.toLowerCase()] ?? s.toUpperCase()
  return humanize(s)
}

/**
 * `phones.phone_owner` often carries the carrier name rather than a person.
 * Presenting "Verizon Wireless" as an identity next to real people is noise, so
 * it is suppressed when it just restates the carrier.
 */
export const isCarrierName = (owner: unknown, carrier: unknown): boolean => {
  const o = text(owner)?.toLowerCase()
  if (!o) return true
  const c = text(carrier)?.toLowerCase()
  if (c && (o === c || o.includes(c) || c.includes(o))) return true
  return /\b(wireless|telecom|communications|mobility|cellular|t-?mobile|verizon|at&t|sprint|spectrum|comcast|level ?3|bandwidth|onvoy|peerless|inteliquent)\b/.test(o)
}

/**
 * What each person on the profile actually is. These are different records with
 * different provenance and they are frequently different people — the UI has to
 * say which is which rather than implying they are all "the seller".
 */
export const IDENTITY_ROLES = {
  deed_owner: {
    label: 'Deed owner',
    hint: 'Name on the last recorded deed (county record).',
  },
  entity_owner: {
    label: 'Portfolio owner',
    hint: 'Master owner record grouping this property with others.',
  },
  prospect: {
    label: 'Prospect',
    hint: 'Skip-traced person we matched to this property.',
  },
  phone_owner: {
    label: 'Phone owner',
    hint: 'Name the carrier/data provider returns for this number.',
  },
} as const

export type IdentityRole = keyof typeof IDENTITY_ROLES
