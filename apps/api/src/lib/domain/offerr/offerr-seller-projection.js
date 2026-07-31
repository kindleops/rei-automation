/**
 * Offerr Evaluation Spine — seller-safe projection.
 *
 * Builds the ONLY shape that may eventually be shown to a seller. Fields are
 * explicitly allowlisted and copied one by one — never spread from internal
 * objects — so new internal fields can never leak by default.
 *
 * Never included (enforced by tests/critical/offerr-seller-projection.test.mjs):
 * raw provider payloads, owner/contact enrichment, internal MAO math,
 * assignment-fee targets, buyer identities, raw comp rows, internal risk
 * rules, private database identifiers (property_id etc.), or service/debug
 * information.
 */

import {
  OFFERR_OUTCOMES,
  OFFERR_SPINE_VERSION,
} from './offerr-contracts.js';

export const OFFERR_SELLER_DISCLAIMER =
  'This is a preliminary, non-binding estimate based on public and internal data. ' +
  'It is not an offer to purchase. Any offer requires verification of the property.';

/**
 * Substrings that must never appear in a serialized seller projection.
 * Used by tests as a leak tripwire.
 */
export const OFFERR_SELLER_PROJECTION_FORBIDDEN_TOKENS = Object.freeze([
  'assignment_fee',
  'maximum_cash_offer',
  'recommended_cash_offer',
  'walkaway',
  'margin_pct',
  'buyer_name',
  'buyer_archetype',
  'master_owner',
  'prospect_id',
  'property_id',
  'supabase',
  'service_role',
  'comp_id',
  'sale_price',
  'formula_version',
  'execution_state',
  'invariant',
]);

function clean(value) {
  return String(value ?? '').trim() || null;
}

function finiteNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Seller-safe description of the matched property. No internal identifiers. */
function projectPropertySummary(match) {
  if (!match) return null;
  return {
    address_line: clean(match.property_address_full),
    city: clean(match.city),
    state: clean(match.state),
    zip: clean(match.zip),
    property_type: clean(match.property_type),
  };
}

function projectRange(range) {
  const low = finiteNum(range?.low);
  const high = finiteNum(range?.high);
  if (low === null || high === null || low <= 0 || high <= 0 || low > high) return null;
  return { low, high, currency: 'USD' };
}

/**
 * Build the sanitized seller-safe projection from an internal evaluation.
 *
 * @param {object} args
 * @param {string} args.evaluationId - Public evaluation identifier.
 * @param {string} args.outcome - OFFERR_OUTCOMES value.
 * @param {object|null} args.preliminaryRange - { low, high } or null.
 * @param {string} args.confidenceLabel - Seller-safe confidence label.
 * @param {string} args.nextStep - Seller-safe next step.
 * @param {object|null} args.matchedProperty - Resolution match summary.
 * @param {string[]} [args.assumptions] - Seller-safe assumption strings.
 * @param {string[]} [args.dataConflicts] - Seller-safe conflict strings.
 * @param {string|null} args.expiresAt - ISO timestamp the range expires.
 * @param {number|null} args.processingMs - Total processing duration.
 */
export function buildOfferrSellerProjection({
  evaluationId,
  outcome,
  preliminaryRange,
  confidenceLabel,
  nextStep,
  matchedProperty,
  assumptions = [],
  dataConflicts = [],
  expiresAt = null,
  processingMs = null,
} = {}) {
  const range =
    outcome === OFFERR_OUTCOMES.INSTANT_RANGE_ELIGIBLE ||
    outcome === OFFERR_OUTCOMES.CONDITIONAL_RANGE
      ? projectRange(preliminaryRange)
      : null;

  return {
    evaluation_id: clean(evaluationId),
    spine_version: OFFERR_SPINE_VERSION,
    outcome: clean(outcome),
    property: projectPropertySummary(matchedProperty),
    preliminary_range: range,
    confidence_label: clean(confidenceLabel),
    next_step: clean(nextStep),
    assumptions: assumptions.map((a) => clean(a)).filter(Boolean),
    data_conflicts: dataConflicts.map((c) => clean(c)).filter(Boolean),
    binding: false,
    preliminary: true,
    disclaimer: OFFERR_SELLER_DISCLAIMER,
    expires_at: clean(expiresAt),
    processing_ms: finiteNum(processingMs),
  };
}

export default {
  buildOfferrSellerProjection,
  OFFERR_SELLER_DISCLAIMER,
  OFFERR_SELLER_PROJECTION_FORBIDDEN_TOKENS,
};
