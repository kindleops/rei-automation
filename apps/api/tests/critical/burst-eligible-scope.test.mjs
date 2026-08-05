// ─── burst-eligible-scope.test.mjs ───────────────────────────────────────────
// Activation authority for burst work SELECTION, pinned at the store — the last
// layer before a burst is claimed and replied to.
//
// The 2026-08-03 incident left one real burst preserved and eligible on the
// pinned internal thread (`sib:+16128072000:g1:ba199924`, open, attempt_count 0,
// eligible since 22:40:51Z). Both doors into production work order by
// `eligible_at ASC` and take the first row, so on that thread the OLDEST burst
// wins every page and every single-row claim. An internal-proof session running
// on the same thread must therefore be scoped by TIME as well as by thread, and
// the scope must be applied in the query — before anything is claimed.
//
// Two doors exist and both are covered here:
//   listEligible   — the flush worker's page of work.
//   claimEligible  — the thread-scoped path, which never touches listEligible
//                    at all (coordinator flushEligible({thread_key}) →
//                    finalizeBurst → claimEligible) and hands a bare thread key
//                    to claim_seller_inbound_burst, whose SQL then picks the
//                    oldest eligible row on that thread.
//
// Selection is DENY BY DEFAULT: no scope means no work, in both stores.

import test from "node:test";
import assert from "node:assert/strict";

import "../helpers/critical-test-environment.mjs";

import {
  createMemorySellerInboundBurstStore,
  createSupabaseSellerInboundBurstStore,
  resolveBurstScopeFilter,
  matchesBurstScope,
  matchesBurstScopeThread,
  resolveThreadConstraint,
} from "@/lib/domain/seller-flow/seller-inbound-burst-store.js";
import {
  BURST_STATUSES,
  isClaimableBurst,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
// Test-only import. The store deliberately does NOT import this module (policy →
// coordinator → store would close a cycle through the production path), so the
// equivalence of the two implementations is pinned here instead of assumed.
import { isBurstWithinFlushScope } from "@/lib/domain/seller-flow/burst-flush-activation-policy.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const THREAD = "+16128072000"; // the pinned internal proof thread
const OTHER_THREAD = "+15125550143";

// Session opened TODAY. There is deliberately no grace on the lower bound.
const SESSION_START = "2026-08-05T10:00:00.000Z";
const SESSION_END = "2026-08-05T14:00:00.000Z";
const NOW = "2026-08-05T10:05:00.000Z";

/**
 * The preserved incident burst, verbatim from production. Same thread as the
 * proof session, 36 hours older, and it sorts FIRST under `eligible_at ASC`.
 */
const PRESERVED = Object.freeze({
  id: "row-preserved",
  burst_id: "sib:+16128072000:g1:ba199924",
  thread_key: THREAD,
  generation: 1,
  status: BURST_STATUSES.OPEN,
  first_received_at: "2026-08-03T22:40:31.039Z",
  last_received_at: "2026-08-03T22:40:31.039Z",
  eligible_at: "2026-08-03T22:40:51.039Z",
  hard_close_at: "2026-08-03T22:42:01.039Z",
  claimed_at: null,
  completed_at: null,
  attempt_count: 0,
  safety_latched: false,
  version: 1,
});

/** The live proof burst: same thread, opened inside the session. */
const PROOF = Object.freeze({
  id: "row-proof",
  burst_id: "sib:+16128072000:g2:evt-proof",
  thread_key: THREAD,
  generation: 2,
  status: BURST_STATUSES.OPEN,
  first_received_at: "2026-08-05T10:01:00.000Z",
  last_received_at: "2026-08-05T10:01:00.000Z",
  eligible_at: "2026-08-05T10:01:20.000Z",
  hard_close_at: "2026-08-05T10:02:30.000Z",
  claimed_at: null,
  completed_at: null,
  attempt_count: 0,
  safety_latched: false,
  version: 1,
});

/** A real seller on another thread, inside the session window in time. */
const OTHER = Object.freeze({
  id: "row-other",
  burst_id: "sib:+15125550143:g1:evt-other",
  thread_key: OTHER_THREAD,
  generation: 1,
  status: BURST_STATUSES.OPEN,
  first_received_at: "2026-08-05T10:02:00.000Z",
  last_received_at: "2026-08-05T10:02:00.000Z",
  eligible_at: "2026-08-05T10:02:20.000Z",
  hard_close_at: "2026-08-05T10:03:30.000Z",
  claimed_at: null,
  completed_at: null,
  attempt_count: 0,
  safety_latched: false,
  version: 1,
});

const ALL = [PRESERVED, PROOF, OTHER];

/**
 * The activation policy's scope descriptor (toBurstFlushScopeDescriptor().scope)
 * with the coordinator's authorization assertions attached. The field names are
 * the POLICY's — the store consumes that descriptor as-is, so this test would
 * fail the moment the two shapes diverge.
 */
const POLICY_SCOPE = Object.freeze({
  kind: "thread",
  thread_keys: [THREAD],
  min_first_received_at: SESSION_START,
  max_first_received_at: SESSION_END,
  min_created_at: SESSION_START,
  max_created_at: SESSION_END,
  session_id: "proof-session-1",
  session_created_at: SESSION_START,
  session_expires_at: SESSION_END,
});

const PROOF_SCOPE = Object.freeze({ ...POLICY_SCOPE, authorized: true, global: false });

const GLOBAL_SCOPE = Object.freeze({ authorized: true, global: true, kind: "global" });

const CLOSED_SESSION_SCOPE = Object.freeze({
  authorized: false,
  global: false,
  kind: "none",
  thread_keys: [],
  reason: "session_expired",
});

function memoryRow(fixture) {
  return {
    ...fixture,
    constituents: [{ event_id: `${fixture.burst_id}-c1`, body: "hi", received_at: fixture.first_received_at }],
    policy_version: "seller_inbound_burst_policy_v1",
    decision_idempotency_key: `k:${fixture.burst_id}`,
    claim_token: null,
    claimed_by: null,
    result_summary: null,
    created_at: fixture.first_received_at,
    updated_at: fixture.last_received_at,
  };
}

function seedMemoryStore(fixtures = ALL) {
  const store = createMemorySellerInboundBurstStore({ now: () => NOW });
  for (const f of fixtures) store._debug.byId.set(f.id, memoryRow(f));
  return store;
}

function dbRow(fixture) {
  return {
    ...fixture,
    constituent_messages: [
      { event_id: `${fixture.burst_id}-c1`, body: "hi", received_at: fixture.first_received_at },
    ],
    policy_version: "seller_inbound_burst_policy_v1",
    decision_idempotency_key: `k:${fixture.burst_id}`,
    claim_token: null,
    claimed_by: null,
    result_summary: null,
    created_at: fixture.first_received_at,
    updated_at: fixture.last_received_at,
  };
}

// ── Recording PostgREST double ───────────────────────────────────────────────
//
// Records every builder call AND honours the filters it recorded, so the tests
// prove the rows the store gets back, not merely the filters it typed. The
// `.or(...)` eligibility clause is evaluated through isClaimableBurst, which is
// the equivalence the store itself documents (store.js: "CAS fallback mirrors
// the RPC predicate exactly (see isClaimableBurst)"); test 13 pins the literal
// clause so that equivalence cannot silently rot.

function applyFilters(calls, rows, { now, lease_ms }) {
  let out = rows.slice();
  for (const c of calls) {
    const [field, value] = c.args || [];
    if (c.op === "is" && value === null) out = out.filter((r) => r[field] == null);
    else if (c.op === "or") {
      out = out.filter((r) => isClaimableBurst({ burst: r, now, lease_ms }));
    } else if (c.op === "eq") out = out.filter((r) => String(r[field]) === String(value));
    else if (c.op === "in") out = out.filter((r) => (value || []).includes(r[field]));
    else if (c.op === "gte") out = out.filter((r) => Date.parse(r[field]) >= Date.parse(value));
    else if (c.op === "lte") out = out.filter((r) => Date.parse(r[field]) <= Date.parse(value));
  }
  return out;
}

function makeRecordingBurstSupabase({ rows = [], now = NOW, lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS, rpc = null } = {}) {
  const table = rows.map((r) => ({ ...r }));
  const log = { selects: [], updates: [], rpcs: [] };

  const supabase = {
    from(table_name) {
      const calls = [{ op: "from", args: [table_name] }];
      let mode = "select";
      let patch = null;
      const chain = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const p = Promise.resolve().then(() => {
                const matched = applyFilters(calls, table, { now, lease_ms });
                if (mode === "update") {
                  log.updates.push({ patch, calls: calls.slice(), matched_ids: matched.map((r) => r.id) });
                  const target = matched[0];
                  if (!target) return { data: null, error: null };
                  Object.assign(target, patch);
                  return { data: { ...target }, error: null };
                }
                log.selects.push(calls.slice());
                let out = matched;
                const order = calls.find((c) => c.op === "order");
                if (order) {
                  out = out
                    .slice()
                    .sort((a, b) => String(a[order.args[0]]).localeCompare(String(b[order.args[0]])));
                }
                const limit = calls.find((c) => c.op === "limit");
                if (limit) out = out.slice(0, Number(limit.args[0]));
                const single = calls.some((c) => c.op === "maybeSingle" || c.op === "single");
                return { data: single ? out[0] || null : out, error: null };
              });
              return p.then.bind(p);
            }
            if (typeof prop === "symbol") return undefined;
            return (...args) => {
              if (prop === "update") {
                mode = "update";
                patch = args[0];
              }
              calls.push({ op: String(prop), args });
              return chain;
            };
          },
        }
      );
      return chain;
    },
  };

  if (rpc) {
    supabase.rpc = async (name, params) => {
      log.rpcs.push({ name, params });
      return rpc({ name, params, table });
    };
  }
  return { supabase, log, table };
}

