/**
 * Offerr Evaluation Spine — candidate-completeness and determinism proof.
 *
 * This suite exists because of one seller-facing property-identity defect:
 * `offerr-property-resolution.js` issued `.limit(25)` with NO `ORDER BY`.
 * Postgres was free to return any 25 matching rows, in any order, and to
 * change that choice between two identical calls. Because ALL identity-
 * relevant discrimination (suffix, directionals, unit, duplicate parcels,
 * geography) happens in JavaScript AFTER the rows arrive, a conflicting
 * candidate outside the window was invisible — and the AMBIGUOUS guard, which
 * counts only the rows it received, could not fire. The resolver returned a
 * confident RESOLVED for a property that was not uniquely identified.
 *
 * WHY THIS ADAPTER, NOT A MOCK
 * ----------------------------
 * `PostgrestTable` below is a behavioural model of PostgREST/Supabase, not a
 * stub of the resolver's expectations. It implements:
 *
 *   - ILIKE with real `%`/`_` wildcard semantics, case-insensitively;
 *   - multi-key ORDER BY applied left to right with explicit NULLS FIRST/LAST;
 *   - `.range(from, to)` INCLUSIVE on both ends, like the Range header;
 *   - `{ count: 'exact' }` returning total matching rows IGNORING the range;
 *   - a configurable NATURAL ORDER that is deliberately hostile (shuffled,
 *     reversed, rotated) whenever no ORDER BY is supplied.
 *
 * That last property is what makes these tests real proof: the fixtures are
 * built so the conflicting row lands OUTSIDE the first 25 in natural order.
 * Against the old implementation the resolver would have seen one clean match
 * and answered RESOLVED. `docs/offerr/offerr-evaluation-spine.md` records the
 * executed proof that the old code fails this fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOfferrSubjectProperty,
  OFFERR_CANDIDATE_BOUNDS,
  OFFERR_CANDIDATE_ORDERING_VERSION,
  OFFERR_INCOMPLETE_CANDIDATE_REASONS,
} from '@/lib/domain/offerr/offerr-property-resolution.js';
import { evaluateOfferrProperty } from '@/lib/domain/offerr/offerr-evaluation-service.js';
import { createInMemoryOfferrEvaluationStore } from '@/lib/domain/offerr/offerr-evaluation-store.js';
import {
  OFFERR_OUTCOMES,
  OFFERR_RESOLUTION_STATUSES,
} from '@/lib/domain/offerr/offerr-contracts.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');
const SUBJECT = '1400 Sycamore Ln, Houston, TX 77035';

/* ── Row helpers ─────────────────────────────────────────────────────────── */

let exportSeq = 0;
function row({ id, full, city = 'Houston', state = 'TX', zip = '77035', type = 'SFR' }) {
  exportSeq += 1;
  return {
    property_id: id,
    property_export_id: `exp-${String(exportSeq).padStart(6, '0')}`,
    property_address_full: full,
    property_address: full.split(',')[0],
    property_address_city: city,
    property_address_state: state,
    property_address_zip: zip,
    property_type: type,
    market: `${city}, ${state}`,
  };
}

/** Filler rows on the same street NUMBER that never base-match the subject. */
function filler(count, { prefix = 'f' } = {}) {
  return Array.from({ length: count }, (_, i) =>
    row({ id: `${prefix}-${i}`, full: `1400 Sycamore Ct Apt ${i}, Houston, TX 77035` }),
  );
}

/** The genuine, uniquely-identifying subject record. */
const TRUE_MATCH = () => row({ id: 'true-match', full: '1400 Sycamore Ln, Houston, TX 77035' });

/* ── A behavioural PostgREST model ───────────────────────────────────────── */

/** PostgREST ILIKE: `%` = any run, `_` = one char; everything else literal. */
function ilikeMatches(value, pattern) {
  const rx = new RegExp(
    `^${String(pattern)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/%/g, '[\\s\\S]*')
      .replace(/_/g, '[\\s\\S]')}$`,
    'i',
  );
  return rx.test(String(value ?? ''));
}

function compareNullable(a, b, ascending, nullsFirst) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return nullsFirst ? -1 : 1;
  if (bNull) return nullsFirst ? 1 : -1;
  const cmp = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return ascending ? cmp : -cmp;
}

