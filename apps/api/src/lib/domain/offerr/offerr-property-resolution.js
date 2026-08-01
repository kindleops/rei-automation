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
 *   - candidate set incomplete / unbounded / unstable     -> AMBIGUOUS
 *   - candidates only conflict on city/state/ZIP evidence -> NOT_FOUND (fail closed)
 *   - partial street similarity only                      -> NOT_FOUND
 *   - unparseable input (no street number/name)           -> INVALID_INPUT
 *
 * COMPLETENESS IS AN INVARIANT, NOT AN ASSUMPTION.
 * ------------------------------------------------
 * RESOLVED asserts that exactly ONE canonical property matches the submitted
 * identity. That claim is only defensible if the resolver has seen EVERY
 * candidate the filter can produce. The candidate query is a deliberate
 * SUPERSET filter (street-number prefix + street-name-token containment) and
 * all identity-relevant discrimination — suffix, directionals, unit, parcel
 * duplication, geography — happens in JavaScript AFTER the rows arrive. A
 * truncated page therefore hides conflicts, and the AMBIGUOUS guard cannot
 * fire on rows it never received.
 *
 * The previous implementation issued `.limit(25)` with NO `ORDER BY`. Postgres
 * was free to return any 25 matching rows, in any order, and to change that
 * choice between two identical calls. A duplicate parcel, a second unit or a
 * conflicting ZIP sitting outside the window produced a confident RESOLVED for
 * a property that was not uniquely identified — a seller-facing
 * property-identity defect. This module now:
 *
 *   1. orders every candidate page deterministically, ending in a UNIQUE
 *      tie-breaker (`property_export_id`, the canonical PRIMARY KEY), so the
 *      page boundary itself is reproducible;
 *   2. asks PostgREST for an EXACT count on every page, so the resolver knows
 *      how many rows exist, not just how many it received;
 *   3. paginates with `.range()` until the full counted set is in hand;
 *   4. fails closed to AMBIGUOUS whenever completeness cannot be proven —
 *      count unavailable, bound exceeded, page error, duplicate rows across
 *      pages, a count that moved mid-pagination, or a deadline overrun.
 *
 * Work is explicitly bounded (page size, max pages, max candidates, deadline,
 * input length) so a malformed or adversarial address cannot trigger an
 * unbounded scan. Exceeding a bound is an AMBIGUOUS outcome, never a RESOLVED
 * one.
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

/**
 * Deterministic candidate ordering. Stable identity columns first so the page
 * boundary is meaningful to a human reading diagnostics, then two unique keys:
 *
 *   - `property_id`        — UNIQUE (uq_properties_property_id) and the value
 *                            the resolver ultimately returns;
 *   - `property_export_id` — the canonical PRIMARY KEY, and therefore the
 *                            final, guaranteed-unique tie-breaker. Even if a
 *                            duplicate property_id ever existed, the total
 *                            order still holds.
 *
 * Natural (unordered) database order is never relied upon.
 */
const CANDIDATE_ORDER_KEYS = Object.freeze([
  'property_address_full',
  'property_address_city',
  'property_address_state',
  'property_address_zip',
  'property_id',
  'property_export_id',
]);

export const OFFERR_CANDIDATE_ORDERING_VERSION = 'offerr_candidate_order_v1';

/**
 * Explicit, documented bounds on candidate work. Every one of these is a
 * fail-closed boundary: crossing it yields AMBIGUOUS, never RESOLVED.
 *
 * `max_candidates` is deliberately generous relative to reality — a single
 * street number combined with one street-name token addresses far fewer than
 * 500 canonical rows in a 124k-row table — so ordinary sellers never see a
 * bound-induced review, while a pathological or adversarial input still
 * terminates after a fixed, small amount of database work.
 */
export const OFFERR_CANDIDATE_BOUNDS = Object.freeze({
  page_size: 100,
  max_pages: 5,
  max_candidates: 500,
  deadline_ms: 5_000,
  max_address_length: 240,
  max_name_token_length: 64,
});

export const OFFERR_RESOLUTION_METHOD = 'properties_structured_match_v3';

/**
 * Reasons the candidate set could not be proven complete. Each one forces
 * AMBIGUOUS. They are internal diagnostics — the seller-safe projection never
 * carries them.
 */