/** Faithful stand-in for claim_seller_inbound_burst (migration :102-124). */
function sqlClaimRpc({ params, table }) {
  const stale = new Date(Date.parse(params.p_now) - Number(params.p_lease_ms || 0)).toISOString();
  const eligible = table
    .filter((r) => r.completed_at == null)
    .filter((r) =>
      (["open", "suppressed"].includes(r.status) &&
        r.eligible_at <= params.p_now &&
        (r.claimed_at == null || r.claimed_at <= stale)) ||
      (r.status === "claimed" && r.claimed_at != null && r.claimed_at <= stale)
    )
    .filter((r) => params.p_burst_id == null || r.burst_id === params.p_burst_id)
    .filter((r) => params.p_thread_key == null || r.thread_key === params.p_thread_key)
    .sort((a, b) => String(a.eligible_at).localeCompare(String(b.eligible_at)));
  const target = eligible[0];
  if (!target) return { data: [], error: null };
  Object.assign(target, {
    status: target.safety_latched ? "suppressed" : "claimed",
    claim_token: params.p_claim_token,
    claimed_at: params.p_now,
    claimed_by: params.p_worker_id,
    attempt_count: Number(target.attempt_count || 0) + 1,
    version: Number(target.version || 1) + 1,
  });
  return { data: [{ ...target }], error: null };
}

// ── 1. Scope resolution is fail-closed ───────────────────────────────────────

test("scope resolution: every ambiguity denies — absent, malformed, unauthorized, half-built", () => {
  assert.equal(resolveBurstScopeFilter(undefined).reason, "burst_scope_required");
  assert.equal(resolveBurstScopeFilter(null).reason, "burst_scope_required");
  assert.equal(resolveBurstScopeFilter("global").reason, "burst_scope_invalid");
  assert.equal(resolveBurstScopeFilter([THREAD]).reason, "burst_scope_invalid");
  assert.equal(resolveBurstScopeFilter({}).reason, "burst_scope_not_authorized");

  // The dangerous one: a scope that SAYS global but never asserted authority.
  assert.equal(
    resolveBurstScopeFilter({ global: true }).reason,
    "burst_scope_not_authorized",
    "global must never be inferred from a half-built scope"
  );

  // Denial carries the policy's own reason so the flush log says why.
  assert.equal(
    resolveBurstScopeFilter({ authorized: false, reason: "session_expired" }).reason,
    "session_expired"
  );
  assert.equal(resolveBurstScopeFilter({ authorized: false }).reason, "burst_scope_denied");
});

test("scope resolution: a malformed non-global scope DENIES — it never degrades to global", () => {
  const T = (over) => ({ authorized: true, kind: "thread", ...POLICY_SCOPE, ...over });
  const cases = [
    // Not an activation at all.
    [{ authorized: true, kind: "none", thread_keys: [] }, "burst_scope_not_activated"],
    [{ authorized: true, thread_keys: [THREAD] }, "burst_scope_not_activated"],
    // Activated but unusable.
    [T({ thread_keys: undefined }), "burst_scope_thread_keys_required"],
    [T({ thread_keys: [] }), "burst_scope_thread_keys_required"],
    [T({ thread_keys: ["  "] }), "burst_scope_thread_keys_required"],
    [T({ min_first_received_at: null }), "burst_scope_bounds_invalid"],
    [T({ min_first_received_at: "not-a-date" }), "burst_scope_bounds_invalid"],
    [T({ max_first_received_at: null }), "burst_scope_bounds_invalid"],
    // The anti-backdating bounds are not optional.
    [T({ min_created_at: null }), "burst_scope_bounds_invalid"],
    [T({ max_created_at: null, session_expires_at: null }), "burst_scope_bounds_invalid"],
    // Inverted window.
    [T({ min_first_received_at: SESSION_END, max_first_received_at: SESSION_START }), "burst_scope_bounds_invalid"],
  ];
  for (const [scope, reason] of cases) {
    const resolved = resolveBurstScopeFilter(scope);
    assert.equal(resolved.deny, true, `${reason} must deny`);
    assert.equal(resolved.reason, reason);
    assert.notEqual(resolved.global, true, "a denied scope is never global");
  }
});

