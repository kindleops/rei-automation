/**
 * V2-2B — CADENCE PRIORITY RESOLVER.
 *
 * Cadence is not `stage → one delay`. It is
 *
 *     stage + unresolved objective + attempt number + verified urgency profile
 *
 * This module owns the last term, and ONLY that term. It answers "how fast may
 * we pursue this lead", never "what do we need next" (the acquisition state
 * machine) and never "what does the seller want" (seller facts).
 *
 * THE LINE THIS MODULE MUST NOT CROSS. A lead being urgent says something
 * about the PROPERTY'S CALENDAR, not about the seller's mind. Nothing here may
 * set seller_motivated, seller_interested, or any other seller fact — an
 * approaching auction is a fact about a courthouse, not evidence that the
 * owner wants to sell. The return value carries `seller_facts_created: 0` so a
 * caller can assert that without re-deriving it.
 *
 * URGENCY MUST BE EXPLAINABLE. Every classification answers four questions:
 *   WHY   → reason
 *   WHAT  → evidence
 *   WHEN  → verified_at
 *   UNTIL → expires_at
 * A signal that cannot answer all four cannot raise the profile. That is what
 * keeps "urgent" from becoming a synonym for "we would like to text more".
 *
 * WHAT IS DELIBERATELY REJECTED. Absentee ownership, high equity, vacancy,
 * property value, lead/motivation scores and model speculation are all
 * excluded BY NAME below rather than merely unimplemented, because each is a
 * plausible-sounding reason someone could later add. They may prioritise WHICH
 * leads to work; they do not authorise faster pursuit of a specific human.
 */

const clean = (value) => String(value ?? '').trim()

export const CADENCE_PROFILE = Object.freeze({
  STANDARD: 'standard',
  PRIORITY: 'priority',
  URGENT: 'urgent',
})

/** Ordered weakest → strongest, so an escalation is a simple index compare. */
export const PROFILE_RANK = Object.freeze({
  [CADENCE_PROFILE.STANDARD]: 0,
  [CADENCE_PROFILE.PRIORITY]: 1,
  [CADENCE_PROFILE.URGENT]: 2,
})

export const PROFILE_SOURCE = Object.freeze({
  PROPERTY_EVENT: 'verified_property_event',
  SELLER_STATEMENT: 'seller_stated_deadline',
  DEFAULT: 'no_qualifying_evidence',
})

/**
 * Signals that are explicitly NOT urgency, listed so a future reader sees the
 * refusal was deliberate. Each is a real field in this system.
 */
export const REJECTED_URGENCY_SIGNALS = Object.freeze([
  'absentee_owner',
  'high_equity',
  'vacant',
  'property_value',
  'lead_score',
  'motivation_score',
  'distress_purchase_score',
  'ai_predicted_motivation',
  'stale_enrichment',
])

/**
 * How long a piece of evidence stays trustworthy.
 *
 * A foreclosure record verified eleven months ago says nothing about today —
 * cases get cured, sold and dismissed constantly. Evidence past its window
 * does not merely weaken; it stops counting, and the lead falls back to
 * STANDARD.
 */
export const EVIDENCE_TTL_DAYS = Object.freeze({
  auction_date: 90,
  foreclosure_stage: 60,
  tax_sale: 90,
  seller_stated_deadline: 30,
  seller_immediate_timeline: 21,
})

const DAY_MS = 24 * 60 * 60 * 1000

function toDate(value) {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isFinite(d.getTime()) ? d : null
}

function daysBetween(from, to) {
  return (to.getTime() - from.getTime()) / DAY_MS
}

function isTruthy(value) {
  const v = clean(value).toLowerCase()
  return v === 'true' || v === 't' || v === 'yes' || v === '1' || value === true
}

function standard(reason) {
  return {
    cadence_profile: CADENCE_PROFILE.STANDARD,
    cadence_profile_reason: reason,
    cadence_profile_source: PROFILE_SOURCE.DEFAULT,
    cadence_profile_verified_at: null,
    cadence_profile_expires_at: null,
    evidence: null,
    days_to_deadline: null,
    seller_facts_created: 0,
    rejected_signals_considered: REJECTED_URGENTLY_SAFE,
  }
}
// Named separately so the constant is not rebuilt per call.
const REJECTED_URGENTLY_SAFE = REJECTED_URGENCY_SIGNALS

