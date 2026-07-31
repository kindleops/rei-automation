/**
 * Offerr Evaluation Spine — deterministic address -> canonical property resolution.
 *
 * The repo is property_id-first; the only pre-existing address path is the
 * fuzzy entity-graph search. Offerr needs a DETERMINISTIC resolver, so this
 * module parses both the seller input and the canonical candidates into
 * structured components (street number / name / suffix / directional / unit /
 * city / state / ZIP via offerr-address-normalization.js) and applies strict
 * rules — never a fuzzy similarity score:
 *
 *   - exactly one structured match                        -> RESOLVED
 *   - multiple structured matches (parcels/units)         -> AMBIGUOUS
 *   - seller omitted unit, candidate(s) carry units       -> AMBIGUOUS
 *   - seller unit not present among base matches          -> AMBIGUOUS
 *   - candidates only conflict on city/state/ZIP evidence -> NOT_FOUND (fail closed)
 *   - partial street similarity only                      -> NOT_FOUND
 *   - unparseable input (no street number/name)           -> INVALID_INPUT
 *
 * This module never writes, never creates property records, and never calls
 * an external provider — its only data source is the canonical `properties`
 * table (or an injected loader with the same contract).
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

import {
  parseSellerAddress,
  normalizeCityName,
  normalizeStateCode,
  normalizeZip5,
} from './offerr-address-normalization.js';
import { OFFERR_RESOLUTION_STATUSES } from './offerr-contracts.js';

const PROPERTY_RESOLUTION_SELECT = [
  'property_id',
  'property_export_id',
  'property_address_full',
  'property_address',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_type',
  'market',
].join(', ');

const CANDIDATE_QUERY_LIMIT = 25;

export const OFFERR_RESOLUTION_METHOD = 'properties_structured_match_v2';

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Default candidate loader against the canonical `properties` table:
 * street-number prefix AND street-name containment, bounded, read-only.
 */
async function loadCandidatesFromProperties(parsed, deps = {}) {
  const db = deps.db ?? deps.supabase ?? getDefaultSupabaseClient();
  const nameToken = parsed.street_name.split(' ')[0];
  const { data, error } = await db
    .from('properties')
    .select(PROPERTY_RESOLUTION_SELECT)
    .ilike('property_address_full', `${parsed.street_number} %`)
    .ilike('property_address_full', `%${nameToken}%`)
    .limit(CANDIDATE_QUERY_LIMIT);

  if (error) {
    throw Object.assign(new Error('offerr_property_lookup_failed'), {
      code: 'offerr_property_lookup_failed',
      cause: error,
    });
  }
  return Array.isArray(data) ? data : [];
}

function toCandidateSummary(row) {
  return {
    property_id: clean(row.property_id) || null,
    property_address_full: clean(row.property_address_full) || null,
    city: clean(row.property_address_city) || null,
    state: clean(row.property_address_state) || null,
    zip: clean(row.property_address_zip) || null,
    property_type: clean(row.property_type) || null,
    market: clean(row.market) || null,
  };
}

/** Parse a canonical row; structured columns override parsed geography. */
function parseCandidate(summary) {
  const parsed = parseSellerAddress(summary.property_address_full ?? '');
  return {
    ...parsed,
    city: normalizeCityName(summary.city) || parsed.city,
    state: normalizeStateCode(summary.state) || parsed.state,
    zip5: normalizeZip5(summary.zip) || parsed.zip5,
  };
}

/** Components match when strictly equal, or when one side omitted the part. */
function lenientEqual(a, b) {
  if (!a || !b) return true;
  return a === b;
}

function isBaseIdentityMatch(seller, candidate) {
  if (!candidate.ok) return false;
  if (seller.street_number !== candidate.street_number) return false;
  if (seller.street_name !== candidate.street_name) return false;
  if (!lenientEqual(seller.suffix, candidate.suffix)) return false;
  if (!lenientEqual(seller.pre_directional, candidate.pre_directional)) return false;
  if (!lenientEqual(seller.post_directional, candidate.post_directional)) return false;
  return true;
}

/** True when seller and candidate BOTH state a geography part and disagree. */
function geographyConflict(seller, candidate) {
  const conflicts = [];
  if (seller.zip5 && candidate.zip5 && seller.zip5 !== candidate.zip5) conflicts.push('zip');
  if (seller.city && candidate.city && seller.city !== candidate.city) conflicts.push('city');
  if (seller.state && candidate.state && seller.state !== candidate.state) conflicts.push('state');
  return conflicts;
}