test("scope resolution: an absent insert ceiling falls back to session expiry, never to unbounded", () => {
  const resolved = resolveBurstScopeFilter({
    ...PROOF_SCOPE,
    max_created_at: null,
    session_expires_at: SESSION_END,
  });
  assert.equal(resolved.deny, false);
  assert.equal(resolved.max_created, SESSION_END);
});

test("scope predicate: unprovable session membership is denied membership", () => {
  const resolved = resolveBurstScopeFilter(PROOF_SCOPE);
  const PROOF_ROW = dbRow(PROOF);
  assert.equal(matchesBurstScope(PROOF_ROW, resolved), true);
  assert.equal(matchesBurstScope(dbRow(PRESERVED), resolved), false, "36h-old burst is outside the window");
  assert.equal(matchesBurstScope(dbRow(OTHER), resolved), false, "other thread, in-window, still excluded");
  assert.equal(
    matchesBurstScope({ ...PROOF, created_at: PROOF.first_received_at, first_received_at: null }, resolved),
    false,
    "a row that cannot prove when it opened cannot claim the session"
  );
  assert.equal(
    matchesBurstScope({ ...PROOF, created_at: null }, resolved),
    false,
    "created_at absent ⇒ denied: the anti-backdating leg cannot be skipped"
  );
  assert.equal(
    // A backdated first_received_at inside the window, INSERTED before the
    // session existed. This is the replayed-artifact shape.
    matchesBurstScope(
      { ...PROOF, created_at: "2026-08-03T22:40:31.039Z" },
      resolved
    ),
    false,
    "in-window message time cannot rescue an out-of-window insert time"
  );
  assert.equal(matchesBurstScope(dbRow(PRESERVED), resolveBurstScopeFilter(GLOBAL_SCOPE)), true);
});

// ── 2. Memory store: inclusion / exclusion ───────────────────────────────────

test("memory listEligible: proof burst INCLUDED, 36h-old same-thread burst EXCLUDED, other thread EXCLUDED", async () => {
  const store = seedMemoryStore();
  const eligible = await store.listEligible({ now: NOW, scope: PROOF_SCOPE });
  assert.deepEqual(eligible.map((b) => b.burst_id), [PROOF.burst_id]);
});

test("memory listEligible: the old burst cannot consume the page — limit 1, oldest-first ordering", async () => {
  const store = seedMemoryStore();

  // Precondition: unscoped ordering really does put the preserved burst first.
  const unscoped = await store.listEligible({ now: NOW, limit: 1, scope: GLOBAL_SCOPE });
  assert.deepEqual(
    unscoped.map((b) => b.burst_id),
    [PRESERVED.burst_id],
    "eligible_at ASC gives the single page slot to the 36h-old burst"
  );

  const scoped = await store.listEligible({ now: NOW, limit: 1, scope: PROOF_SCOPE });
  assert.deepEqual(
    scoped.map((b) => b.burst_id),
    [PROOF.burst_id],
    "scoped selection is filtered BEFORE the slice, so the live burst gets the slot"
  );
});

// ── 3. Memory store: the claim path (the door that never touches listEligible) ──

test("memory claimEligible({thread_key}): claims the PROOF burst; the preserved burst is untouched", async () => {
  const store = seedMemoryStore();
  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: PROOF_SCOPE });
  assert.equal(claim.ok, true);
  assert.equal(claim.burst.burst_id, PROOF.burst_id, "not the oldest burst on the thread — the authorized one");

  const preserved = store.getById(PRESERVED.id);
  assert.equal(preserved.status, BURST_STATUSES.OPEN);
  assert.equal(preserved.attempt_count, 0);
  assert.equal(preserved.claimed_at, null);
  assert.equal(preserved.claim_token, null);
  assert.equal(preserved.version, 1);
});

test("memory claimEligible({burst_id}) targeting an out-of-scope burst is refused and mutates nothing", async () => {
  const store = seedMemoryStore();
  const claim = await store.claimEligible({
    burst_id: PRESERVED.burst_id,
    now: NOW,
    scope: PROOF_SCOPE,
  });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "no_eligible_burst");
  assert.deepEqual(store.getById(PRESERVED.id), memoryRow(PRESERVED), "row byte-identical after refusal");
});

test("memory: an unscoped global claim WOULD take the preserved burst — the scope is what stops it", async () => {
  const store = seedMemoryStore();
  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: GLOBAL_SCOPE });
  assert.equal(claim.ok, true);
  assert.equal(
    claim.burst.burst_id,
    PRESERVED.burst_id,
    "documents the hazard this change exists to close: oldest-on-thread wins"
  );
});

// ── 4. Deny by default, and closed sessions ──────────────────────────────────

test("memory: NO scope means NO work — both doors deny and nothing is mutated", async () => {
  const store = seedMemoryStore();
  assert.deepEqual(await store.listEligible({ now: NOW }), []);
  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "burst_scope_required");
  for (const f of ALL) assert.deepEqual(store.getById(f.id), memoryRow(f));
});

test("memory: a closed/expired session yields ZERO eligible rows and ZERO claims", async () => {
  const store = seedMemoryStore();
  assert.deepEqual(await store.listEligible({ now: NOW, scope: CLOSED_SESSION_SCOPE }), []);
  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: CLOSED_SESSION_SCOPE });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "session_expired", "the policy's reason survives to the caller");
  for (const f of ALL) assert.deepEqual(store.getById(f.id), memoryRow(f));
});

// ── 5. Leases, attempts and reclaim survive scoping ──────────────────────────

test("memory: stale-lease reclaim still works IN scope, and is refused OUT of scope", async () => {
  const stale_at = "2026-08-05T09:00:00.000Z"; // > lease before NOW
  const in_scope_stale = {
    ...PROOF,
    id: "row-proof-stale",
    burst_id: "sib:+16128072000:g3:evt-stale",
    status: BURST_STATUSES.CLAIMED,
    claimed_at: stale_at,
    attempt_count: 2,
    version: 4,
  };
  const out_of_scope_stale = {
    ...PRESERVED,
    id: "row-preserved-stale",
    burst_id: "sib:+16128072000:g1:stale",
    status: BURST_STATUSES.CLAIMED,
    claimed_at: stale_at,
    attempt_count: 2,
    version: 4,
  };
  const store = seedMemoryStore([in_scope_stale, out_of_scope_stale]);

  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: PROOF_SCOPE });
  assert.equal(claim.ok, true);
  assert.equal(claim.burst.burst_id, in_scope_stale.burst_id);
  assert.equal(claim.burst.attempt_count, 3, "attempt bookkeeping preserved under scope");
  assert.equal(claim.burst.version, 5);
  assert.equal(store.getById(out_of_scope_stale.id).attempt_count, 2, "out-of-scope lease is not reclaimed");
  assert.equal(store.getById(out_of_scope_stale.id).claimed_at, stale_at);
});

