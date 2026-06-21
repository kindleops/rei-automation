/**
 * Acquisition Engine V3 — comp identity enrichment (mission Item 5A §2).
 *
 * Merges an RPC candidate with its deterministic `buyer_comp_raw_v2` identity row
 * (joined by comp_id == raw.id) and optional `buyer_entities_v2` buy-box into a
 * single normalized comp-candidate contract. Pure. If no identity row exists the
 * candidate is preserved but marked IDENTITY_UNRESOLVED with reduced pricing
 * eligibility — identity is never invented.
 */

import { num, clean } from './modelConstants.js';
import { classifyAssetLane } from './assetClassification.js';
import { resolveBuyer } from './buyerIdentityResolution.js';
import { classifyTransactionChannel } from './transactionChannelClassification.js';

const IDENTITY_FIELDS = ['owner_name', 'apn_parcel_id', 'document_type', 'recording_date', 'sale_price', 'owner_address_full'];

export function normalizeCandidate(candidate = {}, rawRow = null, entity = null) {
  const c = candidate;
  const r = rawRow;
  const ownerName = clean(r?.owner_name || r?.owner_1_name || '');
  const identityResolved = Boolean(r && ownerName);

  const laneInput = {
    normalized_asset_class: c.asset_class,
    property_type: c.property_type,
    units_count: c.units_count,
    building_square_feet: c.sqft,
  };
  const cls = classifyAssetLane(laneInput);

  const buyer = resolveBuyer({ name: ownerName, isCorporate: r?.is_corporate_owner, entity });

  const salePrice = num(c.sale_price) ?? num(r?.sale_price) ?? null;
  const mlsSold = num(c.mls_sold_price) ?? num(r?.mls_sold_price) ?? null;
  const documentType = clean(r?.document_type || r?.last_sale_doc_type || '');

  const channel = classifyTransactionChannel({
    salePrice,
    mlsSoldPrice: mlsSold,
    documentType,
    archetype: buyer.archetype,
  });

  // IDENTITY_UNRESOLVED demotes pricing eligibility unless the txn is MLS arm's-length.
  let pricingEligible = channel.pricing_eligible;
  const reasons = [...channel.reasons];
  if (!identityResolved && !(mlsSold > 0)) {
    pricingEligible = false;
    reasons.push('IDENTITY_UNRESOLVED');
  }

  const completeness = r
    ? Math.round((IDENTITY_FIELDS.filter((f) => r[f] !== null && r[f] !== undefined && r[f] !== '').length / IDENTITY_FIELDS.length) * 100)
    : 0;

  return {
    // --- keys consumed by clustering/qualification (existing field names) ---
    id: clean(c.comp_id || c.id || ''),
    property_id: clean(c.property_id || ''),
    apn_parcel_id: clean(r?.apn_parcel_id || ''),
    property_address_full: clean(c.address || ''),
    property_address_zip: clean(c.zip || ''),
    property_address_city: clean(c.city || ''),
    property_address_state: clean(c.state || ''),
    latitude: c.latitude, longitude: c.longitude,
    normalized_asset_class: c.asset_class,
    property_type: c.property_type,
    units_count: c.units_count,
    building_square_feet: c.sqft,
    total_bedrooms: c.beds, total_baths: c.baths,
    year_built: c.year_built, effective_year_built: r?.effective_year_built ?? null,
    building_condition: c.building_condition, construction_type: c.construction_type,
    subdivision_name: r?.subdivision_name ?? null,
    school_district_name: r?.school_district_name ?? null,
    sale_price: salePrice,
    sale_date: c.sale_date ?? null,
    recording_date: r?.recording_date ?? null,
    mls_sold_price: mlsSold,
    mls_sold_date: c.mls_sold_date ?? null,
    document_type: documentType,
    buyer_name_clean: ownerName || null,
    buyer_name: ownerName || null,
    is_corporate_buyer: r?.is_corporate_owner ?? null,
    buyer_mailing_address: r?.owner_address_full ?? null,
    buyer_key: entity?.buyer_key ?? null,
    total_loan_amt: r?.total_loan_amt ?? null,
    lienholder_name: r?.lienholder_name ?? null,

    // --- V3 enrichment ---
    source_table: r ? 'buyer_comp_raw_v2' : 'rpc_candidate_only',
    source_record_id: clean(r?.id || c.comp_id || ''),
    canonical_asset_lane: cls.lane,
    asset_lane_confidence: cls.confidence,
    buyer_archetype: buyer.archetype,
    canonical_buyer_id: buyer.canonical_buyer_id,
    buyer_identity_confidence: buyer.identity_confidence,
    matched_buyer_entity: buyer.matched_entity,
    observed_buy_box: buyer.observed_buy_box ?? null,
    transaction_channel: channel.channel,
    v3_channel: channel.channel,
    v3_universe_hint: channel.universe,
    v3_pricing_eligible: pricingEligible,
    v3_demand_eligible: channel.demand_eligible,
    identity_unresolved: !identityResolved,
    identity_confidence: identityResolved ? buyer.identity_confidence : 0,
    source_completeness: completeness,
    distance_miles: c.distance_miles ?? null,
    similarity_score: c.similarity_score ?? null,
    channel_reasons: reasons,
  };
}