export const OFFERR_INCOMPLETE_CANDIDATE_REASONS = Object.freeze({
  COUNT_UNAVAILABLE: 'candidate_count_unavailable',
  BOUND_EXCEEDED: 'candidate_set_exceeds_safe_bound',
  TRUNCATED: 'candidate_set_truncated',
  PAGINATION_FAILED: 'candidate_pagination_failed',
  PAGINATION_INCONSISTENT: 'candidate_pagination_inconsistent',
  SET_CHANGED: 'candidate_set_changed_during_pagination',
  DEADLINE_EXCEEDED: 'candidate_load_deadline_exceeded',
});

function clean(value) {
  return String(value ?? '').trim();
}

/**
 * Integer or null. "Absent" MUST be tested before coercion: `Number(null)` is
 * 0, so a missing count would otherwise read as a legitimate "zero rows match"
 * and an unprovable set would look complete — the exact failure this module
 * exists to prevent.
 */
function finiteInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Reduce a parsed street-name token to characters that can appear in a real
 * canonical address, so an attacker-supplied `%`, `_` or `*` cannot widen the
 * ILIKE pattern into a table-wide scan. PostgREST offers no ESCAPE clause, so
 * an allowlist is the only reliable defence. The in-process equality match is
 * unaffected — this only narrows which rows the database is asked for.
 */
function likeSafeToken(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, OFFERR_CANDIDATE_BOUNDS.max_name_token_length);
}

function incompleteLoad(reason, partial = {}) {
  return {
    rows: [],
    complete: false,
    incomplete_reason: reason,
    total_count: null,
    total_count_known: false,
    truncated: true,
    pages_loaded: 0,
    page_size: OFFERR_CANDIDATE_BOUNDS.page_size,
    ...partial,
  };
}

/**
 * Default candidate loader against the canonical `properties` table:
 * street-number prefix AND street-name containment — a deliberate superset —
 * retrieved deterministically, counted exactly, and paginated to completion or
 * to a documented bound. Read-only.
 *
 * @returns {Promise<object>} completeness envelope (see incompleteLoad).
 */