// ── 6. Supabase store: the production query ──────────────────────────────────

test("supabase listEligible: scope is applied IN the query — in(thread_key) + gte/lte(first_received_at)", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow) });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const eligible = await store.listEligible({ now: NOW, scope: PROOF_SCOPE });
  assert.deepEqual(eligible.map((b) => b.burst_id), [PROOF.burst_id]);

  const chain = log.selects[0];
  const find = (op) => chain.find((c) => c.op === op);
  const all = (op) => chain.filter((c) => c.op === op).map((c) => c.args);
  assert.deepEqual(find("in").args, ["thread_key", [THREAD]]);
  assert.deepEqual(all("gte"), [
    ["first_received_at", SESSION_START],
    ["created_at", SESSION_START],
  ]);
  assert.deepEqual(all("lte"), [
    ["first_received_at", SESSION_END],
    ["created_at", SESSION_END],
  ]);
  assert.equal(find("order").args[0], "eligible_at");
});

test("supabase: the PRESERVED burst's real shape yields zero rows and zero claims under a session opened today", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: [dbRow(PRESERVED)], rpc: sqlClaimRpc });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  // It IS eligible — this is not a test of an ineligible row.
  assert.equal(isClaimableBurst({ burst: PRESERVED, now: NOW }), true);

  const eligible = await store.listEligible({ now: NOW, limit: 1, scope: PROOF_SCOPE });
  assert.deepEqual(eligible, [], "no page slot");

  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: PROOF_SCOPE });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "no_eligible_burst");

  assert.deepEqual(log.rpcs, [], "no claim RPC was issued");
  assert.deepEqual(log.updates, [], "no row was mutated");
  assert.deepEqual(
    log.updates.length + log.rpcs.length,
    0,
    "the preserved burst is never claimed, completed, suppressed or retried"
  );
});

test("supabase claimEligible: the RPC is PINNED to the authorized burst_id, never handed a bare thread key", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow), rpc: sqlClaimRpc });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: PROOF_SCOPE });
  assert.equal(claim.ok, true);
  assert.equal(claim.burst.burst_id, PROOF.burst_id);

  assert.equal(log.rpcs.length, 1);
  assert.equal(
    log.rpcs[0].params.p_burst_id,
    PROOF.burst_id,
    "p_burst_id null would let the SQL pick the oldest row on the thread"
  );
  assert.equal(log.rpcs[0].params.p_thread_key, THREAD);
  assert.ok(log.selects.length >= 1, "the candidate was resolved under scope BEFORE the claim");

  // The scoped select ran first; the RPC only ever saw a pre-authorized row.
  const select_chain = log.selects[0];
  assert.ok(select_chain.some((c) => c.op === "gte" && c.args[0] === "first_received_at"));
});

test("supabase claimEligible: an empty scoped select issues NO rpc and NO update — claim can never precede authorization", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow), rpc: sqlClaimRpc });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const claim = await store.claimEligible({
    thread_key: THREAD,
    now: NOW,
    // A session window that no row can satisfy.
    scope: {
      ...PROOF_SCOPE,
      min_first_received_at: "2026-08-05T11:00:00.000Z",
      min_created_at: "2026-08-05T11:00:00.000Z",
    },
  });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "no_eligible_burst");
  assert.deepEqual(log.rpcs, []);
  assert.deepEqual(log.updates, []);
});

test("supabase: a denied scope touches the database not at all", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow), rpc: sqlClaimRpc });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  assert.deepEqual(await store.listEligible({ now: NOW, scope: CLOSED_SESSION_SCOPE }), []);
  assert.deepEqual(await store.listEligible({ now: NOW }), []);
  const denied = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: CLOSED_SESSION_SCOPE });
  const absent = await store.claimEligible({ thread_key: THREAD, now: NOW });

  assert.equal(denied.reason, "session_expired");
  assert.equal(absent.reason, "burst_scope_required");
  assert.deepEqual(log.selects, [], "no select");
  assert.deepEqual(log.rpcs, [], "no rpc");
  assert.deepEqual(log.updates, [], "no update");
});

test("supabase CAS fallback (no rpc available) carries the same scope and pins the same row", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow) }); // no rpc
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: PROOF_SCOPE });
  assert.equal(claim.ok, true);
  assert.equal(claim.burst.burst_id, PROOF.burst_id);
  assert.equal(claim.burst.attempt_count, 1);

  assert.equal(log.updates.length, 1, "exactly one row mutated");
  assert.deepEqual(log.updates[0].matched_ids, [PROOF.id], "the update targeted the authorized row only");
  for (const chain of log.selects) {
    // The thread constraint is the INTERSECTION of the scope allowlist and the
    // caller's thread, so a named thread narrows `in.(…)` to a single `eq.…`.
    // Either shape carries the scope; two predicates on the column would not.
    const thread_predicates = chain.filter(
      (c) => (c.op === "eq" || c.op === "in") && c.args[0] === "thread_key"
    );
    assert.equal(thread_predicates.length, 1, "exactly one thread predicate");
    assert.deepEqual(thread_predicates[0].args, ["thread_key", THREAD]);
    // And the temporal half of the scope is unconditionally present.
    assert.ok(
      chain.some((c) => c.op === "gte" && c.args[0] === "first_received_at"),
      "every select on the claim path carries the scope window"
    );
    assert.ok(chain.some((c) => c.op === "gte" && c.args[0] === "created_at"));
  }
});

// ── 7. Global (enabled) mode is byte-identical to pre-scope behaviour ─────────

test("supabase global scope: unchanged query — same predicate, no scope filters appended", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow) });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const eligible = await store.listEligible({ now: NOW, limit: 20, scope: GLOBAL_SCOPE });
  assert.deepEqual(
    eligible.map((b) => b.burst_id),
    [PRESERVED.burst_id, PROOF.burst_id, OTHER.burst_id],
    "enabled mode still sees all eligible work, oldest first"
  );

  const chain = log.selects[0];
  assert.deepEqual(
    chain.map((c) => c.op),
    ["from", "select", "is", "or", "order", "limit"],
    "global mode issues exactly the pre-scope chain"
  );
  // Pin the literal eligibility clause: the isClaimableBurst equivalence the
  // rest of this file relies on is only honest while this string is this string.
  assert.equal(
    chain.find((c) => c.op === "or").args[0],
    [
      `and(status.in.(open,suppressed),eligible_at.lte.${NOW},or(claimed_at.is.null,claimed_at.lte.${new Date(
        Date.parse(NOW) - SELLER_INBOUND_BURST_CLAIM_LEASE_MS
      ).toISOString()}))`,
      `and(status.eq.claimed,claimed_at.lte.${new Date(
        Date.parse(NOW) - SELLER_INBOUND_BURST_CLAIM_LEASE_MS
      ).toISOString()})`,
    ].join(",")
  );
});