/**
 * @param {object[]} rows           Rows in HOSTILE natural order.
 * @param {object}   [behaviour]    Fault injection for the failure-path proofs.
 */
function PostgrestTable(rows, behaviour = {}) {
  const state = { rows: [...rows], requests: [] };

  const client = {
    _requests: state.requests,
    /** Simulates a concurrent writer inserting a row. */
    _insert(newRow, at = state.rows.length) {
      state.rows.splice(at, 0, newRow);
    },
    /** Simulates a concurrent writer deleting a row. */
    _delete(id) {
      const i = state.rows.findIndex((r) => r.property_id === id);
      if (i >= 0) state.rows.splice(i, 1);
    },
    from(table) {
      return {
        select(columns, options = {}) {
          const q = {
            table,
            columns,
            countMode: options?.count ?? null,
            filters: [],
            order: [],
            from: null,
            to: null,
          };
          const api = {
            ilike(column, pattern) {
              q.filters.push({ column, pattern });
              return api;
            },
            order(column, opts = {}) {
              q.order.push({
                column,
                ascending: opts.ascending !== false,
                nullsFirst: opts.nullsFirst === true,
              });
              return api;
            },
            range(from, to) {
              q.from = from;
              q.to = to;
              return run();
            },
            limit() {
              return run();
            },
            then(resolve, reject) {
              return run().then(resolve, reject);
            },
          };

          async function run() {
            const index = state.requests.length;
            state.requests.push({ ...q, order: q.order.map((o) => o.column) });

            if (behaviour.failPageIndexes?.includes(index)) {
              return {
                data: null,
                error: { code: '57014', message: 'statement timeout' },
                count: null,
              };
            }

            let matched = state.rows.filter((r) =>
              q.filters.every((f) => ilikeMatches(r[f.column], f.pattern)),
            );

            // No ORDER BY => hostile natural order. This is the whole point:
            // it is what a real planner is permitted to do, and what the old
            // unordered LIMIT 25 silently depended on.
            if (q.order.length > 0) {
              matched = [...matched].sort((a, b) => {
                for (const o of q.order) {
                  const c = compareNullable(a[o.column], b[o.column], o.ascending, o.nullsFirst);
                  if (c !== 0) return c;
                }
                return 0;
              });
            }

            const total = matched.length;
            let page =
              q.from === null
                ? matched
                : matched.slice(q.from, Number.isFinite(q.to) ? q.to + 1 : undefined);

            if (behaviour.duplicateAcrossPages && index > 0 && state.lastPageFirst) {
              page = [state.lastPageFirst, ...page.slice(1)];
            }
            state.lastPageFirst = page[0] ?? null;

            // A transport that hands back the same row twice inside ONE
            // response. Impossible against a table with a primary key, which
            // is exactly why the resolver must not take it on trust.
            if (behaviour.duplicateInPayload && page.length > 1) {
              page = [page[0], ...page.slice(0, -1)];
            }

            if (behaviour.shortPageAtIndex === index) page = page.slice(0, 1);

            behaviour.afterPage?.(index, client);

            // `??` must not be used here: an override that deliberately
            // returns null (PostgREST answering without a usable count) would
            // fall straight back to the real total and silently pass.
            const count =
              q.countMode === 'exact'
                ? behaviour.countOverride
                  ? behaviour.countOverride(index, total)
                  : total
                : null;

            return { data: page, error: null, count };
          }

          return api;
        },
      };
    },
  };
  return client;
}

function resolve(address, client, deps = {}) {
  return resolveOfferrSubjectProperty({ rawAddress: address }, { db: client, ...deps });
}

/* ── 1-8: truncation must never hide a conflict ──────────────────────────── */

test('1. a conflicting duplicate at row 26 blocks resolution (the core defect)', async () => {
  // Natural order: 25 non-matching fillers, the true match, then a DUPLICATE
  // parcel at the same address. Under the old unordered LIMIT 25 the window
  // held only fillers + at most one match and never saw the duplicate.
  const duplicate = row({ id: 'duplicate-parcel', full: '1400 Sycamore Ln, Houston, TX 77035' });
  const client = PostgrestTable([...filler(24), TRUE_MATCH(), duplicate]);

  const r = await resolve(SUBJECT, client);

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'multiple_structured_matches');
  assert.equal(r.property_id, null);
  assert.equal(r.diagnostics.matching_candidate_count, 2, 'both parcels were examined');
  assert.equal(r.diagnostics.complete, true);
});