async function loadCandidatesFromProperties(parsed, deps = {}) {
  const db = deps.db ?? deps.supabase ?? getDefaultSupabaseClient();
  const bounds = { ...OFFERR_CANDIDATE_BOUNDS, ...(deps.candidateBounds ?? {}) };
  const nowMs = deps.nowMs ?? (() => Date.now());
  const deadline = nowMs() + bounds.deadline_ms;

  const nameToken = likeSafeToken(parsed.street_name.split(' ')[0]);

  const rows = [];
  const seenKeys = new Set();
  let expectedTotal = null;
  let pagesLoaded = 0;

  for (let page = 0; page < bounds.max_pages; page += 1) {
    if (nowMs() > deadline) {
      return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.DEADLINE_EXCEEDED, {
        pages_loaded: pagesLoaded,
        page_size: bounds.page_size,
        total_count: expectedTotal,
        total_count_known: expectedTotal !== null,
      });
    }

    const from = page * bounds.page_size;
    const to = from + bounds.page_size - 1;

    // The exact count is requested on EVERY page, not just the first: a count
    // that moves between pages proves the underlying set changed underneath
    // the pagination, which makes any single-winner claim unsafe.
    let query = db
      .from('properties')
      .select(PROPERTY_RESOLUTION_SELECT, { count: 'exact' })
      .ilike('property_address_full', `${parsed.street_number} %`);
    if (nameToken) query = query.ilike('property_address_full', `%${nameToken}%`);
    for (const column of CANDIDATE_ORDER_KEYS) {
      query = query.order(column, { ascending: true, nullsFirst: false });
    }

    const { data, error, count } = await query.range(from, to);

    if (error) {
      if (page === 0) {
        // The canonical source is unreachable. That is a dependency fault, not
        // an identity ambiguity: surface it so it is retried and alerted on,
        // rather than telling a seller their address needs confirmation.
        throw Object.assign(new Error('offerr_property_lookup_failed'), {
          code: 'offerr_property_lookup_failed',
          cause: error,
        });
      }
      return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.PAGINATION_FAILED, {
        pages_loaded: pagesLoaded,
        page_size: bounds.page_size,
        total_count: expectedTotal,
        total_count_known: expectedTotal !== null,
      });
    }

    const pageRows = Array.isArray(data) ? data : [];
    const pageCount = finiteInt(count);

    if (pageCount === null) {
      // PostgREST answered without an exact count (Prefer honoured but
      // Content-Range unusable, or a client that does not surface it).
      // Completeness is unprovable — fail closed.
      return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.COUNT_UNAVAILABLE, {
        pages_loaded: pagesLoaded,
        page_size: bounds.page_size,
      });
    }

    if (expectedTotal === null) {
      expectedTotal = pageCount;
      if (expectedTotal > bounds.max_candidates) {
        return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.BOUND_EXCEEDED, {
          pages_loaded: pagesLoaded,
          page_size: bounds.page_size,
          total_count: expectedTotal,
          total_count_known: true,
        });
      }
    } else if (pageCount !== expectedTotal) {
      return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.SET_CHANGED, {
        pages_loaded: pagesLoaded,
        page_size: bounds.page_size,
        total_count: expectedTotal,
        total_count_known: true,
      });
    }

    pagesLoaded += 1;

    for (const row of pageRows) {
      // The deterministic total order guarantees each row appears on exactly
      // one page. A repeat means the ordering was not total or the set shifted
      // — either way the window is untrustworthy.
      const key = `${clean(row?.property_export_id)}|${clean(row?.property_id)}`;
      if (seenKeys.has(key)) {
        return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.PAGINATION_INCONSISTENT, {
          pages_loaded: pagesLoaded,
          page_size: bounds.page_size,
          total_count: expectedTotal,
          total_count_known: true,
        });
      }
      seenKeys.add(key);
      rows.push(row);
    }

    if (rows.length >= expectedTotal) break;

    if (pageRows.length < bounds.page_size) {
      // The server says more rows exist than it is willing to return. Never
      // reconcile that silently.
      return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.PAGINATION_INCONSISTENT, {
        pages_loaded: pagesLoaded,
        page_size: bounds.page_size,
        total_count: expectedTotal,
        total_count_known: true,
      });
    }
  }

  if (expectedTotal === null || rows.length !== expectedTotal) {
    return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.TRUNCATED, {
      pages_loaded: pagesLoaded,
      page_size: bounds.page_size,
      total_count: expectedTotal,
      total_count_known: expectedTotal !== null,
    });
  }

  return {
    rows,
    complete: true,
    incomplete_reason: null,
    total_count: expectedTotal,
    total_count_known: true,
    truncated: false,
    pages_loaded: pagesLoaded,
    page_size: bounds.page_size,
  };
}

/**
 * Accept either the completeness envelope produced by the default loader or a
 * bare row array from an injected loader.
 *
 * A bare array is an assertion by the injector that the array IS the complete
 * candidate set (that is how the fixture loaders in the test suites work). The
 * assertion is still bounded: a bare array larger than `max_candidates` is
 * treated as unbounded work and fails closed. The production path never takes
 * this branch — `loadCandidatesFromProperties` always returns the envelope.
 */
function normalizeLoadResult(loaded, bounds) {
  if (Array.isArray(loaded)) {
    if (loaded.length > bounds.max_candidates) {
      return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.BOUND_EXCEEDED, {
        total_count: loaded.length,
        total_count_known: true,
        pages_loaded: 1,
        page_size: bounds.page_size,
      });
    }
    return {
      rows: loaded,
      complete: true,
      incomplete_reason: null,
      total_count: loaded.length,
      total_count_known: true,
      truncated: false,
      pages_loaded: 1,
      page_size: bounds.page_size,
    };
  }
  if (!loaded || typeof loaded !== 'object' || !Array.isArray(loaded.rows)) {
    return incompleteLoad(OFFERR_INCOMPLETE_CANDIDATE_REASONS.COUNT_UNAVAILABLE);
  }
  return loaded;
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
 * Parse a canonical row; trustworthy structured columns take precedence over
 * the parsed free-text address.
 *
 * Precedence is only applied where the structured column normalizes cleanly.
 * When BOTH sides state a value and they disagree, neither is silently
 * preferred: the conflict is recorded so the caller can fail closed rather
 * than reconcile a canonical record against itself.
 */
