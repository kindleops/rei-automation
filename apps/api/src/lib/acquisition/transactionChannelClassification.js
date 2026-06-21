/**
 * Acquisition Engine V3 — transaction channel classification (mission Item 5A §8).
 *
 * Deterministically classifies an enriched comp transaction into a channel, and
 * declares pricing vs demand eligibility + the universe it should feed. Pure.
 */

import { TX_CHANNELS, VALUATION_UNIVERSES as U, lower, num } from './modelConstants.js';
import { BUYER_ARCHETYPES, INVESTOR_ARCHETYPES, INSTITUTIONAL_ARCHETYPES } from './buyerIdentityResolution.js';

/**
 * @returns {{ channel:string, pricing_eligible:boolean, demand_eligible:boolean,
 *   universe:string|null, reasons:string[] }}
 */
export function classifyTransactionChannel({
  salePrice,
  mlsSoldPrice,
  documentType,
  archetype = BUYER_ARCHETYPES.UNKNOWN,
} = {}) {
  const reasons = [];
  const price = num(salePrice, 0);
  const mls = num(mlsSoldPrice, 0);
  const doc = lower(documentType);

  // Non-sale / nominal: no consideration and no MLS sold price.
  if (price <= 0 && mls <= 0) {
    return { channel: TX_CHANNELS.REFINANCE_OR_NON_SALE, pricing_eligible: false, demand_eligible: archetype !== BUYER_ARCHETYPES.UNKNOWN, universe: null, reasons: ['no_consideration_non_sale'] };
  }
  // Distressed / non-arm's-length document types or government grantee.
  if (/foreclos|trustee|sheriff|reo/.test(doc) || archetype === BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT) {
    return { channel: TX_CHANNELS.FORECLOSURE, pricing_eligible: false, demand_eligible: false, universe: U.LIQUIDATION_VALUE, reasons: ['distressed_or_government_non_arms_length'] };
  }
  if (/tax (deed|sale|lien)/.test(doc)) {
    return { channel: TX_CHANNELS.TAX_SALE, pricing_eligible: false, demand_eligible: false, universe: U.LIQUIDATION_VALUE, reasons: ['tax_sale'] };
  }
  // MLS arm's-length retail.
  if (mls > 0) {
    return { channel: TX_CHANNELS.MLS_ARM_LENGTH, pricing_eligible: true, demand_eligible: true, universe: U.RETAIL_MLS_VALUE, reasons: ['mls_sold_price_present'] };
  }
  // Off-market investor / institutional, priced.
  if (INSTITUTIONAL_ARCHETYPES.has(archetype)) {
    return { channel: TX_CHANNELS.INSTITUTIONAL_SINGLE_ASSET, pricing_eligible: true, demand_eligible: true, universe: U.INSTITUTIONAL_VALUE, reasons: ['institutional_buyer_priced'] };
  }
  if (INVESTOR_ARCHETYPES.has(archetype) || archetype === BUYER_ARCHETYPES.BUILDER_DEVELOPER) {
    return { channel: TX_CHANNELS.INVESTOR_OFF_MARKET, pricing_eligible: true, demand_eligible: true, universe: U.LOCAL_INVESTOR_VALUE, reasons: ['investor_buyer_priced'] };
  }
  // Owner-occupant off-market or unknown buyer but priced → public-record arm's-length.
  return {
    channel: TX_CHANNELS.PUBLIC_RECORD_UNVERIFIED,
    pricing_eligible: true,
    demand_eligible: archetype !== BUYER_ARCHETYPES.UNKNOWN,
    universe: U.PUBLIC_RECORD_ARM_LENGTH_VALUE,
    reasons: [archetype === BUYER_ARCHETYPES.OWNER_OCCUPANT ? 'owner_occupant_public_record' : 'unresolved_buyer_public_record'],
  };
}