test('2. fifty candidates in randomized order still resolve identically', async () => {
  const base = [...filler(49), TRUE_MATCH()];
  const seen = new Set();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    // Deterministic but different hostile natural order on every attempt.
    const shuffled = [...base].sort(
      (a, b) =>
        ((a.property_id.length * (attempt + 7)) % 13) - ((b.property_id.length * (attempt + 3)) % 13),
    );
    shuffled.push(shuffled.shift());
    const r = await resolve(SUBJECT, PostgrestTable(shuffled));
    seen.add(`${r.status}:${r.property_id}:${r.reason}`);
  }
  assert.deepEqual([...seen], ['RESOLVED:true-match:unique_structured_match']);
});

test('3. one hundred repeated resolutions over shuffled order are byte-identical', async () => {
  const base = [...filler(40), TRUE_MATCH()];
  let first = null;
  for (let i = 0; i < 100; i += 1) {
    const rotated = [...base.slice(i % base.length), ...base.slice(0, i % base.length)];
    const r = await resolve(SUBJECT, PostgrestTable(rotated));
    const shape = JSON.stringify({ s: r.status, p: r.property_id, why: r.reason });
    if (first === null) first = shape;
    assert.equal(shape, first, `run ${i} diverged`);
  }
  assert.equal(first, JSON.stringify({ s: 'RESOLVED', p: 'true-match', why: 'unique_structured_match' }));
});

test('4. a second exact match far beyond the old 25-row window still blocks resolution', async () => {
  // The duplicate sits at row 121 — invisible to the pre-fix `.limit(25)`.
  const second = row({ id: 'second-exact', full: '1400 Sycamore Ln, Houston, TX 77035' });
  const client = PostgrestTable([TRUE_MATCH(), ...filler(119), second]);

  const r = await resolve(SUBJECT, client);

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'multiple_structured_matches');
  assert.equal(r.diagnostics.total_count, 121);
  assert.equal(r.diagnostics.candidate_count, 121, 'the whole set was examined');
  assert.equal(client._requests.length, 1, 'the bounded set is read in ONE statement');
});

test('5. a missing unit never auto-resolves when unit rows sit after row 25', async () => {
  const unitA = row({ id: 'unit-a', full: '1400 Sycamore Ln Unit A, Houston, TX 77035' });
  const unitB = row({ id: 'unit-b', full: '1400 Sycamore Ln Unit B, Houston, TX 77035' });
  const client = PostgrestTable([...filler(26), unitA, unitB]);

  const r = await resolve(SUBJECT, client);

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'missing_unit_for_multi_unit_address');
  assert.equal(r.property_id, null);
});

test('6. a duplicate parcel after row 25 never auto-resolves', async () => {
  const client = PostgrestTable([
    ...filler(30),
    TRUE_MATCH(),
    row({ id: 'dup-late', full: '1400 Sycamore Ln, Houston, TX 77035' }),
  ]);
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.property_id, null);
});

test('7. a conflicting ZIP after row 25 is seen and fails closed', async () => {
  // Only the far-page row shares the submitted street; its ZIP disagrees.
  const client = PostgrestTable([
    ...filler(28),
    row({ id: 'zip-clash', full: '1400 Sycamore Ln, Houston, TX 77099', zip: '77099' }),
  ]);
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.ok(r.reason.startsWith('geography_conflict:'), r.reason);
  assert.ok(r.reason.includes('zip'));
  assert.equal(r.property_id, null);
});

test('8. more candidates than the safe maximum fails closed without paging them', async () => {
  const client = PostgrestTable([...filler(60), TRUE_MATCH()]);

  const r = await resolve(SUBJECT, client, {
    candidateBounds: { page_size: 10, max_pages: 5, max_candidates: 20 },
  });

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, OFFERR_INCOMPLETE_CANDIDATE_REASONS.BOUND_EXCEEDED);
  assert.equal(r.property_id, null);
  assert.equal(r.candidates.length, 0, 'no candidate rows are carried out of a bounded failure');
  assert.equal(client._requests.length, 1, 'the bound is enforced after ONE request, not by paging');
});

/* ── 9-12: unprovable completeness always fails closed ───────────────────── */

