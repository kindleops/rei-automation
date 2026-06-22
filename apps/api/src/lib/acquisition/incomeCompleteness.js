/**
 * Acquisition Engine V3 — Item 5C: data-completeness scoring (mission §11).
 *
 * Reports completeness SEPARATELY per evidence domain (never one blended,
 * misleading percentage) and, per strategy, the required / available / missing /
 * assumed fields plus the MAXIMUM qualification status the data can support.
 *
 * Pure & deterministic. Operates on a canonical income snapshot (provFields).
 */

import { EVIDENCE_BASIS, isKnown } from './incomeSnapshotContract.js';
import { STRATEGY_QUALIFICATION as SQ } from './modelConstants.js';

/** Domain → snapshot fields that constitute it. */
export const COMPLETENESS_DOMAINS = Object.freeze({
  physical: ['total_units', 'rentable_square_feet'],
  rent: ['actual_monthly_base_rent', 'market_monthly_rent'],
  occupancy: ['occupied_units', 'occupancy_rate'],
  expenses: ['property_taxes', 'insurance', 'management', 'repairs_maintenance', 'total_operating_expenses'],
  noi: ['actual_noi', 'stabilized_noi', 'effective_gross_income'],
  cap_rate: ['implied_cap_rate'],
  debt: ['loan_balance', 'monthly_principal_interest', 'interest_rate'],
});

/** A field counts as "assumed" when present but only modeled/inferred. */
const ASSUMED_BASES = new Set([EVIDENCE_BASIS.MARKET_MODELED, EVIDENCE_BASIS.SYSTEM_INFERRED]);

function scoreDomain(snapshot, fields, extra = {}) {
  const available = []; const missing = []; const assumed = [];
  for (const f of fields) {
    const fld = snapshot[f];
    if (isKnown(fld)) {
      available.push(f);
      if (ASSUMED_BASES.has(fld.basis)) assumed.push(f);
    } else missing.push(f);
  }
  const denom = fields.length || 1;
  return {
    completeness: Math.round((available.length / denom) * 100),
    available, missing, assumed,
    ...extra,
  };
}

/**
 * @param {object} snapshot canonical income snapshot
 * @param {object} [aux] { repair_confidence, buyer_exit_confidence } 0..100
 */
export function buildIncomeCompleteness(snapshot, aux = {}) {
  const domains = {};
  for (const [d, fields] of Object.entries(COMPLETENESS_DOMAINS)) {
    domains[d] = scoreDomain(snapshot, fields);
  }
  // repairs / buyer_exit are scored from external confidence inputs (not snapshot scalars).
  domains.repairs = { completeness: Math.round(aux.repair_confidence ?? 0), available: [], missing: aux.repair_confidence ? [] : ['repair_estimate'], assumed: [] };
  domains.buyer_exit = { completeness: Math.round(aux.buyer_exit_confidence ?? 0), available: [], missing: aux.buyer_exit_confidence ? [] : ['buyer_demand'], assumed: [] };

  const strategy = buildStrategyCompleteness(snapshot, domains);

  return { domains, strategy };
}

/** Required snapshot fields per strategy + the data-driven qualification ceiling. */
export const STRATEGY_REQUIRED_FIELDS = Object.freeze({
  CASH: ['total_units', 'rentable_square_feet'], // comp-driven; income optional
  NOVATION: ['total_units', 'market_monthly_rent'],
  SUBJECT_TO: ['loan_balance', 'monthly_principal_interest', 'interest_rate'],
  SELLER_FINANCE: ['actual_noi', 'market_monthly_rent', 'loan_balance'],
});

function maxQualification(available, missing, assumed) {
  if (missing.length === 0 && assumed.length === 0) return SQ.UNDERWRITTEN_SHADOW; // EXECUTABLE still needs the exec flag
  if (missing.length === 0) return SQ.UNDERWRITTEN_SHADOW;
  if (available.length > 0) return SQ.PROVISIONAL_SCENARIO;
  return SQ.DATA_REQUIRED;
}

function buildStrategyCompleteness(snapshot, domains) {
  const out = {};
  for (const [strat, required] of Object.entries(STRATEGY_REQUIRED_FIELDS)) {
    const available = []; const missing = []; const assumed = [];
    for (const f of required) {
      const fld = snapshot[f];
      if (isKnown(fld)) {
        available.push(f);
        if (ASSUMED_BASES.has(fld.basis)) assumed.push(f);
      } else missing.push(f);
    }
    out[strat] = {
      required_fields: required,
      available_fields: available,
      missing_fields: missing,
      assumed_fields: assumed,
      completeness: Math.round((available.length / (required.length || 1)) * 100),
      max_possible_qualification: maxQualification(available, missing, assumed),
    };
  }
  return out;
}
