/**
 * Comp Intelligence V4 — qualification integrity.
 *
 * Two entry points, ONE authority rule:
 *
 *  • classifyFromV3()        — when the canonical Acquisition Engine V3
 *    transaction pipeline returns qualification, map it faithfully. This is the
 *    ONLY path that can produce `qualified`. A conservative safety net may still
 *    DEMOTE (never promote) on obvious package/outlier contamination.
 *
 *  • classifyDefensive()     — when canonical V3 qualification is unavailable
 *    (e.g. ACQUISITION_ENGINE_V3_ENABLED off). Every candidate starts as
 *    `candidate` and the gates only ever DEMOTE to review / excluded /
 *    demand_only. This path can NEVER output `qualified` — the frontend may not
 *    invent qualification (Phase 2).
 *
 * The frontend does not run a competing positive-qualification algorithm; it
 * runs a conservative defensive classifier that restricts, never qualifies.
 */

import type { EvidenceState, QualificationBasis, StateAuthority } from '../state/types'
import { reasonLabel } from './labels'

export interface SubjectAnchor {
  assetLane: string | null
  units: number | null
  providerEstimate: number | null
  isSingleAsset: boolean
}

export interface CandidateSignals {
  assetClass: string | null
  propertyType: string | null
  propertySubtype: string | null
  units: number | null
  salePrice: number | null
  sqft: number | null
  beds: number | null
  baths: number | null
  yearBuilt: number | null
  ppsf: number | null
  isUnitAddress: boolean
  // V3-only signals (null on the V2 path)
  pricingEligible: boolean | null
  demandEligible: boolean | null
  packageProbability: number | null
  parcelCount: number | null
  essContribution: number | null
  routedUniverse: string | null
  evidenceRole: string | null
}

export interface ClassifyContext {
  subject: SubjectAnchor
  /** Median sale price of priced, asset-compatible peers (peer anchor). */
  peerMedianSale: number | null
}

export interface Classification {
  state: EvidenceState
  basis: QualificationBasis
}

const MULTIFAMILY_LANES = new Set([
  'apartment',
  'multifamily',
  'multi_family',
  'commercial',
  'retail',
  'office',
  'industrial',
  'mixed_use',
])

function physicalCompleteness(c: CandidateSignals): number {
  const fields = [c.beds, c.baths, c.sqft, c.yearBuilt, c.units]
  const present = fields.filter((v) => v != null && Number.isFinite(Number(v))).length
  return present / fields.length
}

function isMultifamily(c: CandidateSignals): boolean {
  const lane = String(c.assetClass ?? c.propertyType ?? '').toLowerCase()
  if (MULTIFAMILY_LANES.has(lane)) return true
  if (lane.includes('apartment') || lane.includes('multi')) return true
  if ((c.units ?? 1) > 4) return true
  return false
}

function baseBasis(c: CandidateSignals, authority: StateAuthority): QualificationBasis {
  return {
    reason: '',
    authority,
    pricingEligible: c.pricingEligible,
    // Only assert single-asset when we actually have parcel/package signal;
    // otherwise it is genuinely Unknown (do not default to "Yes").
    singleAssetEligible:
      c.parcelCount == null && c.packageProbability == null
        ? null
        : (c.parcelCount ?? 1) <= 1 && (c.packageProbability ?? 0) < 0.5,
    assetLaneCompatible: null,
    evidenceUniverse: c.routedUniverse,
    evidenceRole: c.evidenceRole,
    packageStatus:
      c.packageProbability == null ? null : c.packageProbability >= 0.5 ? 'package_likely' : 'single_asset',
    outlierStatus: null,
    physicalCompleteness: physicalCompleteness(c),
    essContribution: c.essContribution,
  }
}

/** Ratio of candidate sale price to an anchor, guarded. */
function ratio(value: number | null, anchor: number | null): number | null {
  if (value == null || anchor == null || anchor <= 0 || value <= 0) return null
  return value / anchor
}

/**
 * V2 / V3-unavailable path. Base = candidate; gates only DEMOTE.
 * Never returns `qualified`.
 */
