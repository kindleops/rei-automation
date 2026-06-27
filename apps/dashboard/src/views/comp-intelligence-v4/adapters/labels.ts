/**
 * Comp Intelligence V4 — product-language translation.
 *
 * Section 15 of the spec: raw implementation values (DEGRADED_COMP, direct_rpc,
 * V3_DISABLED, EVIDENCE_ONLY, raw enums) must NEVER reach the primary UI.
 * Everything user-facing flows through these maps.
 */

import type { EvidenceSourceKind, EvidenceState, MatchTier } from '../state/types'

/** Short canonical status label (badge text). */
const STATE_LABELS: Record<EvidenceState, string> = {
  qualified: 'Qualified',
  candidate: 'Candidate',
  review: 'Review',
  demand_only: 'Demand only',
  excluded: 'Excluded',
}

/** Full product-language status for cards/dossier. */
const STATE_LONG_LABELS: Record<EvidenceState, string> = {
  qualified: 'Qualified Pricing Comp',
  candidate: 'Candidate Sale',
  review: 'Review Required',
  demand_only: 'Demand Only',
  excluded: 'Excluded',
}

export function evidenceStateLabel(state: EvidenceState): string {
  return STATE_LABELS[state]
}

export function evidenceStateLongLabel(state: EvidenceState): string {
  return STATE_LONG_LABELS[state]
}

/** Tier label for list headers. */
const TIER_LABELS: Record<string, string> = {
  qualified: 'Qualified pricing comps',
  candidate: 'Candidate sales',
  review: 'Review evidence',
  demand_only: 'Demand-only evidence',
  excluded: 'Excluded evidence',
  all: 'All discovered evidence',
}

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? 'Evidence'
}

const ASSET_LANE_LABELS: Record<string, string> = {
  single_family: 'Single Family',
  sfr: 'Single Family',
  multifamily: 'Multifamily',
  residential_income: 'Residential Income',
  duplex: 'Duplex',
  townhome: 'Townhome',
  condo: 'Condominium',
  self_storage: 'Self Storage',
  retail: 'Retail',
  office: 'Office',
  industrial: 'Industrial',
  land: 'Land',
  mobile_home: 'Mobile Home',
  mixed_use: 'Mixed Use',
}

export function assetLaneLabel(lane: string | null | undefined): string | null {
  if (!lane) return null
  const key = String(lane).trim().toLowerCase()
  return ASSET_LANE_LABELS[key] ?? titleCase(key)
}

const EXECUTION_STATE_LABELS: Record<string, string> = {
  SHADOW_MODE_READY: 'Shadow Mode Ready',
  REVIEW_REQUIRED: 'Review Required',
  DATA_REQUIRED: 'More Evidence Required',
  ANOMALY_QUARANTINE: 'Material Data Anomaly',
  EVIDENCE_ONLY_DEGRADED: 'Preliminary — Decision Unavailable',
  V3_DISABLED: 'Comp Research Mode',
  legacy_v2_projection: 'Comp Research Mode',
}

export function executionStateLabel(state: string | null | undefined): string | null {
  if (!state) return null
  return EXECUTION_STATE_LABELS[String(state)] ?? titleCase(String(state))
}

const VALUE_CLASSIFICATION_LABELS: Record<string, string> = {
  QUALIFIED: 'Qualified Market Value',
  PROVISIONAL_SCENARIO: 'Provisional Scenario',
  SCENARIO: 'Scenario Value',
  UNAVAILABLE: 'Not Yet Available',
}

export function valueClassificationLabel(value: string | null | undefined): string | null {
  if (!value) return null
  return VALUE_CLASSIFICATION_LABELS[String(value)] ?? titleCase(String(value))
}

const STRATEGY_LABELS: Record<string, string> = {
  cash_offer: 'Cash Offer',
  wholesale: 'Wholesale',
  novation: 'Novation',
  subject_to: 'Subject-To',
  seller_finance: 'Seller Finance',
  fix_and_flip: 'Fix & Flip',
  buy_and_hold: 'Buy & Hold',
}

export function strategyLabel(strategy: string | null | undefined): string | null {
  if (!strategy) return null
  return STRATEGY_LABELS[String(strategy)] ?? titleCase(String(strategy))
}

/** Source category → product language (Section 15: direct_rpc → Public records). */
export function classifySource(rawSource: string | null | undefined): {
  kind: EvidenceSourceKind
  label: string
} {
  const s = String(rawSource ?? '').trim().toLowerCase()
  if (!s) return { kind: 'unknown', label: 'Unknown source' }
  if (s.includes('mls') || s.includes('listing')) return { kind: 'mls', label: 'MLS sale' }
  if (s.includes('buyer') || s.includes('purchase_event') || s.includes('bpe')) {
    return { kind: 'buyer_purchase_event', label: 'Buyer purchase event' }
  }
  if (
    s.includes('public') ||
    s.includes('record') ||
    s.includes('deed') ||
    s.includes('direct_rpc') ||
    s.includes('rpc')
  ) {
    return { kind: 'public_record', label: 'Public records' }
  }
  return { kind: 'unknown', label: 'Verified sale' }
}

/** Translate a raw exclusion/review reason code into a readable phrase. */
const REASON_LABELS: Record<string, string> = {
  missing_sale_price: 'Missing sale price',
  'Missing sale price': 'Missing sale price',
  too_far: 'Outside search radius',
  asset_mismatch: 'Different asset type',
  stale_sale: 'Sale too old',
  package_sale: 'Part of a package sale',
  distressed: 'Distressed sale',
  non_arms_length: 'Not arm’s-length',
  outlier: 'Price outlier',
  duplicate: 'Duplicate transaction',
  ANOMALY_QUARANTINE: 'Material data anomaly',
  EVIDENCE_ONLY: 'Context only',
  REVIEW_REQUIRED: 'Needs review',
}

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return ''
  const raw = String(reason).trim()
  if (REASON_LABELS[raw]) return REASON_LABELS[raw]
  const key = raw.toLowerCase().replace(/\s+/g, '_')
  return REASON_LABELS[key] ?? humanizeCode(raw)
}

const MATCH_TIER_LABELS: Record<MatchTier, string> = {
  exact: 'Exact match',
  strong: 'Strong match',
  close: 'Close match',
  loose: 'Low similarity',
  unknown: 'Unscored',
}

export function matchTierLabel(tier: MatchTier): string {
  return MATCH_TIER_LABELS[tier]
}

export function matchTierFromScore(score: number | null | undefined): MatchTier {
  if (score == null || !Number.isFinite(score)) return 'unknown'
  // Score is 0..1 or 0..100 depending on path; normalize to 0..1.
  const n = score > 1 ? score / 100 : score
  if (n >= 0.9) return 'exact'
  if (n >= 0.75) return 'strong'
  if (n >= 0.55) return 'close'
  return 'loose'
}

// ── helpers ──────────────────────────────────────────────────────────────

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

function humanizeCode(value: string): string {
  // "DEGRADED_COMP" → "Degraded comp" only as a last resort; prefer maps above.
  const lower = value.replace(/[_-]+/g, ' ').toLowerCase().trim()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}