test("supabase global scope: claim path unchanged — bare thread key still reaches the RPC", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow), rpc: sqlClaimRpc });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const claim = await store.claimEligible({ thread_key: THREAD, now: NOW, scope: GLOBAL_SCOPE });
  assert.equal(claim.ok, true);
  assert.equal(log.rpcs.length, 1);
  assert.equal(log.rpcs[0].params.p_thread_key, THREAD);
  assert.equal(log.rpcs[0].params.p_burst_id, null, "global mode does not pre-resolve — behaviour preserved");
  assert.deepEqual(log.selects, [], "global mode issues no extra pre-select round trip");
});

// ── 8. The two implementations may not drift ─────────────────────────────────

test("memory and supabase stores select the identical set for the identical fixtures and scope", async () => {
  const scopes = [PROOF_SCOPE, GLOBAL_SCOPE, CLOSED_SESSION_SCOPE, undefined];
  for (const scope of scopes) {
    const memory = seedMemoryStore();
    const { supabase } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow) });
    const remote = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

    const a = (await memory.listEligible({ now: NOW, limit: 20, scope })).map((b) => b.burst_id);
    const b = (await remote.listEligible({ now: NOW, limit: 20, scope })).map((x) => x.burst_id);
    assert.deepEqual(a, b, `store drift for scope=${JSON.stringify(scope)}`);
  }
});

// ── 9. The store's predicate may never outrun the policy's ───────────────────
//
// burst-flush-activation-policy.js declares isBurstWithinFlushScope "THE ONE
// RULE ... one export, three importers — do not reimplement it locally". The
// store cannot import it: policy → coordinator → store, so importing back would
// close a module cycle on the production path. The rule is therefore applied
// twice, and this is what stops the two copies from drifting.
//
// The invariant is ONE-DIRECTIONAL on purpose: the store may be stricter than
// the policy (that only ever refuses work), but it may never be looser (that
// admits a burst the policy denied). Equality is asserted for every realistic
// row shape; the one-way guarantee covers the rest.

test("store scope predicate never admits a burst the activation policy denies", () => {
  const resolved = resolveBurstScopeFilter(PROOF_SCOPE);

  const rows = [
    dbRow(PRESERVED),
    dbRow(PROOF),
    dbRow(OTHER),
    // Backdated insert: message time in-window, row inserted before the session.
    { ...dbRow(PROOF), created_at: PRESERVED.created_at || "2026-08-03T22:40:31.039Z" },
    // Insert after the session expired.
    { ...dbRow(PROOF), created_at: "2026-08-05T15:00:00.000Z" },
    // Message time after the session expired.
    { ...dbRow(PROOF), first_received_at: "2026-08-05T15:00:00.000Z" },
    // Message time exactly on each boundary — inclusive on both ends.
    { ...dbRow(PROOF), first_received_at: SESSION_START, created_at: SESSION_START },
    { ...dbRow(PROOF), first_received_at: SESSION_END, created_at: SESSION_END },
    // One millisecond outside each boundary.
    { ...dbRow(PROOF), first_received_at: "2026-08-05T09:59:59.999Z", created_at: SESSION_START },
    { ...dbRow(PROOF), first_received_at: "2026-08-05T14:00:00.001Z", created_at: SESSION_END },
    // Missing / unparseable durable facts.
    { ...dbRow(PROOF), created_at: null },
    { ...dbRow(PROOF), created_at: "" },
    { ...dbRow(PROOF), created_at: "not-a-date" },
    { ...dbRow(PROOF), first_received_at: null },
    { ...dbRow(PROOF), thread_key: "" },
  ];

  let agreed = 0;
  for (const row of rows) {
    const store_admits = matchesBurstScope(row, resolved);
    const policy_admits = isBurstWithinFlushScope({ burst: row, scope: POLICY_SCOPE });
    if (store_admits) {
      assert.equal(
        policy_admits,
        true,
        `store admitted a burst the policy denies: ${JSON.stringify({
          thread_key: row.thread_key,
          first_received_at: row.first_received_at,
          created_at: row.created_at,
        })}`
      );
    }
    if (store_admits === policy_admits) agreed += 1;
  }
  assert.equal(agreed, rows.length, "store and policy disagree on a realistic row shape");
});

test("store scope predicate agrees with the policy on global activation", () => {
  const resolved = resolveBurstScopeFilter(GLOBAL_SCOPE);
  const global_policy_scope = { kind: "global" };
  for (const row of ALL.map(dbRow)) {
    assert.equal(matchesBurstScope(row, resolved), true);
    assert.equal(isBurstWithinFlushScope({ burst: row, scope: global_policy_scope }), true);
  }
});

// ── 10. THE THIRD DOOR: append writes to the open row ────────────────────────
//
// appendMessage is not a read-only ingest. When the open generation is past its
// hard close the rollover branch force-writes `eligible_at` to whatever row is
// OPEN on that thread, and it does so BEFORE returning `rollover: true` — so no
// caller-side gate can come between the decision and the write, and a
// pre-check above this layer is a TOCTOU window with the mutation on the far
// side of it.
//
// The live path: proof session opens → operator texts the pinned internal
// number → webhook engages burst for exactly that thread → appendMessage →
// the one OPEN row on `+16128072000` is the preserved 2026-08-03 burst, 36h
// past hard_close_at → rollover → unconditional UPDATE on protected evidence.

/** Supabase double that treats ANY write to the burst table as a test failure. */
function makeNoWriteBurstSupabase({ rows = [] }) {
  const table = rows.map((r) => ({ ...r }));
  const log = { selects: [], writes: [] };
  const supabase = {
    from(table_name) {
      const calls = [{ op: "from", args: [table_name] }];
      const chain = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const p = Promise.resolve().then(() => {
                const write = calls.find((c) => ["update", "insert", "upsert", "delete"].includes(c.op));
                if (write) {
                  log.writes.push(write);
                  throw new Error(`FORBIDDEN_WRITE:${write.op}`);
                }
                log.selects.push(calls.slice());
                let out = applyFilters(calls, table, { now: NOW, lease_ms: SELLER_INBOUND_BURST_CLAIM_LEASE_MS });
                const single = calls.some((c) => c.op === "maybeSingle" || c.op === "single");
                return { data: single ? out[0] || null : out, error: null };
              });
              return p.then.bind(p);
            }
            if (typeof prop === "symbol") return undefined;
            return (...args) => {
              calls.push({ op: String(prop), args });
              return chain;
            };
          },
        }
      );
      return chain;
    },
  };
  return { supabase, log, table };
}

const PROOF_MESSAGE = Object.freeze({
  event_id: "evt-proof-inbound",
  provider_message_id: "SMI~proofinbound",
  body: "Yeah",
  received_at: "2026-08-05T10:30:00.000Z",
});

