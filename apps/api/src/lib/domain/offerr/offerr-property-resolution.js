/**
 * Offerr Evaluation Spine — deterministic address -> canonical property resolution.
 *
 * The repo is property_id-first; the only pre-existing address path is the
 * fuzzy entity-graph search. Offerr needs a DETERMINISTIC resolver, so this
 * module queries the canonical `properties` table and applies strict rules:
 *
 *   - exactly one normalized-equal match          -> RESOLVED
 *   - more than one normalized-equal match        -> AMBIGUOUS (fail closed)
 *   - no exact match but partial candidates exist -> AMBIGUOUS (fail closed)
 *   - no candidates at all                        -> NOT_FOUND
 *
 * UNSUPPORTED is decided later from the classified asset lane, not here.
 * This module never writes and never creates property records.
 */

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';

import {
  OFFERR_RESOLUTION_STATUSES,
  normalizeOfferrAddress,
} from './offerr-contracts.js';

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

const CANDIDATE_QUERY_LIMIT = 10;

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Default candidate loader against the canonical `properties` table.
 * Matches on the leading street segment (number + first street token) so the
 * deterministic comparison in resolveOfferrSubjectProperty sees every
 * plausible sibling (unit A/B, re-imports) rather than only ilike-exact rows.
 */
async function loadCandidatesFromProperties(normalizedAddress, deps = {}) {
  const db = deps.db ?? deps.supabase ?? getDefaultSupabaseClient();
  const streetSegment = normalizedAddress.split(' ').slice(0, 2).join(' ');
  const { data, error } = await db
    .from('properties')
    .select(PROPERTY_RESOLUTION_SELECT)
    .ilike('property_address_full', `${streetSegment}%`)
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

/**
 * Deterministically resolve a normalized submitted address to one canonical
 * property record.
 *
 * @param {object} args
 * @param {string} args.normalizedAddress - Output of normalizeOfferrAddress.
 * @param {object} [deps]
 * @param {Function} [deps.loadCandidates] - Injectable candidate loader.
 * @param {object} [deps.db] - Injectable Supabase client for the default loader.
 * @returns {Promise<{
 *   status: string,
 *   property_id: string|null,
 *   match: object|null,
 *   candidate_count: number,
 *   candidates: object[],
 *   reason: string,
 *   method: string,
 * }>}
 */
export async function resolveOfferrSubjectProperty({ normalizedAddress }, deps = {}) {
  const normalized = normalizeOfferrAddress(normalizedAddress);
  const method = 'properties_address_exact_normalized_v1';

  if (!normalized) {
    return {
      status: OFFERR_RESOLUTION_STATUSES.NOT_FOUND,
      property_id: null,
      match: null,
      candidate_count: 0,
      candidates: [],
      reason: 'empty_normalized_address',
      method,
    };
  }

  const loadCandidates = deps.loadCandidates ?? loadCandidatesFromProperties;
  const rows = await loadCandidates(normalized, deps);

  const summaries = rows.map(toCandidateSummary).filter((c) => c.property_id);
  const exactMatches = summaries.filter(
    (c) => normalizeOfferrAddress(c.property_address_full) === normalized,
  );

  if (exactMatches.length === 1) {
    return {
      status: OFFERR_RESOLUTION_STATUSES.RESOLVED,
      property_id: exactMatches[0].property_id,
      match: exactMatches[0],
      candidate_count: summaries.length,
      candidates: summaries,
      reason: 'single_exact_normalized_match',
      method,
    };
  }

  if (exactMatches.length > 1) {
    return {
      status: OFFERR_RESOLUTION_STATUSES.AMBIGUOUS,
      property_id: null,
      match: null,
      candidate_count: summaries.length,
      candidates: summaries,
      reason: 'multiple_exact_normalized_matches',
      method,
    };
  }

  if (summaries.length > 0) {
    // Partial candidates without an exact match: never guess a winner.
    return {
      status: OFFERR_RESOLUTION_STATUSES.AMBIGUOUS,
      property_id: null,
      match: null,
      candidate_count: summaries.length,
      candidates: summaries,
      reason: 'partial_candidates_without_exact_match',
      method,
    };
  }

  return {
    status: OFFERR_RESOLUTION_STATUSES.NOT_FOUND,
    property_id: null,
    match: null,
    candidate_count: 0,
    candidates: [],
    reason: 'no_candidates_found',
    method,
  };
}

export default { resolveOfferrSubjectProperty };