test('9. an unavailable exact count fails closed rather than assuming completeness', async () => {
  const client = PostgrestTable([TRUE_MATCH()], { countOverride: () => null });
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, OFFERR_INCOMPLETE_CANDIDATE_REASONS.COUNT_UNAVAILABLE);
  assert.equal(r.property_id, null);
});

test('9b. a first-page query error surfaces as a dependency fault, never a resolution', async () => {
  const client = PostgrestTable([TRUE_MATCH()], { failPageIndexes: [0] });
  await assert.rejects(
    () => resolve(SUBJECT, client),
    (error) => error.code === 'offerr_property_lookup_failed',
  );
});

test('10. a payload shorter than its own exact count fails closed', async () => {
  // A server-side row cap (PostgREST `db-max-rows`) or a truncating client:
  // the statement counted 16 rows and handed back 1. Never reconcile that.
  const client = PostgrestTable([TRUE_MATCH(), ...filler(15)], { shortPageAtIndex: 0 });
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, OFFERR_INCOMPLETE_CANDIDATE_REASONS.TRUNCATED);
  assert.equal(r.property_id, null);
});

test('11. a row duplicated inside one payload fails closed', async () => {
  const client = PostgrestTable([TRUE_MATCH(), ...filler(15)], { duplicateInPayload: true });
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, OFFERR_INCOMPLETE_CANDIDATE_REASONS.PAGINATION_INCONSISTENT);
  assert.equal(r.property_id, null);
});

/**
 * THE PAGE-BOUNDARY REGRESSION.
 *
 * Multi-request pagination compared the exact count returned by each page and
 * failed closed when it moved. Count equality is NOT set equality: a writer
 * that deletes one row before the cursor and inserts another after it leaves
 * the count untouched while shifting every unread row one position left. The
 * row on the page boundary is then never returned, no duplicate appears, and
 * every guard stays silent — so the loader reported `complete: true` for a set
 * with a hole in it, and when the missing row was the duplicate parcel the
 * resolver answered RESOLVED for a property it had not uniquely identified.
 *
 * The fix is structural: the bounded candidate set is read in ONE statement,
 * with `count=exact` computed inside that same statement. There is no second
 * read for a writer to interleave with, so the interference is unrepresentable
 * rather than merely detectable.
 */
test('12. a count-preserving concurrent write cannot skip a candidate', async () => {
  const duplicate = row({ id: 'dup-parcel', full: '1400 Sycamore Ln, Houston, TX 77035' });
  const client = PostgrestTable([TRUE_MATCH(), ...filler(119), duplicate], {
    afterPage(index, c) {
      // A writer commits the moment the first read completes: one row removed
      // from the front, one appended at the back. Net count: unchanged.
      if (index === 0) {
        c._delete('f0');
        c._insert(row({ id: 'raced-in', full: '1400 Elmwood Dr, Houston, TX 77035' }));
      }
    },
  });

  const r = await resolve(SUBJECT, client);

  assert.equal(client._requests.length, 1, 'exactly ONE statement — no window to interleave with');
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'multiple_structured_matches');
  assert.equal(r.property_id, null, 'the duplicate parcel was seen, so nothing resolved');
  assert.equal(r.diagnostics.matching_candidate_count, 2);
});

test('12b. a payload longer than its own exact count fails closed', async () => {
  const client = PostgrestTable([TRUE_MATCH(), ...filler(15)], {
    countOverride: (_index, total) => total - 1,
  });
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, OFFERR_INCOMPLETE_CANDIDATE_REASONS.TRUNCATED);
  assert.equal(r.property_id, null);
});

/* ── 13-16: ordering, bounds, and honest resolution ──────────────────────── */

test('13. every candidate query is ordered and ends in a unique tie-breaker', async () => {
  const client = PostgrestTable([...filler(25), TRUE_MATCH()]);
  await resolve(SUBJECT, client);

  assert.ok(client._requests.length >= 1);
  for (const request of client._requests) {
    assert.ok(request.order.length > 0, 'no candidate query may be unordered');
    assert.equal(
      request.order[request.order.length - 1],
      'property_export_id',
      'the last order key must be the canonical PRIMARY KEY',
    );
    assert.ok(request.order.includes('property_id'), 'the unique property_id is also ordered');
    assert.equal(request.countMode, 'exact', 'every page asks for an exact count');
    assert.equal(typeof request.from, 'number', 'every page is retrieved by explicit range');
  }
});

