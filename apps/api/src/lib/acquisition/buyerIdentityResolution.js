/**
 * Acquisition Engine V3 — buyer identity resolution (mission Item 5A §8).
 *
 * Resolves a comp buyer (grantee) into a canonical identity + archetype from
 * deterministic source evidence (name, corporate flag, optional buyer_entities_v2
 * buy-box). Pure & deterministic. No fuzzy matching beyond name normalization.
 */

import { lower, clean } from './modelConstants.js';
import { normalizeEntityName } from './transactionClustering.js';
import { INSTITUTIONAL_BUYER_PATTERNS } from './valuationUniverses.js';

export const BUYER_ARCHETYPES = Object.freeze({
  LOCAL_INVESTOR: 'LOCAL_INVESTOR',
  REGIONAL_OPERATOR: 'REGIONAL_OPERATOR',
  PROFESSIONAL_FLIPPER: 'PROFESSIONAL_FLIPPER',
  BUY_AND_HOLD: 'BUY_AND_HOLD',
  INSTITUTIONAL_SFR: 'INSTITUTIONAL_SFR',
  HEDGE_FUND: 'HEDGE_FUND',
  PRIVATE_EQUITY: 'PRIVATE_EQUITY',
  REIT: 'REIT',
  BUILDER_DEVELOPER: 'BUILDER_DEVELOPER',
  OWNER_OCCUPANT: 'OWNER_OCCUPANT',
  GOVERNMENT_OR_NONPROFIT: 'GOVERNMENT_OR_NONPROFIT',
  UNKNOWN: 'UNKNOWN',
});

const ENTITY_SUFFIX_RE = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|lp|l\.p|llp|ltd|limited|trust|holdings|properties|property|investments|capital|group|partners|enterprises|realty|management|fund|reit)\b/;
const GOV_RE = /\b(authority|housing|secretary of|veteran|county of|city of|state of|department of|\bhud\b|fannie\s*mae|freddie\s*mac|federal|government|non-?profit|habitat|agency|redevelopment)\b/;
const BUILDER_RE = /\b(construction|builders?|development|developer|homebuilders?|build\b)\b/;
const REIT_RE = /\breit\b|residential trust|equity residential/;
const PE_RE = /\b(capital|partners|equity|cerberus|blackstone|pretium|private equity)\b/;

/**
 * @returns {{ canonical_buyer_id:string|null, canonical_name:string, archetype:string,
 *   identity_confidence:number, is_corporate:boolean, matched_entity:boolean }}
 */
export function resolveBuyer({ name, isCorporate = false, entity = null } = {}) {
  const raw = clean(name);
  const norm = normalizeEntityName(raw);
  const blob = lower(raw);
  if (!raw) {
    return { canonical_buyer_id: null, canonical_name: '', archetype: BUYER_ARCHETYPES.UNKNOWN, identity_confidence: 0, is_corporate: false, matched_entity: false };
  }

  const hasSuffix = ENTITY_SUFFIX_RE.test(blob);
  const corporate = Boolean(isCorporate) || hasSuffix;
  let archetype;
  let confidence;

  if (GOV_RE.test(blob)) {
    archetype = BUYER_ARCHETYPES.GOVERNMENT_OR_NONPROFIT;
    confidence = 85;
  } else if (INSTITUTIONAL_BUYER_PATTERNS.some((re) => re.test(blob))) {
    archetype = REIT_RE.test(blob) ? BUYER_ARCHETYPES.REIT : BUYER_ARCHETYPES.INSTITUTIONAL_SFR;
    confidence = 85;
  } else if (REIT_RE.test(blob)) {
    archetype = BUYER_ARCHETYPES.REIT;
    confidence = 70;
  } else if (BUILDER_RE.test(blob)) {
    archetype = BUYER_ARCHETYPES.BUILDER_DEVELOPER;
    confidence = 65;
  } else if (corporate) {
    // entity-resolved buy-box refines local vs regional/institutional
    if (entity) {
      const markets = Number(entity.markets_active ?? 0);
      const purchases = Number(entity.purchase_count ?? 0);
      if (purchases >= 200 || markets >= 8) archetype = BUYER_ARCHETYPES.INSTITUTIONAL_SFR;
      else if (purchases >= 40 || markets >= 3) archetype = BUYER_ARCHETYPES.REGIONAL_OPERATOR;
      else archetype = BUYER_ARCHETYPES.LOCAL_INVESTOR;
      confidence = 70;
    } else if (PE_RE.test(blob)) {
      archetype = BUYER_ARCHETYPES.PRIVATE_EQUITY;
      confidence = 55;
    } else {
      archetype = BUYER_ARCHETYPES.LOCAL_INVESTOR;
      confidence = 55;
    }
  } else {
    // No entity suffix, not flagged corporate → individual / owner-occupant
    archetype = BUYER_ARCHETYPES.OWNER_OCCUPANT;
    confidence = 45;
  }

  return {
    canonical_buyer_id: entity?.buyer_key ?? (norm ? `name:${norm}` : null),
    canonical_name: norm,
    archetype,
    identity_confidence: confidence,
    is_corporate: corporate,
    matched_entity: Boolean(entity),
    observed_buy_box: entity
      ? {
          markets_active: entity.markets_active ?? null,
          purchase_count: entity.purchase_count ?? null,
          avg_purchase_price: entity.avg_purchase_price ?? null,
          preferred_asset_classes: entity.preferred_asset_classes ?? null,
        }
      : null,
  };
}

/** Archetypes that represent genuine investor pricing evidence. */
export const INVESTOR_ARCHETYPES = new Set([
  BUYER_ARCHETYPES.LOCAL_INVESTOR,
  BUYER_ARCHETYPES.REGIONAL_OPERATOR,
  BUYER_ARCHETYPES.PROFESSIONAL_FLIPPER,
  BUYER_ARCHETYPES.BUY_AND_HOLD,
]);
export const INSTITUTIONAL_ARCHETYPES = new Set([
  BUYER_ARCHETYPES.INSTITUTIONAL_SFR,
  BUYER_ARCHETYPES.HEDGE_FUND,
  BUYER_ARCHETYPES.PRIVATE_EQUITY,
  BUYER_ARCHETYPES.REIT,
]);
