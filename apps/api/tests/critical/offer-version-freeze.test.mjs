import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  persistActiveOffer,
  loadActiveOffer,
  OFFER_STATUS,
  buildOfferId,
} from "@/lib/domain/seller-flow/seller-offer-authority.js";

// OFFER-VERSION FREEZE INVARIANT
//
//   fresh ADE snapshot -> seller_offer version
//
// Once that offer version exists, neither the passage of time nor a fresh ADE
// recomputation may mutate its purchase price, ADE snapshot id, authorized
// ceiling, margins or policy version. A materially new valuation may only reach
// the seller through a NEW version created by the canonical path.
//
// This matters because the canary's own economics demonstrably drift: the same
// code produced valuation mid $295,900 at 23:03 and 23:11 on 2026-08-31 and
// $288,700 at 00:44 on 2026-09-01, because one comp rotated out of the
// recency-weighted top 12 across the UTC date boundary. An offer already made to
// a seller must not silently follow that drift.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100000";

// Minimal in-memory seller_offers table with the real one-active semantics.
function makeSupabase() {
  const offers = [];
  const opportunities = [{ id: OPP, active_offer_id: null }];
  const api = {
    _state: { offers, opportunities },
    from(table) {
      const ctx = { table, filters: {}, _payload: null, _op: null };
      const self = {
        select() {
          ctx._op = ctx._op ?? "select";
          return self;
        },
        insert(row) {
          ctx._op = "insert";
          ctx._payload = row;
          return self;
        },
        update(patch) {
          ctx._op = "update";
          ctx._payload = patch;
          return self;
        },
        eq(col, val) {
          ctx.filters[col] = val;
          return self;
        },
        order() {
          return self;
        },
        limit() {
          return self;
        },
        maybeSingle() {
          return run().then((res) => ({
            data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data,
            error: res.error,
          }));
        },
        single() {
          return run().then((res) => ({
            data: Array.isArray(res.data) ? (res.data[0] ?? null) : res.data,
            error: res.error,
          }));
        },
        then(resolve, reject) {
          return run().then(resolve, reject);
        },
      };
      async function run() {
        const rows = ctx.table === "seller_offers" ? offers : opportunities;
        if (ctx._op === "insert") {
          const row = { ...ctx._payload };
          rows.push(row);
          return { data: row, error: null };
        }
        if (ctx._op === "update") {
          for (const r of rows) {
            const match = Object.entries(ctx.filters).every(([k, v]) => r[k] === v);
            if (match) Object.assign(r, ctx._payload);
          }
          return { data: null, error: null };
        }
        const matched = rows.filter((r) =>
          Object.entries(ctx.filters).every(([k, v]) => r[k] === v)
        );
        const sorted = [...matched].sort((a, b) => (b.offer_version ?? 0) - (a.offer_version ?? 0));
        return { data: sorted, error: null };
      }
      return self;
    },
  };
  return api;
}

// Two DIFFERENT ADE runs, as the real engine genuinely produced.
const RUN_A = Object.freeze({
  snapshot_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  valuation_mid: 295900,
  ceiling: 159800,
  recommended: 142400,
  margin: {
    policy_version: "assignment_margin_v1",
    minimum_margin: 15000,
    target_margin: 15983,
    protected_margin: 15000,
    max_available_margin: 47940,
    margin_pct: 0.1,
  },
});
const RUN_B = Object.freeze({
  snapshot_id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  valuation_mid: 288700,
  ceiling: 154800,
  recommended: 137900,
  margin: {
    policy_version: "assignment_margin_v1",
    minimum_margin: 15000,
    target_margin: 15479,
    protected_margin: 15000,
    max_available_margin: 46440,
    margin_pct: 0.1,
  },
});

const offerArgs = (run) => ({
  opportunity_id: OPP,
  property_id: "canaryprop_offerauth_v2_75060",
  thread_key: THREAD,
  purchase_price: run.recommended,
  offer_type: "initial_offer",
  ade_snapshot_id: run.snapshot_id,
  recommended_offer: run.recommended,
  authorized_ceiling: run.ceiling,
  valuation_mid: run.valuation_mid,
  metadata: {
    margin_policy_version: run.margin.policy_version,
    minimum_margin: run.margin.minimum_margin,
    target_margin: run.margin.target_margin,
    protected_margin: run.margin.protected_margin,
    max_available_margin: run.margin.max_available_margin,
    margin_pct: run.margin.margin_pct,
  },
});

// ── a fresh ADE snapshot produces a bound offer version ─────────────────────