export function classifyDefensive(c: CandidateSignals, ctx: ClassifyContext): Classification {
  const basis = baseBasis(c, 'frontend_defensive')
  const subject = ctx.subject
  const subjMultifamily = !subject.isSingleAsset

  // 1) Wrong asset class (most severe for a single-asset subject).
  if (subject.isSingleAsset && isMultifamily(c)) {
    basis.assetLaneCompatible = false
    const unitTxt = c.units != null ? `${c.units}-unit ` : ''
    const typeTxt = (c.propertyType ?? c.assetClass ?? 'multifamily').toString().toLowerCase()
    basis.reason = `Different asset class — ${unitTxt}${typeTxt}`
    return { state: 'excluded', basis }
  }
  if (subjMultifamily && !isMultifamily(c)) {
    basis.assetLaneCompatible = false
    basis.reason = 'Different asset class — single-family vs multifamily subject'
    return { state: 'excluded', basis }
  }
  basis.assetLaneCompatible = true

  // 2) No usable sale price → demand / context evidence only.
  if (c.salePrice == null || c.salePrice <= 0) {
    basis.pricingEligible = false
    basis.reason = 'No sale price — demand evidence only'
    return { state: 'demand_only', basis }
  }

  // 3) Extreme price-ratio defense (multiple independent anchors).
  const subjRatio = ratio(c.salePrice, subject.providerEstimate)
  const peerRatio = ratio(c.salePrice, ctx.peerMedianSale)
  const extremeHigh = (subjRatio != null && subjRatio >= 10) || (peerRatio != null && peerRatio >= 10)
  const extremeLow = (subjRatio != null && subjRatio <= 0.1) || (peerRatio != null && peerRatio <= 0.1)
  const moderateOut =
    (subjRatio != null && (subjRatio >= 4 || subjRatio <= 0.25)) ||
    (peerRatio != null && (peerRatio >= 4 || peerRatio <= 0.25))
  if (extremeHigh || extremeLow) {
    basis.outlierStatus = 'extreme'
    const r = subjRatio ?? peerRatio
    basis.reason = `Extreme price outlier${r ? ` (~${r >= 1 ? Math.round(r) : r.toFixed(2)}× anchor)` : ''}`
    return { state: 'excluded', basis }
  }
  if (moderateOut) {
    basis.outlierStatus = 'moderate'
    basis.reason = 'Price outlier — review required'
    return { state: 'review', basis }
  }
  basis.outlierStatus = 'within_band'

  // 4) Unit-number address → subtype & parcel review.
  if (c.isUnitAddress) {
    basis.reason = 'Unit-number address — subtype & parcel review'
    return { state: 'review', basis }
  }

  // 5) Limited physical data for SFR pricing.
  if (c.sqft == null) {
    basis.reason = 'Limited physical data — review required'
    return { state: 'review', basis }
  }

  // Otherwise: a usable candidate. NOT qualified — canonical V3 is required to
  // promote to a qualified pricing comp.
  basis.reason = 'Preliminary candidate — canonical qualification unavailable'
  return { state: 'candidate', basis }
}

/**
 * Canonical V3 path. `qualified` only when V3 explicitly accepts a single-asset,
 * pricing-eligible transaction. Safety net may demote on package/outlier; never
 * promotes.
 */
export function classifyFromV3(c: CandidateSignals, rawStatus: string | null): Classification {
  const basis = baseBasis(c, 'canonical_v3')
  const status = String(rawStatus ?? '').toUpperCase()

  const accepted = status === 'ACCEPTED' || status === 'ACCEPT'
  const isReview = status === 'REVIEW' || status === 'QUARANTINED' || status === 'QUARANTINE'
  const isRejected = status === 'REJECTED' || status === 'EXCLUDE' || status === 'COLLAPSED'

  if (isRejected) {
    basis.reason = 'Excluded by canonical qualification'
    return { state: 'excluded', basis }
  }
  if (isReview) {
    basis.reason = 'Review required by canonical qualification'
    return { state: 'review', basis }
  }
  if (accepted && c.pricingEligible === true) {
    // Safety net — demote on obvious single-asset contamination.
    if ((c.packageProbability ?? 0) >= 0.5 || (c.parcelCount ?? 1) > 1) {
      basis.singleAssetEligible = false
      basis.reason = 'Package/portfolio consideration — review required'
      return { state: 'review', basis }
    }
    basis.singleAssetEligible = true
    basis.reason = 'Qualified by canonical Acquisition Engine V3'
    return { state: 'qualified', basis }
  }
  if (accepted && c.demandEligible === true) {
    basis.reason = 'Demand evidence — not pricing-eligible'
    return { state: 'demand_only', basis }
  }
  basis.reason = 'Candidate — canonical qualification incomplete'
  return { state: 'candidate', basis }
}

/** Human-readable reason already produced above; helper for raw reason arrays. */
export function humanizeReasons(reasons: unknown[]): string[] {
  return (reasons ?? []).map((r) => reasonLabel(String(r))).filter(Boolean)
}