/**
 * Resolve the cadence profile from evidence.
 *
 * @param {object} input
 * @param {object} [input.property]  { auction_date, auction_status, foreclosure_stage,
 *                                     is_pre_foreclosure, is_foreclosure, tax_sale_date,
 *                                     urgency_verified_at }
 * @param {object} [input.seller]    { stated_deadline, timeline, evidence_at }
 * @param {string} [input.now]
 */
export function resolveCadenceProfile({ property = null, seller = null, now = null } = {}) {
  const current = toDate(now) || new Date()

  // ── Seller-stated deadline: the strongest signal, because it is the seller
  // telling us their own constraint rather than us inferring one. Checked
  // first so a concrete seller date outranks a courthouse record.
  const sellerDeadline = toDate(seller?.stated_deadline)
  const sellerEvidenceAt = toDate(seller?.evidence_at)
  if (sellerDeadline && sellerEvidenceAt) {
    const ageDays = daysBetween(sellerEvidenceAt, current)
    const ttl = EVIDENCE_TTL_DAYS.seller_stated_deadline
    if (ageDays <= ttl && sellerDeadline > current) {
      return {
        cadence_profile: CADENCE_PROFILE.URGENT,
        cadence_profile_reason: 'seller_stated_concrete_deadline',
        cadence_profile_source: PROFILE_SOURCE.SELLER_STATEMENT,
        cadence_profile_verified_at: sellerEvidenceAt.toISOString(),
        cadence_profile_expires_at: new Date(Math.min(
          sellerDeadline.getTime(),
          sellerEvidenceAt.getTime() + ttl * DAY_MS
        )).toISOString(),
        evidence: { stated_deadline: sellerDeadline.toISOString() },
        days_to_deadline: daysBetween(current, sellerDeadline),
        seller_facts_created: 0,
        rejected_signals_considered: REJECTED_URGENCY_SIGNALS,
      }
    }
  }

  // ── Verified FUTURE auction date. A past auction is not urgency; it is
  // history, and often means the property is already gone.
  const auctionDate = toDate(property?.auction_date)
  const verifiedAt = toDate(property?.urgency_verified_at)
  if (auctionDate && auctionDate > current) {
    const ttl = EVIDENCE_TTL_DAYS.auction_date
    const evidenceAge = verifiedAt ? daysBetween(verifiedAt, current) : null
    const statusCancelled = /cancel|withdraw|postponed_indefinite|dismiss/i.test(clean(property?.auction_status))

    if (!statusCancelled && (evidenceAge === null || evidenceAge <= ttl)) {
      const daysOut = daysBetween(current, auctionDate)
      return {
        cadence_profile: CADENCE_PROFILE.URGENT,
        cadence_profile_reason: 'verified_future_auction_date',
        cadence_profile_source: PROFILE_SOURCE.PROPERTY_EVENT,
        cadence_profile_verified_at: (verifiedAt || current).toISOString(),
        // Expires AT the auction: afterwards the event has happened and the
        // urgency is spent, whatever the record still says.
        cadence_profile_expires_at: auctionDate.toISOString(),
        evidence: { auction_date: auctionDate.toISOString(), auction_status: clean(property?.auction_status) || null },
        days_to_deadline: daysOut,
        seller_facts_created: 0,
        rejected_signals_considered: REJECTED_URGENCY_SIGNALS,
      }
    }
    if (statusCancelled) {
      return standard('auction_cancelled_or_withdrawn')
    }
  }

  // ── Verified foreclosure / pre-foreclosure WITHOUT a scheduled date.
  // Real time pressure, but no fixed clock — PRIORITY, not URGENT.
  const fcStage = clean(property?.foreclosure_stage)
  const preFc = isTruthy(property?.is_pre_foreclosure) || isTruthy(property?.is_preforeclosure)
  const inFc = isTruthy(property?.is_foreclosure)
  if (fcStage || preFc || inFc) {
    const ttl = EVIDENCE_TTL_DAYS.foreclosure_stage
    const evidenceAge = verifiedAt ? daysBetween(verifiedAt, current) : null
    if (evidenceAge !== null && evidenceAge > ttl) {
      return standard('foreclosure_evidence_stale')
    }
    return {
      cadence_profile: CADENCE_PROFILE.PRIORITY,
      cadence_profile_reason: fcStage ? 'verified_foreclosure_stage' : 'verified_pre_foreclosure',
      cadence_profile_source: PROFILE_SOURCE.PROPERTY_EVENT,
      cadence_profile_verified_at: (verifiedAt || current).toISOString(),
      cadence_profile_expires_at: new Date((verifiedAt || current).getTime() + ttl * DAY_MS).toISOString(),
      evidence: { foreclosure_stage: fcStage || null, is_pre_foreclosure: preFc, is_foreclosure: inFc },
      days_to_deadline: null,
      seller_facts_created: 0,
      rejected_signals_considered: REJECTED_URGENCY_SIGNALS,
    }
  }

  // ── Tax sale with a future date.
  const taxSale = toDate(property?.tax_sale_date)
  if (taxSale && taxSale > current) {
    return {
      cadence_profile: CADENCE_PROFILE.PRIORITY,
      cadence_profile_reason: 'verified_tax_sale_date',
      cadence_profile_source: PROFILE_SOURCE.PROPERTY_EVENT,
      cadence_profile_verified_at: (verifiedAt || current).toISOString(),
      cadence_profile_expires_at: taxSale.toISOString(),
      evidence: { tax_sale_date: taxSale.toISOString() },
      days_to_deadline: daysBetween(current, taxSale),
      seller_facts_created: 0,
      rejected_signals_considered: REJECTED_URGENCY_SIGNALS,
    }
  }

  // ── Seller said "immediately" without naming a date. Real, but vague:
  // enough for PRIORITY, not enough for a 24-hour chase.
  if (clean(seller?.timeline).toLowerCase() === 'immediate' && sellerEvidenceAt) {
    const ttl = EVIDENCE_TTL_DAYS.seller_immediate_timeline
    if (daysBetween(sellerEvidenceAt, current) <= ttl) {
      return {
        cadence_profile: CADENCE_PROFILE.PRIORITY,
        cadence_profile_reason: 'seller_stated_immediate_timeline',
        cadence_profile_source: PROFILE_SOURCE.SELLER_STATEMENT,
        cadence_profile_verified_at: sellerEvidenceAt.toISOString(),
        cadence_profile_expires_at: new Date(sellerEvidenceAt.getTime() + ttl * DAY_MS).toISOString(),
        evidence: { timeline: 'immediate' },
        days_to_deadline: null,
        seller_facts_created: 0,
        rejected_signals_considered: REJECTED_URGENCY_SIGNALS,
      }
    }
  }

  return standard(PROFILE_SOURCE.DEFAULT)
}