function result(status, extra) {
  return {
    status,
    property_id: null,
    match: null,
    candidate_count: 0,
    candidates: [],
    geography_conflicts: 0,
    parsed_input: null,
    reason: 'unspecified',
    method: OFFERR_RESOLUTION_METHOD,
    ...extra,
  };
}

/**
 * Deterministically resolve a seller-submitted address to one canonical
 * property record.
 *
 * @param {object} args
 * @param {string} [args.rawAddress] - Original seller input (commas intact).
 * @param {string} [args.normalizedAddress] - Fallback normalized string.
 * @param {object} [deps]
 * @param {Function} [deps.loadCandidates] - Injectable candidate loader
 *   `(parsedInput, deps) => rows` (same row shape as the properties select).
 * @param {object} [deps.db] - Injectable Supabase client for the default loader.
 */
export async function resolveOfferrSubjectProperty(
  { rawAddress, normalizedAddress } = {},
  deps = {},
) {
  const input = clean(rawAddress) || clean(normalizedAddress);
  const parsed = parseSellerAddress(input);

  if (!parsed.ok) {
    return result(OFFERR_RESOLUTION_STATUSES.INVALID_INPUT, {
      parsed_input: parsed,
      reason: parsed.reason ?? 'unparseable_address',
    });
  }

  const loadCandidates = deps.loadCandidates ?? loadCandidatesFromProperties;
  const rows = await loadCandidates(parsed, deps);
  const summaries = rows.map(toCandidateSummary).filter((c) => c.property_id);

  const evaluated = summaries.map((summary) => {
    const candidate = parseCandidate(summary);
    const base = isBaseIdentityMatch(parsed, candidate);
    const conflicts = base ? geographyConflict(parsed, candidate) : [];
    return { summary, candidate, base, conflicts };
  });

  const conflicted = evaluated.filter((e) => e.base && e.conflicts.length > 0);
  const baseMatches = evaluated.filter((e) => e.base && e.conflicts.length === 0);

  const common = {
    candidate_count: summaries.length,
    candidates: summaries,
    geography_conflicts: conflicted.length,
    parsed_input: parsed,
  };

  if (baseMatches.length === 0) {
    if (conflicted.length > 0) {
      // Right street, wrong stated city/state/ZIP: never guess — fail closed.
      return result(OFFERR_RESOLUTION_STATUSES.NOT_FOUND, {
        ...common,
        reason: `geography_conflict:${conflicted[0].conflicts.join('+')}`,
      });
    }
    if (summaries.length > 0) {
      return result(OFFERR_RESOLUTION_STATUSES.NOT_FOUND, {
        ...common,
        reason: 'no_structured_match',
      });
    }
    return result(OFFERR_RESOLUTION_STATUSES.NOT_FOUND, {
      ...common,
      reason: 'no_candidates_found',
    });
  }

  if (parsed.unit) {
    const unitMatches = baseMatches.filter((e) => e.candidate.unit === parsed.unit);
    if (unitMatches.length === 1) {
      return result(OFFERR_RESOLUTION_STATUSES.RESOLVED, {
        ...common,
        property_id: unitMatches[0].summary.property_id,
        match: unitMatches[0].summary,
        reason: 'unique_structured_match_with_unit',
      });
    }
    if (unitMatches.length > 1) {
      return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
        ...common,
        reason: 'multiple_matches_for_stated_unit',
      });
    }
    return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
      ...common,
      reason: 'stated_unit_not_matched',
    });
  }

  // Seller omitted a unit: any unit-bearing candidate at the base address
  // means identity is not deterministic without confirmation.
  const withUnits = baseMatches.filter((e) => e.candidate.unit);
  if (withUnits.length > 0) {
    return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
      ...common,
      reason:
        withUnits.length === baseMatches.length && baseMatches.length > 1
          ? 'missing_unit_for_multi_unit_address'
          : 'unit_required_for_unit_property',
    });
  }

  if (baseMatches.length === 1) {
    return result(OFFERR_RESOLUTION_STATUSES.RESOLVED, {
      ...common,
      property_id: baseMatches[0].summary.property_id,
      match: baseMatches[0].summary,
      reason: 'unique_structured_match',
    });
  }

  return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
    ...common,
    reason: 'multiple_structured_matches',
  });
}

export default { resolveOfferrSubjectProperty, OFFERR_RESOLUTION_METHOD };