test('14. exactly one complete candidate set still resolves', async () => {
  const client = PostgrestTable([TRUE_MATCH()]);
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'true-match');
  assert.equal(r.reason, 'unique_structured_match');
  assert.equal(r.diagnostics.complete, true);
  assert.equal(r.diagnostics.truncated, false);
  assert.equal(r.diagnostics.total_count_known, true);
  assert.equal(r.diagnostics.ordering_version, OFFERR_CANDIDATE_ORDERING_VERSION);
});

test('15. a large irrelevant candidate set with one structured match resolves', async () => {
  // 120 same-street-number rows that never base-match, plus one that does.
  const client = PostgrestTable([...filler(60), TRUE_MATCH(), ...filler(60, { prefix: 'g' })]);
  const r = await resolve(SUBJECT, client);

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'true-match');
  assert.equal(r.diagnostics.total_count, 121);
  assert.equal(r.diagnostics.candidate_count, 121, 'the WHOLE set was examined, not a window');
  assert.equal(r.diagnostics.matching_candidate_count, 1);
  assert.equal(client._requests.length, 1, '121 rows still cost exactly one statement');
});

test('16. partial street-name similarity never resolves, however many rows exist', async () => {
  const client = PostgrestTable([
    ...filler(40),
    row({ id: 'near-miss', full: '1400 Sycamore Dr, Houston, TX 77035' }),
  ]);
  const r = await resolve(SUBJECT, client);
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.NOT_FOUND);
  assert.equal(r.reason, 'no_structured_match');
  assert.equal(r.property_id, null);
});

/* ── 17-20: privacy, immutability, no side effects, bounded input ────────── */

