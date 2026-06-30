/**
 * Buyer Match V4 Phase 2 — buyer family identity graph (read-only).
 * Reuses Acquisition Engine V3 deterministic classifiers. No hardcoded parent maps.
 */
import { resolveBuyer, BUYER_ARCHETYPES, INSTITUTIONAL_ARCHETYPES } from '../acquisition/buyerIdentityResolution.js';
import { INSTITUTIONAL_BUYER_PATTERNS } from '../acquisition/valuationUniverses.js';
import { normalizeEntityName } from '../acquisition/transactionClustering.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const LENDER_RE = /\b(bank|mortgage|lending|servicer|servicing|trustee|fannie\s*mae|freddie\s*mac|wells\s*fargo|chase|citibank|us\s*bank|loan|lienholder)\b/i;
const FORECLOSURE_DOC_RE = /foreclos|reo|trustee|sheriff|tax (deed|sale|lien)/i;

/** @typedef {'DISPOSITION_BUYER'|'DEMAND_ONLY'|'NON_MARKET_TRANSFER'|'GOVERNMENT_OR_AGENCY'|'LENDER_OR_FORECLOSURE'|'RELATED_PARTY'|'PACKAGE_UNRESOLVED'|'IDENTITY_UNRESOLVED'|'EXCLUDED'} BuyerDemandEligibility */

/**
 * Map V3 archetype + RPC evidence to V4 buyer class.
 */
export function mapBuyerClass({ archetype, candidate = {}, entity = null } = {}) {
  const blob = String(candidate.buyer_name ?? entity?.buyer_name ?? '').toLowerCase();
  const institutionalScore = num(candidate.institutional_score) ?? 0;
  const purchaseCount = num(entity?.purchase_count ?? candidate.purchase_count) ?? 0;
  const marketsActive = Array.isArray(entity?.markets_active) ? entity.markets_active.length : num(entity?.markets_active) ?? 0;

  if (archetype === BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT) {
    return {
      buyerClass: /non-?profit|habitat|charity/.test(blob) ? 'NONPROFIT' : 'GOVERNMENT_AGENCY',
      institutionalSubtype: null,
      eligibleDispositionBuyer: false,
      classificationConfidence: 85,
      classificationBasis: ['gov_name_pattern'],
    };
  }
  if (LENDER_RE.test(blob)) {
    return {
      buyerClass: 'LENDER_OR_SERVICER',
      institutionalSubtype: null,
      eligibleDispositionBuyer: false,
      classificationConfidence: 80,
      classificationBasis: ['lender_name_pattern'],
    };
  }
  if (archetype === BUYER_ARCHETYPES.REIT) {
    return {
      buyerClass: 'REIT',
      institutionalSubtype: 'REIT',
      eligibleDispositionBuyer: true,
      classificationConfidence: 70,
      classificationBasis: ['reit_name_pattern'],
    };
  }
  if (archetype === BUYER_ARCHETYPES.PRIVATE_EQUITY) {
    return {
      buyerClass: 'PRIVATE_EQUITY_PLATFORM',
      institutionalSubtype: 'PRIVATE_EQUITY',
      eligibleDispositionBuyer: true,
      classificationConfidence: 55,
      classificationBasis: ['pe_name_pattern'],
    };
  }
  if (archetype === BUYER_ARCHETYPES.BUILDER_DEVELOPER) {
    return {
      buyerClass: 'BUILDER',
      institutionalSubtype: 'BUILDER',
      eligibleDispositionBuyer: true,
      classificationConfidence: 65,
      classificationBasis: ['builder_name_pattern'],
    };
  }
  if (
    archetype === BUYER_ARCHETYPES.INSTITUTIONAL_SFR
    || (candidate.buyer_type === 'institutional' && institutionalScore >= 70)
    || (INSTITUTIONAL_BUYER_PATTERNS.some((re) => re.test(blob)) && purchaseCount >= 25)
  ) {
    return {
      buyerClass: 'INSTITUTIONAL_OPERATOR',
      institutionalSubtype: 'SFR_OPERATOR',
      eligibleDispositionBuyer: true,
      classificationConfidence: candidate.buyer_type === 'institutional' ? 85 : 70,
      classificationBasis: ['institutional_type_or_pattern'],
    };
  }
  if (archetype === BUYER_ARCHETYPES.REGIONAL_OPERATOR || (purchaseCount >= 40 || marketsActive >= 3)) {
    return {
      buyerClass: 'REGIONAL_OPERATOR',
      institutionalSubtype: null,
      eligibleDispositionBuyer: true,
      classificationConfidence: 70,
      classificationBasis: ['regional_velocity'],
    };
  }
  if (archetype === BUYER_ARCHETYPES.LOCAL_INVESTOR || candidate.is_repeat_buyer) {
    return {
      buyerClass: 'LOCAL_INVESTOR',
      institutionalSubtype: null,
      eligibleDispositionBuyer: true,
      classificationConfidence: 55,
      classificationBasis: ['local_repeat_pattern'],
    };
  }
  if (archetype === BUYER_ARCHETYPES.OWNER_OCCUPANT) {
    return {
      buyerClass: 'INDIVIDUAL',
      institutionalSubtype: null,
      eligibleDispositionBuyer: false,
      classificationConfidence: 45,
      classificationBasis: ['owner_occupant'],
    };
  }
  if (candidate.buyer_type === 'trust') {
    return {
      buyerClass: 'TRUST',
      institutionalSubtype: null,
      eligibleDispositionBuyer: false,
      classificationConfidence: 50,
      classificationBasis: ['trust_type'],
    };
  }
  return {
    buyerClass: 'UNKNOWN',
    institutionalSubtype: null,
    eligibleDispositionBuyer: false,
    classificationConfidence: 20,
    classificationBasis: ['insufficient_evidence'],
  };
}