/**
 * Has a previously-assigned profile gone stale?
 *
 * Recomputation is deterministic and does NOT mutate seller facts — a lead
 * dropping from URGENT to STANDARD because an auction was cancelled changes
 * only how fast we may pursue it.
 */
export function isProfileExpired(stored = {}, now = null) {
  const current = toDate(now) || new Date()
  const expires = toDate(stored.cadence_profile_expires_at)
  if (!expires) return clean(stored.cadence_profile) !== CADENCE_PROFILE.STANDARD && !stored.cadence_profile_verified_at
  return current >= expires
}

/**
 * Recompute, reporting whether the profile moved and in which direction.
 * A downgrade is as important as an upgrade: leaving a cured foreclosure at
 * URGENT forever is exactly the failure this exists to prevent.
 */
export function recomputeCadenceProfile({ stored = {}, property = null, seller = null, now = null } = {}) {
  const fresh = resolveCadenceProfile({ property, seller, now })
  const previous = clean(stored.cadence_profile) || CADENCE_PROFILE.STANDARD
  const previousRank = PROFILE_RANK[previous] ?? 0
  const nextRank = PROFILE_RANK[fresh.cadence_profile] ?? 0

  return {
    ...fresh,
    previous_profile: previous,
    changed: previous !== fresh.cadence_profile,
    direction: nextRank > previousRank ? 'escalated' : nextRank < previousRank ? 'de_escalated' : 'unchanged',
    expired_prior_evidence: isProfileExpired(stored, now),
    // Restated at the boundary where a careless edit would be most tempting.
    seller_facts_mutated: 0,
  }
}

export default resolveCadenceProfile