test("supabase append: a proof message CANNOT roll over the preserved burst — and writes nothing", async () => {
  // The preserved row is the one OPEN generation on the thread, and it is 36h
  // past its hard close, so this append projects to rollover.
  const { supabase, log } = makeNoWriteBurstSupabase({ rows: [dbRow(PRESERVED)] });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => "2026-08-05T10:30:00.000Z" });

  const result = await store.appendMessage({
    thread_key: THREAD,
    message: PROOF_MESSAGE,
    now: "2026-08-05T10:30:00.000Z",
    scope: PROOF_SCOPE,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "open_generation_out_of_scope");
  assert.equal(result.rollover, false, "refusal is not a rollover — no handoff is implied");
  assert.equal(result.burst, null, "the protected row is not returned to the caller");

  // The diagnostic names what is in the way, identifiers only.
  assert.equal(result.blocking_burst_id, PRESERVED.burst_id);
  assert.equal(result.blocking_generation, 1);
  assert.equal(result.blocking_first_received_at, "2026-08-03T22:40:31.039Z");

  assert.deepEqual(log.writes, [], "ZERO writes reached the burst table");
});

test("memory append: same refusal, same zero-write property, same diagnostic", async () => {
  const store = seedMemoryStore([PRESERVED]);
  // The preserved row must actually be the thread's OPEN generation.
  store._debug.openByThread.set(THREAD, PRESERVED.id);
  const before = JSON.stringify(store.getById(PRESERVED.id));

  const result = await store.appendMessage({
    thread_key: THREAD,
    message: PROOF_MESSAGE,
    now: "2026-08-05T10:30:00.000Z",
    scope: PROOF_SCOPE,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "open_generation_out_of_scope");
  assert.equal(result.rollover, false);
  assert.equal(result.burst, null);
  assert.equal(result.blocking_burst_id, PRESERVED.burst_id);
  assert.equal(
    JSON.stringify(store.getById(PRESERVED.id)),
    before,
    "the preserved row is byte-identical after the refused append"
  );
});

test("append: deny-by-default — no scope means no append, and no query", async () => {
  const { supabase, log } = makeNoWriteBurstSupabase({ rows: [dbRow(PRESERVED)] });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const result = await store.appendMessage({ thread_key: THREAD, message: PROOF_MESSAGE, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "burst_scope_required");
  assert.equal(result.burst, null);
  assert.deepEqual(log.selects, [], "an unauthorized append issues no query at all");
  assert.deepEqual(log.writes, []);
});

test("append: a thread outside scope may not open a NEW generation either", async () => {
  const { supabase, log } = makeNoWriteBurstSupabase({ rows: [] }); // no open row anywhere
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const result = await store.appendMessage({
    thread_key: OTHER_THREAD, // a real seller, not the proof thread
    message: PROOF_MESSAGE,
    now: NOW,
    scope: PROOF_SCOPE,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_out_of_scope");
  assert.deepEqual(log.selects, [], "refused before fetchOpen — no query");
  assert.deepEqual(log.writes, [], "no generation was inserted");
});

test("append thread predicate: global admits every thread, scoped admits only the allowlist", () => {
  const global_resolved = resolveBurstScopeFilter(GLOBAL_SCOPE);
  const scoped_resolved = resolveBurstScopeFilter(PROOF_SCOPE);
  assert.equal(matchesBurstScopeThread(OTHER_THREAD, global_resolved), true);
  assert.equal(matchesBurstScopeThread(THREAD, scoped_resolved), true);
  assert.equal(matchesBurstScopeThread(OTHER_THREAD, scoped_resolved), false);
  assert.equal(matchesBurstScopeThread("", scoped_resolved), false);
  assert.equal(matchesBurstScopeThread(THREAD, { deny: true, reason: "x" }), false);
});

test("append under GLOBAL scope: rollover behaviour is preserved exactly", async () => {
  // Same fixture, same 36h-stale open row — but enabled-mode activation. The
  // pre-existing contract must survive byte for byte: force-eligible write on
  // the old generation, then the flush_required handoff.
  const { supabase, log } = makeRecordingBurstSupabase({
    rows: [dbRow(PRESERVED)],
    now: "2026-08-05T10:30:00.000Z",
  });
  const store = createSupabaseSellerInboundBurstStore({
    supabase,
    now: () => "2026-08-05T10:30:00.000Z",
  });

  const result = await store.appendMessage({
    thread_key: THREAD,
    message: PROOF_MESSAGE,
    now: "2026-08-05T10:30:00.000Z",
    scope: GLOBAL_SCOPE,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "open_burst_past_hard_close_flush_required");
  assert.equal(result.rollover, true, "enabled mode still rolls over");
  assert.equal(result.burst.burst_id, PRESERVED.burst_id);
  assert.equal(log.updates.length, 1, "the force-eligible write still happens under global scope");
  assert.equal(log.updates[0].patch.eligible_at, "2026-08-05T10:30:00.000Z");
});

// ── 11. The insert-new door: the row we are ABOUT to write ───────────────────
//
// The thread allowlist alone is not the whole scope. An AUTHORIZED thread can
// still carry a message whose time falls outside the session window — provider
// clock skew, a replayed timestamp, or a message that simply arrives after the
// session expired. Inserting that row is not a harmless no-op:
//
//   * it is born OPEN and out-of-scope, so NOTHING can ever flush it — both
//     listEligible and claimEligible exclude it by the same predicate; and
//   * it becomes the thread's one OPEN generation, so it then trips the
//     out-of-scope guard for every subsequent message on that thread.
//
// One skewed timestamp would swallow its own message and wedge the proof thread
// behind a row that can never be worked. So the prospective row is tested with
// the same predicate that guards every other door, before it is written.

const LATE = "2026-08-05T16:00:00.000Z"; // after SESSION_END

test("append: an authorized thread with an out-of-window message inserts NOTHING", async () => {
  const store = createMemorySellerInboundBurstStore({ now: () => LATE });
  const result = await store.appendMessage({
    thread_key: THREAD, // in the allowlist
    message: { event_id: "e-late", provider_message_id: "p-late", body: "late", received_at: LATE },
    now: LATE,
    scope: PROOF_SCOPE,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    "message_outside_scope_window",
    "distinct from thread_out_of_scope: the thread IS authorized, the timestamp is not"
  );
  assert.equal(result.burst, null);
  assert.equal(store._debug.listAll().length, 0, "no orphan generation was opened");
});

test("append: the orphan row this prevents could never have been flushed", async () => {
  // Demonstrates the cost of the row we now refuse: seed exactly what the
  // unguarded insert would have produced and show it is unworkable.
  const orphan = {
    ...PROOF,
    id: "row-orphan",
    burst_id: "sib:+16128072000:g9:e-late",
    first_received_at: LATE,
    last_received_at: LATE,
    eligible_at: "2026-08-05T16:00:20.000Z",
  };
  const store = seedMemoryStore([orphan]);
  store._debug.openByThread.set(THREAD, orphan.id);

  const eligible = await store.listEligible({ now: "2026-08-05T16:01:00.000Z", scope: PROOF_SCOPE });
  assert.deepEqual(eligible, [], "unflushable: the same scope that admitted the write excludes the row");

  const claim = await store.claimEligible({ thread_key: THREAD, now: "2026-08-05T16:01:00.000Z", scope: PROOF_SCOPE });
  assert.equal(claim.ok, false, "unclaimable too");

  // And it wedges the thread: the next in-window message is refused because
  // this row is now the thread's out-of-scope OPEN generation.
  const next = await store.appendMessage({
    thread_key: THREAD,
    message: { event_id: "e-next", provider_message_id: "p-next", body: "hello", received_at: "2026-08-05T13:00:00.000Z" },
    now: "2026-08-05T13:00:00.000Z",
    scope: PROOF_SCOPE,
  });
  assert.equal(next.reason, "open_generation_out_of_scope", "the thread is wedged behind it");
  assert.equal(next.blocking_burst_id, orphan.burst_id);
});

test("append: a foreign thread is still refused before any query, and inserts nothing", async () => {
  const { supabase, log } = makeNoWriteBurstSupabase({ rows: [] });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });
  const result = await store.appendMessage({
    thread_key: OTHER_THREAD,
    message: { event_id: "e-seller", provider_message_id: "p-seller", body: "yeah I might sell", received_at: NOW },
    now: NOW,
    scope: PROOF_SCOPE,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "thread_out_of_scope");
  assert.deepEqual(log.selects, [], "no query");
  assert.deepEqual(log.writes, [], "no insert");
});

test("append under GLOBAL scope: a brand-new generation still opens normally", async () => {
  // The insert-new guard must not touch enabled mode: matchesBurstScope
  // short-circuits on a global activation, so no bounds are consulted.
  const store = createMemorySellerInboundBurstStore({ now: () => LATE });
  const result = await store.appendMessage({
    thread_key: OTHER_THREAD,
    message: { event_id: "e-ok", provider_message_id: "p-ok", body: "ordinary seller", received_at: LATE },
    now: LATE,
    scope: GLOBAL_SCOPE,
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.burst.generation, 1);
  assert.equal(store._debug.listAll().length, 1);
});

// ── 12. The three refusals are three distinct operator situations ────────────

test("the three append refusals are distinguishable, and none of them is a fallthrough", async () => {
  // 1. thread never authorized.
  const s1 = createMemorySellerInboundBurstStore({ now: () => "2026-08-05T11:00:00.000Z" });
  const foreign = await s1.appendMessage({
    thread_key: OTHER_THREAD,
    message: { event_id: "a", provider_message_id: "pa", body: "hi", received_at: "2026-08-05T11:00:00.000Z" },
    now: "2026-08-05T11:00:00.000Z",
    scope: PROOF_SCOPE,
  });
  assert.equal(foreign.reason, "thread_out_of_scope");

  // 2. authorized thread, message timestamp outside the session window.
  const s2 = createMemorySellerInboundBurstStore({ now: () => LATE });
  const late = await s2.appendMessage({
    thread_key: THREAD,
    message: { event_id: "b", provider_message_id: "pb", body: "hi", received_at: LATE },
    now: LATE,
    scope: PROOF_SCOPE,
  });
  assert.equal(late.reason, "message_outside_scope_window");

  // 3. authorized thread, in-window message, blocked by an out-of-scope OPEN row.
  const s3 = seedMemoryStore([PRESERVED]);
  s3._debug.openByThread.set(THREAD, PRESERVED.id);
  const blocked = await s3.appendMessage({
    thread_key: THREAD,
    message: { event_id: "c", provider_message_id: "pc", body: "hi", received_at: "2026-08-05T11:00:00.000Z" },
    now: "2026-08-05T11:00:00.000Z",
    scope: PROOF_SCOPE,
  });
  assert.equal(blocked.reason, "open_generation_out_of_scope");

  // Every refusal is ok:false and rollover:false — the shape the coordinator
  // matches on to declare `declined` rather than `deferred`. A refusal that
  // set rollover:true would re-enter the rollover loop instead of declining.
  for (const r of [foreign, late, blocked]) {
    assert.equal(r.ok, false);
    assert.equal(r.rollover, false);
    assert.equal(r.burst, null);
  }
  assert.equal(new Set([foreign.reason, late.reason, blocked.reason]).size, 3);
});

test("append: provider clock skew below the floor declines — nobody did anything wrong", async () => {
  // The realistic shape of this failure: TextGrid stamps a message 11:49:50,
  // the operator opened the session 11:50:00. The floor is the session's own
  // created_at with no grace, so the message sits 10 seconds below it. Without
  // this guard the row is created and stranded — unclaimable forever, and its
  // ledger rows park at awaiting_burst_finalization, which breach_count
  // excludes. Declining hands the message to the ordinary per-message path,
  // where it is answered.
  const SKEWED = "2026-08-05T09:59:50.000Z"; // 10s before SESSION_START
  const store = createMemorySellerInboundBurstStore({ now: () => "2026-08-05T10:00:05.000Z" });

  const result = await store.appendMessage({
    thread_key: THREAD,
    message: { event_id: "e-skew", provider_message_id: "p-skew", body: "hi", received_at: SKEWED },
    now: "2026-08-05T10:00:05.000Z",
    scope: PROOF_SCOPE,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "message_outside_scope_window");
  assert.equal(result.rollover, false, "must decline, never re-enter the rollover loop");
  assert.equal(store._debug.listAll().length, 0, "no row is stranded below the floor");
});

// ── 13. The thread filter must be IN the query, not after LIMIT ──────────────
//
// A caller that names a thread and then filters the returned page in JS gets a
// page selected by `eligible_at ASC LIMIT n` across ALL threads. Other threads'
// older bursts fill the page, the named thread's eligible burst never appears,
// and the targeted flush reports "no work" while work exists — quiet and wrong.
//
// Reachable in `enabled` mode specifically: the flush handler sets
// thread_key = policy.allowed_thread_key || requested_thread_key, and
// allowed_thread_key is null under global activation, so an operator POST
// supplies a thread key while the scope stays global. internal_proof is immune
// because its scope already bounds the list to one thread.

/** Two older bursts on other threads, plus the one the operator asked about. */
const CROWDING = [
  { ...OTHER, id: "crowd-1", burst_id: "sib:+15125550143:g1:c1", thread_key: "+15125550143",
    first_received_at: "2026-08-05T10:00:10.000Z", eligible_at: "2026-08-05T10:00:30.000Z" },
  { ...OTHER, id: "crowd-2", burst_id: "sib:+15125550199:g1:c2", thread_key: "+15125550199",
    first_received_at: "2026-08-05T10:00:20.000Z", eligible_at: "2026-08-05T10:00:40.000Z" },
  // The operator's thread — newest, so it sorts LAST under eligible_at ASC.
  { ...PROOF, id: "wanted", burst_id: "sib:+16128072000:g5:w1",
    first_received_at: "2026-08-05T10:01:00.000Z", eligible_at: "2026-08-05T10:01:20.000Z" },
];

test("global scope + thread_key: the named thread is NOT starved by older bursts on other threads", async () => {
  const store = seedMemoryStore(CROWDING);

  // The bug: without the thread filter, a limit-2 page is entirely other threads.
  const unfiltered = await store.listEligible({ now: NOW, limit: 2, scope: GLOBAL_SCOPE });
  assert.deepEqual(
    unfiltered.map((b) => b.thread_key),
    ["+15125550143", "+15125550199"],
    "precondition: eligible_at ASC fills the page with other threads"
  );
  assert.ok(
    !unfiltered.some((b) => b.thread_key === THREAD),
    "precondition: a JS post-filter on this page yields [] — the reported-no-work bug"
  );

  // The fix: the constraint is applied before the page is cut.
  const filtered = await store.listEligible({
    now: NOW, limit: 2, scope: GLOBAL_SCOPE, thread_key: THREAD,
  });
  assert.deepEqual(filtered.map((b) => b.burst_id), ["sib:+16128072000:g5:w1"]);
});

test("supabase: thread_key is applied in-query, and survives a limit of 1", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: CROWDING.map(dbRow) });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  const rows = await store.listEligible({
    now: NOW, limit: 1, scope: GLOBAL_SCOPE, thread_key: THREAD,
  });
  assert.deepEqual(rows.map((b) => b.burst_id), ["sib:+16128072000:g5:w1"]);

  const chain = log.selects[0];
  const eq = chain.find((c) => c.op === "eq" && c.args[0] === "thread_key");
  assert.ok(eq, "the thread constraint must reach the query");
  assert.deepEqual(eq.args, ["thread_key", THREAD]);
});

test("thread_key composes with scope by CONJUNCTION — it can never widen one", async () => {
  const store = seedMemoryStore(ALL);
  // A thread the scope never authorized, named explicitly by the caller.
  const outside = await store.listEligible({
    now: NOW, limit: 20, scope: PROOF_SCOPE, thread_key: OTHER_THREAD,
  });
  assert.deepEqual(outside, [], "naming a thread cannot escape the scope allowlist");

  // And the in-scope thread still resolves normally through both filters.
  const inside = await store.listEligible({
    now: NOW, limit: 20, scope: PROOF_SCOPE, thread_key: THREAD,
  });
  assert.deepEqual(inside.map((b) => b.burst_id), [PROOF.burst_id]);
});

test("thread_key absent or blank is no constraint at all — existing callers unaffected", async () => {
  const store = seedMemoryStore(CROWDING);
  const baseline = await store.listEligible({ now: NOW, limit: 20, scope: GLOBAL_SCOPE });
  for (const thread_key of [undefined, null, "", "   "]) {
    const same = await store.listEligible({ now: NOW, limit: 20, scope: GLOBAL_SCOPE, thread_key });
    assert.deepEqual(
      same.map((b) => b.burst_id),
      baseline.map((b) => b.burst_id),
      `thread_key=${JSON.stringify(thread_key)} must not constrain`
    );
  }
});

test("memory and supabase agree on the thread filter, including the starvation case", async () => {
  for (const thread_key of [THREAD, OTHER_THREAD, null]) {
    for (const limit of [1, 2, 20]) {
      const memory = seedMemoryStore(CROWDING);
      const { supabase } = makeRecordingBurstSupabase({ rows: CROWDING.map(dbRow) });
      const remote = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });
      const a = (await memory.listEligible({ now: NOW, limit, scope: GLOBAL_SCOPE, thread_key })).map((b) => b.burst_id);
      const b = (await remote.listEligible({ now: NOW, limit, scope: GLOBAL_SCOPE, thread_key })).map((x) => x.burst_id);
      assert.deepEqual(a, b, `drift at thread_key=${thread_key} limit=${limit}`);
    }
  }
});

test("thread constraint resolves to ONE predicate — never two on the same column", () => {
  const global_resolved = resolveBurstScopeFilter(GLOBAL_SCOPE);
  const scoped_resolved = resolveBurstScopeFilter(PROOF_SCOPE);

  // Global + a thread → a single equality.
  assert.deepEqual(resolveThreadConstraint(global_resolved, THREAD), {
    impossible: false, eq: THREAD, in: null,
  });
  // Global, no thread → no constraint at all.
  assert.deepEqual(resolveThreadConstraint(global_resolved, null), {
    impossible: false, eq: null, in: null,
  });
  // Scoped, no thread → the allowlist.
  assert.deepEqual(resolveThreadConstraint(scoped_resolved, null), {
    impossible: false, eq: null, in: [THREAD],
  });
  // Scoped + an allowed thread → the intersection is that thread. One equality,
  // NOT `in.(…)` plus `eq.…` left for PostgREST to conjoin.
  assert.deepEqual(resolveThreadConstraint(scoped_resolved, THREAD), {
    impossible: false, eq: THREAD, in: null,
  });
  // Scoped + a thread outside the allowlist → nothing can match.
  assert.equal(resolveThreadConstraint(scoped_resolved, OTHER_THREAD).impossible, true);
  assert.equal(resolveThreadConstraint({ deny: true, reason: "x" }, THREAD).impossible, true);
});

test("an out-of-scope thread costs ZERO queries on both doors", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow), rpc: sqlClaimRpc });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });

  assert.deepEqual(
    await store.listEligible({ now: NOW, scope: PROOF_SCOPE, thread_key: OTHER_THREAD }),
    []
  );
  const claim = await store.claimEligible({ now: NOW, scope: PROOF_SCOPE, thread_key: OTHER_THREAD });
  assert.equal(claim.ok, false);
  assert.equal(claim.reason, "no_eligible_burst");

  assert.deepEqual(log.selects, [], "no query");
  assert.deepEqual(log.rpcs, [], "no rpc");
  assert.deepEqual(log.updates, [], "no mutation");
});

test("scoped list emits the intersected equality, not a second thread predicate", async () => {
  const { supabase, log } = makeRecordingBurstSupabase({ rows: ALL.map(dbRow) });
  const store = createSupabaseSellerInboundBurstStore({ supabase, now: () => NOW });
  await store.listEligible({ now: NOW, scope: PROOF_SCOPE, thread_key: THREAD });

  const chain = log.selects[0];
  const thread_predicates = chain.filter(
    (c) => (c.op === "eq" || c.op === "in") && c.args[0] === "thread_key"
  );
  assert.equal(thread_predicates.length, 1, "exactly one predicate constrains thread_key");
  assert.deepEqual(thread_predicates[0].args, ["thread_key", THREAD]);
});