function parseCandidate(summary) {
  const parsed = parseSellerAddress(summary.property_address_full ?? '');
  const structured = {
    city: normalizeCityName(summary.city) || null,
    state: normalizeStateCode(summary.state) || null,
    zip5: normalizeZip5(summary.zip) || null,
  };

  const canonicalFieldConflicts = [];
  for (const part of ['city', 'state', 'zip5']) {
    if (structured[part] && parsed[part] && structured[part] !== parsed[part]) {
      canonicalFieldConflicts.push(part);
    }
  }

  return {
    ...parsed,
    city: structured.city || parsed.city,
    state: structured.state || parsed.state,
    zip5: structured.zip5 || parsed.zip5,
    canonical_field_conflicts: canonicalFieldConflicts,
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
    diagnostics: null,
    ...extra,
  };
}

/**
 * Internal-only resolution diagnostics. Deliberately separate from the
 * seller-safe projection, which allowlists its fields one by one and can
 * therefore never carry any of this.
 */
function buildDiagnostics({ load, bounds, summaries, baseMatches, conflicted, reason }) {
  return {
    candidate_count: summaries?.length ?? 0,
    total_count: load.total_count ?? null,
    total_count_known: Boolean(load.total_count_known),
    truncated: Boolean(load.truncated),
    complete: Boolean(load.complete),
    pages_loaded: load.pages_loaded ?? 0,
    page_size: load.page_size ?? bounds.page_size,
    matching_candidate_count: baseMatches?.length ?? 0,
    conflicting_candidate_count: conflicted?.length ?? 0,
    resolution_method: OFFERR_RESOLUTION_METHOD,
    ordering_version: OFFERR_CANDIDATE_ORDERING_VERSION,
    ordering_keys: [...CANDIDATE_ORDER_KEYS],
    reason_code: reason,
    bounds: {
      page_size: bounds.page_size,
      max_pages: bounds.max_pages,
      max_candidates: bounds.max_candidates,
      deadline_ms: bounds.deadline_ms,
      max_address_length: bounds.max_address_length,
    },
  };
}

/**
 * Deterministically resolve a seller-submitted address to one canonical
 * property record.
 *
 * RESOLVED is returned only when the resolver has proven that exactly one
 * canonical property matches the submitted identity across the COMPLETE
 * candidate set. Anything less — including "we could not establish what the
 * complete set is" — fails closed.
 *
 * @param {object} args
 * @param {string} [args.rawAddress] - Original seller input (commas intact).
 * @param {string} [args.normalizedAddress] - Fallback normalized string.
 * @param {object} [deps]
 * @param {Function} [deps.loadCandidates] - Injectable candidate loader
 *   `(parsedInput, deps) => rows | completenessEnvelope`.
 * @param {object} [deps.db] - Injectable Supabase client for the default loader.
 * @param {object} [deps.candidateBounds] - Bound overrides (tests only).
 */