/**
 * Classify transaction demand / pricing eligibility for a purchase row.
 * @returns {{ demandEligible: BuyerDemandEligibility, pricingEligible: boolean, exclusionReasons: string[] }}
 */
export function classifyDemandEligibility(row = {}, buyerClass = 'UNKNOWN') {
  const exclusionReasons = [];
  const docType = String(row.document_type ?? '');
  const buyerName = String(row.buyer_name ?? '');

  if (buyerClass === 'GOVERNMENT_AGENCY' || buyerClass === 'NONPROFIT') {
    return { demandEligible: 'GOVERNMENT_OR_AGENCY', pricingEligible: false, exclusionReasons: ['government_or_nonprofit_grantee'] };
  }
  if (buyerClass === 'LENDER_OR_SERVICER' || LENDER_RE.test(buyerName)) {
    return { demandEligible: 'LENDER_OR_FORECLOSURE', pricingEligible: false, exclusionReasons: ['lender_grantee'] };
  }
  if (FORECLOSURE_DOC_RE.test(docType)) {
    return { demandEligible: 'LENDER_OR_FORECLOSURE', pricingEligible: false, exclusionReasons: ['foreclosure_or_tax_deed_channel'] };
  }
  if (!row.buyer_entity_id && !row.buyer_key && !buyerName) {
    return { demandEligible: 'IDENTITY_UNRESOLVED', pricingEligible: false, exclusionReasons: ['missing_buyer_identity'] };
  }
  if (row._isPackage && !row._packageAllocationSupported) {
    exclusionReasons.push('package_consideration_unallocated');
    return { demandEligible: 'PACKAGE_UNRESOLVED', pricingEligible: false, exclusionReasons };
  }
  if (buyerClass === 'INDIVIDUAL' || buyerClass === 'TRUST') {
    return { demandEligible: 'NON_MARKET_TRANSFER', pricingEligible: false, exclusionReasons: ['non_investor_grantee'] };
  }
  if (['LOCAL_INVESTOR', 'REGIONAL_OPERATOR', 'INSTITUTIONAL_OPERATOR', 'REIT', 'PRIVATE_EQUITY_PLATFORM', 'BUILDER'].includes(buyerClass)) {
    return { demandEligible: 'DISPOSITION_BUYER', pricingEligible: !row._isPackage, exclusionReasons };
  }
  if (buyerClass === 'UNKNOWN') {
    return { demandEligible: 'IDENTITY_UNRESOLVED', pricingEligible: false, exclusionReasons: ['unresolved_buyer_class'] };
  }
  return { demandEligible: 'EXCLUDED', pricingEligible: false, exclusionReasons: ['excluded_buyer_class'] };
}