function serviceDeps(client, overrides = {}) {
  let seq = 0;
  return {
    now: NOW,
    v3Enabled: true,
    db: client,
    store: createInMemoryOfferrEvaluationStore(),
    generateRequestId: () => `req-${++seq}`,
    generateEvaluationId: () => `eval-${seq}`,
    loadSubjectProperty: async () => null,
    loadComparableProperties: async () => [],
    loadBuyerPurchases: async () => [],
    loadV3CompCandidates: async () => null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

test('17. the seller-safe projection exposes no candidate counts, rows or diagnostics', async () => {
  const client = PostgrestTable([...filler(30), TRUE_MATCH(), row({ id: 'dup2', full: SUBJECT })]);

  const result = await evaluateOfferrProperty(
    { address: SUBJECT, idempotency_key: 'completeness-privacy-1' },
    serviceDeps(client),
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome, OFFERR_OUTCOMES.REVIEW_REQUIRED);
  assert.equal(result.seller_projection.next_step, 'confirm_property_identity');

  const serialized = JSON.stringify(result.seller_projection);
  // Note: the JSON-key form is asserted for identifier fields. The bare token
  // "property_id" is a substring of the legitimate seller-safe next step
  // `confirm_property_identity`, so matching it loosely would be a false alarm.
  for (const forbidden of [
    'candidate',
    'total_count',
    'truncated',
    'pages_loaded',
    'ordering_version',
    'true-match',
    'dup2',
    'exp-',
    '"property_id"',
    '"property_export_id"',
    'diagnostics',
    'multiple_structured_matches',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `seller payload leaked "${forbidden}"`);
  }

  // The internal record keeps full auditability.
  assert.equal(result.internal_result.resolution.diagnostics.matching_candidate_count, 2);
  assert.equal(result.internal_result.resolution.diagnostics.complete, true);
});

test('18. the resolver never mutates canonical rows', async () => {
  const rows = [...filler(30), TRUE_MATCH()].map((r) => Object.freeze({ ...r }));
  const snapshot = JSON.stringify(rows);
  const r = await resolve(SUBJECT, PostgrestTable(rows));
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(JSON.stringify(rows), snapshot, 'canonical rows were mutated');
});

test('19. no external provider request occurs during a paginated resolution', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('external fetch attempted');
  };
  try {
    const client = PostgrestTable([...filler(80), TRUE_MATCH()]);
    const r = await resolve(SUBJECT, client, { candidateBounds: { page_size: 25 } });
    assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('20. work is bounded: oversized input and wildcard injection cannot widen the scan', async () => {
  const client = PostgrestTable([TRUE_MATCH()]);

  // Oversized address is refused before any database work at all.
  const long = await resolve(`${'1400 Sycamore Ln '.repeat(40)}Houston TX 77035`, client);
  assert.equal(long.status, OFFERR_RESOLUTION_STATUSES.INVALID_INPUT);
  assert.equal(long.reason, 'address_too_long');
  assert.equal(client._requests.length, 0, 'an oversized address never reaches the database');

  // LIKE metacharacters in the street name must not survive into the pattern:
  // an unescaped '%' would turn the filter into a table-wide scan.
  await resolve('1400 %%%% Ln, Houston, TX 77035', client);
  const patterns = client._requests.flatMap((r) => r.filters.map((f) => f.pattern));
  for (const pattern of patterns) {
    assert.equal(
      /%.*%.*%/.test(pattern),
      false,
      `wildcard injection reached the database: ${pattern}`,
    );
  }

  assert.ok(OFFERR_CANDIDATE_BOUNDS.max_candidates > 0);
  assert.ok(OFFERR_CANDIDATE_BOUNDS.max_pages > 0);
  assert.equal(
    OFFERR_CANDIDATE_BOUNDS.max_candidates,
    OFFERR_CANDIDATE_BOUNDS.page_size * OFFERR_CANDIDATE_BOUNDS.max_pages,
    'the documented candidate ceiling must equal what the page bounds can actually retrieve',
  );
});

test('21. a candidate read that overruns the deadline fails closed', async () => {
  let clock = 0;
  const client = PostgrestTable([TRUE_MATCH(), ...filler(40)]);
  const r = await resolve(SUBJECT, client, {
    candidateBounds: { deadline_ms: 25 },
    // The clock passes the deadline while the statement is in flight, so the
    // rows arrive too late to be trusted as a basis for a uniqueness claim.
    nowMs: () => (clock += 30),
  });
  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, OFFERR_INCOMPLETE_CANDIDATE_REASONS.DEADLINE_EXCEEDED);
  assert.equal(r.property_id, null);
});

/* ── 23-24: the DB prefilter must be able to return the row it matches ────── */

/**
 * The candidate query narrows with `property_address_full ILIKE '%<token>%'`
 * against the RAW canonical text, while identity is decided in JavaScript
 * afterwards. Those two halves must agree about what the token IS.
 *
 * Building the token by DELETING non-`[a-z0-9-]` characters broke that:
 * "o'connor" became "oconnor", which is not a substring of "O'CONNOR" at all,
 * so the row was never retrieved and a seller with a perfectly ordinary
 * address — whose structured comparison matches exactly — was told their
 * property could not be found. Truncating at the first disallowed character
 * keeps the fragment a genuine substring while still admitting no LIKE
 * metacharacter.
 */
test('23. an apostrophe in the street name still retrieves and resolves the row', async () => {
  const client = PostgrestTable([
    row({ id: 'oconnor', full: "123 O'Connor St, Houston, TX 77035" }),
    ...filler(10),
  ]);
  const r = await resolve("123 O'Connor St, Houston, TX 77035", client);

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'oconnor');
  const namePattern = client._requests[0].filters.map((f) => f.pattern).find((p) => p.startsWith('%'));
  assert.ok(namePattern, 'a street-name filter was applied');
  assert.ok(
    "123 o'connor st, houston, tx 77035".includes(namePattern.replaceAll('%', '')),
    `the ILIKE fragment ${namePattern} must be a real substring of the canonical address`,
  );
});

test('24. an accented street name still retrieves and resolves the row', async () => {
  const client = PostgrestTable([
    row({ id: 'canada', full: '77 Cañada Rd, Houston, TX 77035' }),
    ...filler(10),
  ]);
  const r = await resolve('77 Cañada Rd, Houston, TX 77035', client);

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.RESOLVED);
  assert.equal(r.property_id, 'canada');
});

test('22. a canonical row whose structured columns fight its own address never wins', async () => {
  // property_address_full says 77035; the structured ZIP column says 77099.
  const inconsistent = row({ id: 'self-conflict', full: '1400 Sycamore Ln, Houston, TX 77035' });
  inconsistent.property_address_zip = '77099';
  const r = await resolve(SUBJECT, PostgrestTable([inconsistent]));

  assert.equal(r.status, OFFERR_RESOLUTION_STATUSES.AMBIGUOUS);
  assert.equal(r.reason, 'canonical_field_conflict:zip5');
  assert.equal(r.property_id, null);
});
