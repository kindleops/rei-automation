/**
 * Acquisition Engine V3 — transaction channel classification (Item 5A §8 +
 * comp-quality hardening). Deterministically classifies an enriched comp into a
 * channel + EVIDENCE ROLE, and declares pricing/demand eligibility + the
 * universe it feeds. New-construction and renovated-flip transactions are routed
 * to retail/ARV evidence (not ordinary investor wholesale value). Pure.
 */

import { TX_CHANNELS, VALUATION_UNIVERSES as U, lower, num, clean } from './modelConstants.js';
import { BUYER_ARCHETYPES, INVESTOR_ARCHETYPES, INSTITUTIONAL_ARCHETYPES } from './buyerIdentityResolution.js';

export const EVIDENCE_ROLES = Object.freeze({
  ORDINARY_INVESTOR_PRICING: 'ORDINARY_INVESTOR_PRICING',
  INSTITUTIONAL_SINGLE_ASSET_PRICING: 'INSTITUTIONAL_SINGLE_ASSET_PRICING',
  RETAIL_RESALE_PRICING: 'RETAIL_RESALE_PRICING',
  RETAIL_NEW_CONSTRUCTION_PRICING: 'RETAIL_NEW_CONSTRUCTION_PRICING',
  RENOVATED_ARV_PRICING: 'RENOVATED_ARV_PRICING',
  DISTRESSED_LIQUIDATION_PRICING: 'DISTRESSED_LIQUIDATION_PRICING',
  PACKAGE_DEMAND_ONLY: 'PACKAGE_DEMAND_ONLY',
  GOVERNMENT_PROGRAM_CONTEXT_ONLY: 'GOVERNMENT_PROGRAM_CONTEXT_ONLY',
  EXCLUDED: 'EXCLUDED',
  REVIEW_ONLY: 'REVIEW_ONLY',
});

const RENO_NAME_RE = /renovat|reno\b|rehab|\bflip|restoration|remodel|home ?solutions|fix\s|revamp/;

function saleYearOf(saleDate) {
  const s = clean(saleDate);
  const m = s.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

/**
 * @returns {{ channel, evidence_role, pricing_eligible, demand_eligible, universe, reasons }}
 */
export function classifyTransactionChannel({
  salePrice,
  mlsSoldPrice,
  documentType,
  archetype = BUYER_ARCHETYPES.UNKNOWN,
  yearBuilt = null,
  saleDate = null,
  buyerName = '',
} = {}) {
  const price = num(salePrice, 0);
  const mls = num(mlsSoldPrice, 0);
  const doc = lower(documentType);
  const R = EVIDENCE_ROLES;

  // 1) Non-sale / nominal.
  if (price <= 0 && mls <= 0) {
    return { channel: TX_CHANNELS.REFINANCE_OR_NON_SALE, evidence_role: R.EXCLUDED, pricing_eligible: false, demand_eligible: archetype !== BUYER_ARCHETYPES.UNKNOWN, universe: null, reasons: ['no_consideration_non_sale'] };
  }
  // 2) Distressed / forced-sale instruments (Trustee's/Sheriff's/Foreclosure/REO/Substitute Trustee).
  if (/foreclos|trustee|sheriff|\breo\b|substitute trustee/.test(doc)) {
    return { channel: TX_CHANNELS.FORECLOSURE, evidence_role: R.DISTRESSED_LIQUIDATION_PRICING, pricing_eligible: false, demand_eligible: false, universe: U.LIQUIDATION_VALUE, reasons: [`distressed_instrument:${doc || 'unknown'}`] };
  }
  if (/tax (deed|sale|lien)/.test(doc)) {
    return { channel: TX_CHANNELS.TAX_SALE, evidence_role: R.DISTRESSED_LIQUIDATION_PRICING, pricing_eligible: false, demand_eligible: false, universe: U.LIQUIDATION_VALUE, reasons: ['tax_sale'] };
  }
  // 3) Government / nonprofit grantee — pricing-ineligible by default (may be subsidized/programmatic).
  if (archetype === BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT) {
    return { channel: TX_CHANNELS.RELATED_PARTY, evidence_role: R.GOVERNMENT_PROGRAM_CONTEXT_ONLY, pricing_eligible: false, demand_eligible: false, universe: null, reasons: ['government_or_nonprofit_not_proven_arms_length'] };
  }
  // 4) New construction — route to retail new-construction, NOT ordinary investor.
  const saleYear = saleYearOf(saleDate);
  const yb = num(yearBuilt);
  if (yb && saleYear && yb >= saleYear - 1) {
    return { channel: TX_CHANNELS.BUILDER_DEVELOPMENT, evidence_role: R.RETAIL_NEW_CONSTRUCTION_PRICING, pricing_eligible: true, demand_eligible: true, universe: U.RETAIL_MLS_VALUE, reasons: [`new_construction(year_built=${yb}, sale=${saleYear})`] };
  }
  // 5) MLS arm's-length retail resale.
  if (mls > 0) {
    return { channel: TX_CHANNELS.MLS_ARM_LENGTH, evidence_role: R.RETAIL_RESALE_PRICING, pricing_eligible: true, demand_eligible: true, universe: U.RETAIL_MLS_VALUE, reasons: ['mls_sold_price_present'] };
  }
  // 6) Renovated-flip buyer — ARV / retail ceiling evidence, not as-is investor value.
  if (RENO_NAME_RE.test(lower(buyerName))) {
    return { channel: TX_CHANNELS.INVESTOR_OFF_MARKET, evidence_role: R.RENOVATED_ARV_PRICING, pricing_eligible: true, demand_eligible: true, universe: U.RETAIL_MLS_VALUE, reasons: ['renovated_flip_buyer_name'] };
  }
  // 7) Institutional single-asset, priced.
  if (INSTITUTIONAL_ARCHETYPES.has(archetype)) {
    return { channel: TX_CHANNELS.INSTITUTIONAL_SINGLE_ASSET, evidence_role: R.INSTITUTIONAL_SINGLE_ASSET_PRICING, pricing_eligible: true, demand_eligible: true, universe: U.INSTITUTIONAL_VALUE, reasons: ['institutional_buyer_priced'] };
  }
  // 8) Ordinary investor / builder-as-buyer of existing stock, priced.
  if (INVESTOR_ARCHETYPES.has(archetype) || archetype === BUYER_ARCHETYPES.BUILDER_DEVELOPER) {
    return { channel: TX_CHANNELS.INVESTOR_OFF_MARKET, evidence_role: R.ORDINARY_INVESTOR_PRICING, pricing_eligible: true, demand_eligible: true, universe: U.LOCAL_INVESTOR_VALUE, reasons: ['investor_buyer_priced'] };
  }
  // 9) Owner-occupant / unresolved but priced → public-record arm's-length.
  return {
    channel: TX_CHANNELS.PUBLIC_RECORD_UNVERIFIED,
    evidence_role: R.RETAIL_RESALE_PRICING,
    pricing_eligible: true,
    demand_eligible: archetype !== BUYER_ARCHETYPES.UNKNOWN,
    universe: U.PUBLIC_RECORD_ARM_LENGTH_VALUE,
    reasons: [archetype === BUYER_ARCHETYPES.OWNER_OCCUPANT ? 'owner_occupant_public_record' : 'unresolved_buyer_public_record'],
  };
}