function familyIdForCandidate(candidate = {}) {
  return candidate.buyer_key || candidate.buyer_entity_id || `name:${normalizeEntityName(candidate.buyer_name ?? '')}` || 'unknown';
}

/**
 * Build buyer family projections from RPC candidates + optional entity rows.
 * Groups only on verified buyer_key equality — never fuzzy name merge.
 */
export function buildBuyerFamilyProjections(candidates = [], entityByKey = new Map()) {
  const families = new Map();

  for (const candidate of candidates) {
    const familyId = familyIdForCandidate(candidate);
    const entity = candidate.buyer_key ? entityByKey.get(candidate.buyer_key) ?? null : null;
    const resolved = resolveBuyer({
      name: candidate.buyer_name,
      isCorporate: candidate.is_corporate_buyer,
      entity,
    });
    const classification = mapBuyerClass({ archetype: resolved.archetype, candidate, entity });

    if (!families.has(familyId)) {
      families.set(familyId, {
        buyerFamilyId: familyId,
        canonicalName: resolved.canonical_name || normalizeEntityName(candidate.buyer_name ?? '') || 'Identity unresolved',
        displayName: candidate.buyer_name ?? entity?.buyer_name ?? 'Identity unresolved',
        parentPlatform: {
          entityId: null,
          name: null,
          relationshipConfidence: null,
          relationshipBasis: null,
          verified: false,
        },
        legalEntities: [],
        classification,
        match: null,
      });
    }

    const family = families.get(familyId);
    const entityId = candidate.buyer_entity_id ?? candidate.buyer_key ?? familyId;
    const existing = family.legalEntities.find((e) => e.entityId === entityId);
    if (!existing) {
      family.legalEntities.push({
        entityId,
        legalName: candidate.buyer_name ?? 'Unknown entity',
        normalizedName: resolved.canonical_name || normalizeEntityName(candidate.buyer_name ?? ''),
        relationshipType: family.legalEntities.length === 0 ? 'PARENT' : 'ALIAS',
        confidence: resolved.identity_confidence,
        purchaseCount: num(candidate.matched_purchase_count) ?? num(entity?.purchase_count) ?? 0,
      });
    }

    const score = num(candidate.total_match_score ?? candidate.match_score);
    if (!family.match || (score ?? 0) > (family.match?.matchScore ?? 0)) {
      family.match = {
        matchScore: score,
        matchGrade: candidate.match_grade ?? null,
        matchConfidence: num(candidate.confidence) ?? null,
        reasonSummary: candidate.reason_for_match
          ? [String(candidate.reason_for_match)]
          : [],
        likelyBidLow: num(candidate.likely_exit_low),
        likelyBidBase: num(candidate.median_purchase_price) ?? num(candidate.avg_purchase_price),
        likelyBidHigh: num(candidate.likely_exit_high),
        nearestPurchaseMiles: num(candidate.distance_miles),
        lastPurchaseAt: candidate.last_purchase_date ?? null,
        contactReadiness: 'ENRICHMENT_REQUIRED',
        candidate,
        entity,
        resolved,
      };
    }
  }

  return [...families.values()];
}

export function isVerifiedInstitutional(family) {
  const cls = family?.classification?.buyerClass;
  return ['INSTITUTIONAL_OPERATOR', 'REIT', 'PRIVATE_EQUITY_PLATFORM'].includes(cls);
}

export function isBuilder(family) {
  return family?.classification?.buyerClass === 'BUILDER';
}

export function isLocalOrRegional(family) {
  return ['LOCAL_INVESTOR', 'REGIONAL_OPERATOR'].includes(family?.classification?.buyerClass);
}

export function isEligibleDispositionFamily(family) {
  return family?.classification?.eligibleDispositionBuyer === true
    && family?.classification?.buyerClass !== 'GOVERNMENT_AGENCY'
    && family?.classification?.buyerClass !== 'LENDER_OR_SERVICER';
}

export default {
  mapBuyerClass,
  classifyDemandEligibility,
  buildBuyerFamilyProjections,
  isVerifiedInstitutional,
  isBuilder,
  isLocalOrRegional,
  isEligibleDispositionFamily,
};