export async function resolveOfferrSubjectProperty(
  { rawAddress, normalizedAddress } = {},
  deps = {},
) {
  const bounds = { ...OFFERR_CANDIDATE_BOUNDS, ...(deps.candidateBounds ?? {}) };
  const input = clean(rawAddress) || clean(normalizedAddress);

  // Bound the input before any parsing or database work: an oversized address
  // must not become an expensive pattern.
  if (input.length > bounds.max_address_length) {
    return result(OFFERR_RESOLUTION_STATUSES.INVALID_INPUT, {
      parsed_input: null,
      reason: 'address_too_long',
    });
  }

  const parsed = parseSellerAddress(input);

  if (!parsed.ok) {
    return result(OFFERR_RESOLUTION_STATUSES.INVALID_INPUT, {
      parsed_input: parsed,
      reason: parsed.reason ?? 'unparseable_address',
    });
  }

  const loadCandidates = deps.loadCandidates ?? loadCandidatesFromProperties;
  const load = normalizeLoadResult(await loadCandidates(parsed, deps), bounds);

  // Completeness is checked BEFORE any matching. A single apparent winner
  // inside an unprovable set is exactly the failure this resolver exists to
  // prevent, so no match evaluation runs until the set is known to be whole.
  if (!load.complete) {
    const reason = load.incomplete_reason ?? OFFERR_INCOMPLETE_CANDIDATE_REASONS.TRUNCATED;
    return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
      candidate_count: 0,
      candidates: [],
      parsed_input: parsed,
      reason,
      diagnostics: buildDiagnostics({ load, bounds, summaries: [], reason }),
    });
  }

  const summaries = load.rows.map(toCandidateSummary).filter((c) => c.property_id);

  const evaluated = summaries.map((summary) => {
    const candidate = parseCandidate(summary);
    const base = isBaseIdentityMatch(parsed, candidate);
    const conflicts = base ? geographyConflict(parsed, candidate) : [];
    return { summary, candidate, base, conflicts };
  });

  // A canonical row whose structured columns contradict its own free-text
  // address cannot be trusted to identify a property. It is never a winner,
  // and its presence among the base matches blocks resolution outright.
  const selfInconsistent = evaluated.filter(
    (e) => e.base && e.candidate.canonical_field_conflicts.length > 0,
  );
  const conflicted = evaluated.filter(
    (e) => e.base && e.candidate.canonical_field_conflicts.length === 0 && e.conflicts.length > 0,
  );
  const baseMatches = evaluated.filter(
    (e) => e.base && e.candidate.canonical_field_conflicts.length === 0 && e.conflicts.length === 0,
  );

  const diagnose = (reason) =>
    buildDiagnostics({ load, bounds, summaries, baseMatches, conflicted, reason });

  const common = {
    candidate_count: summaries.length,
    candidates: summaries,
    geography_conflicts: conflicted.length,
    parsed_input: parsed,
  };

  if (selfInconsistent.length > 0) {
    const reason = `canonical_field_conflict:${selfInconsistent[0].candidate.canonical_field_conflicts.join('+')}`;
    return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
      ...common,
      reason,
      diagnostics: diagnose(reason),
    });
  }

  if (baseMatches.length === 0) {
    if (conflicted.length > 0) {
      // Right street, wrong stated city/state/ZIP: never guess — fail closed.
      const reason = `geography_conflict:${conflicted[0].conflicts.join('+')}`;
      return result(OFFERR_RESOLUTION_STATUSES.NOT_FOUND, {
        ...common,
        reason,
        diagnostics: diagnose(reason),
      });
    }
    if (summaries.length > 0) {
      return result(OFFERR_RESOLUTION_STATUSES.NOT_FOUND, {
        ...common,
        reason: 'no_structured_match',
        diagnostics: diagnose('no_structured_match'),
      });
    }
    return result(OFFERR_RESOLUTION_STATUSES.NOT_FOUND, {
      ...common,
      reason: 'no_candidates_found',
      diagnostics: diagnose('no_candidates_found'),
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
        diagnostics: diagnose('unique_structured_match_with_unit'),
      });
    }
    if (unitMatches.length > 1) {
      return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
        ...common,
        reason: 'multiple_matches_for_stated_unit',
        diagnostics: diagnose('multiple_matches_for_stated_unit'),
      });
    }
    return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
      ...common,
      reason: 'stated_unit_not_matched',
      diagnostics: diagnose('stated_unit_not_matched'),
    });
  }

  // Seller omitted a unit: any unit-bearing candidate at the base address
  // means identity is not deterministic without confirmation.
  const withUnits = baseMatches.filter((e) => e.candidate.unit);
  if (withUnits.length > 0) {
    const reason =
      withUnits.length === baseMatches.length && baseMatches.length > 1
        ? 'missing_unit_for_multi_unit_address'
        : 'unit_required_for_unit_property';
    return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
      ...common,
      reason,
      diagnostics: diagnose(reason),
    });
  }

  if (baseMatches.length === 1) {
    return result(OFFERR_RESOLUTION_STATUSES.RESOLVED, {
      ...common,
      property_id: baseMatches[0].summary.property_id,
      match: baseMatches[0].summary,
      reason: 'unique_structured_match',
      diagnostics: diagnose('unique_structured_match'),
    });
  }

  return result(OFFERR_RESOLUTION_STATUSES.AMBIGUOUS, {
    ...common,
    reason: 'multiple_structured_matches',
    diagnostics: diagnose('multiple_structured_matches'),
  });
}

export default {
  resolveOfferrSubjectProperty,
  OFFERR_RESOLUTION_METHOD,
  OFFERR_CANDIDATE_BOUNDS,
  OFFERR_CANDIDATE_ORDERING_VERSION,
  OFFERR_INCOMPLETE_CANDIDATE_REASONS,
};
