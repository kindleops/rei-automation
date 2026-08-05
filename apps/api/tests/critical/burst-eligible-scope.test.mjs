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
  assert.equal(resolveBurstScopeFilter(undefined).reason, "burst_scope_absent");
  assert.equal(resolveBurstScopeFilter(null).reason, "burst_scope_absent");
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
  assert.equal(claim.reason, "burst_scope_absent");
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
  assert.equal(absent.reason, "burst_scope_absent");
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
    assert.ok(
      chain.some((c) => c.op === "in" && c.args[0] === "thread_key"),
      "every select on the claim path carries the scope"
    );
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