test("FREEZE: a fresh ADE snapshot binds its identity onto the offer version", async () => {
  const supabase = makeSupabase();
  const r = await persistActiveOffer({ ...offerArgs(RUN_A), supabase });
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.offer_version, 1);
  assert.equal(r.offer_id, buildOfferId(OPP, 1));

  const row = supabase._state.offers[0];
  assert.equal(row.purchase_price, RUN_A.recommended, "price frozen");
  assert.equal(row.ade_snapshot_id, RUN_A.snapshot_id, "ADE snapshot id frozen");
  assert.equal(row.authorized_ceiling, RUN_A.ceiling, "ceiling frozen");
  assert.equal(row.valuation_mid, RUN_A.valuation_mid, "valuation frozen");
  assert.equal(row.metadata.minimum_margin, RUN_A.margin.minimum_margin);
  assert.equal(row.metadata.target_margin, RUN_A.margin.target_margin);
  assert.equal(row.metadata.protected_margin, RUN_A.margin.protected_margin);
  assert.equal(row.metadata.margin_policy_version, "assignment_margin_v1");
  assert.ok(row.policy_version, "seller-offer policy version frozen");
  assert.ok(row.terms_hash, "terms hash frozen");
  assert.equal(row.status, OFFER_STATUS.ACTIVE);
});

test("FREEZE: the ADE snapshot id is never null on a persisted offer", async () => {
  // Regression: the executor previously omitted ade_snapshot_id entirely, so an
  // offer could not prove which valuation produced it.
  const supabase = makeSupabase();
  await persistActiveOffer({ ...offerArgs(RUN_A), supabase });
  assert.ok(supabase._state.offers[0].ade_snapshot_id, "offer must bind an ADE run");
});

// ── a later ADE run cannot mutate the existing version ──────────────────────

test("FREEZE: a fresh ADE recomputation does NOT mutate the existing offer", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer({ ...offerArgs(RUN_A), supabase });
  const before = { ...supabase._state.offers[0] };

  // Materially different valuation arrives (the real drift we measured).
  await persistActiveOffer({ ...offerArgs(RUN_B), supabase });

  const v1 = supabase._state.offers.find((o) => o.offer_version === 1);
  assert.equal(v1.purchase_price, before.purchase_price, "price unchanged");
  assert.equal(v1.ade_snapshot_id, RUN_A.snapshot_id, "snapshot id unchanged");
  assert.equal(v1.authorized_ceiling, before.authorized_ceiling, "ceiling unchanged");
  assert.equal(v1.valuation_mid, before.valuation_mid, "valuation unchanged");
  assert.deepEqual(v1.metadata, before.metadata, "margins and policy version unchanged");
  assert.equal(v1.terms_hash, before.terms_hash, "terms hash unchanged");
});

test("FREEZE: a new valuation reaches the seller only as a NEW version", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer({ ...offerArgs(RUN_A), supabase });
  const second = await persistActiveOffer({ ...offerArgs(RUN_B), supabase });

  assert.equal(second.offer_version, 2, "monotonic version, not an in-place edit");
  assert.equal(supabase._state.offers.length, 2, "history preserved, nothing overwritten");

  const v1 = supabase._state.offers.find((o) => o.offer_version === 1);
  const v2 = supabase._state.offers.find((o) => o.offer_version === 2);
  assert.equal(v1.status, OFFER_STATUS.SUPERSEDED, "prior version superseded, not deleted");
  assert.equal(v1.superseded_by_offer_id, v2.offer_id, "supersession is explicit lineage");
  assert.equal(v2.status, OFFER_STATUS.ACTIVE);
  assert.equal(v2.purchase_price, RUN_B.recommended);
  assert.equal(v2.ade_snapshot_id, RUN_B.snapshot_id);
  assert.notEqual(v1.ade_snapshot_id, v2.ade_snapshot_id, "each version binds its own ADE run");
  assert.notEqual(v1.terms_hash, v2.terms_hash, "different economics => different terms hash");
});

test("FREEZE: only one ACTIVE offer exists after revaluation", async () => {
  const supabase = makeSupabase();
  await persistActiveOffer({ ...offerArgs(RUN_A), supabase });
  await persistActiveOffer({ ...offerArgs(RUN_B), supabase });
  const active = supabase._state.offers.filter((o) => o.status === OFFER_STATUS.ACTIVE);
  assert.equal(active.length, 1);
  const loaded = await loadActiveOffer({ opportunity_id: OPP, supabase });
  assert.equal(loaded?.offer_version, 2, "the active offer is the newest version");
});

test("FREEZE: repeated identical recomputation still never edits version 1", async () => {
  // Time passing / the scorer running again on unchanged evidence must not
  // touch an existing version, even when the numbers are identical.
  const supabase = makeSupabase();
  await persistActiveOffer({ ...offerArgs(RUN_A), supabase });
  const snapshot = JSON.stringify(supabase._state.offers[0]);

  await persistActiveOffer({ ...offerArgs(RUN_A), supabase });

  const v1 = supabase._state.offers.find((o) => o.offer_version === 1);
  const { status, superseded_at, superseded_by_offer_id, ...frozenV1 } = v1;
  const original = JSON.parse(snapshot);
  const { status: s0, superseded_at: sa0, superseded_by_offer_id: sb0, ...frozenOriginal } = original;
  assert.deepEqual(frozenV1, frozenOriginal, "only supersession status may change on version 1");
});

test("FREEZE: an offer cannot be created without a price (no silent zero)", async () => {
  const supabase = makeSupabase();
  const r = await persistActiveOffer({ ...offerArgs(RUN_A), purchase_price: null, supabase });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing_offer_price");
  assert.equal(supabase._state.offers.length, 0);
});
