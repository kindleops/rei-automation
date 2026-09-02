import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  persistActiveOffer,
  recordSellerCounter,
  loadActiveOffer,
  OFFER_STATUS,
} from "@/lib/domain/seller-flow/seller-offer-authority.js";

// OFFER VERSION-CHURN PREVENTION (supersprint §9).
//   A fresh computation with economically + contractually IDENTICAL terms must
//   REUSE the active version, not mint a new seller-visible one. A real term
//   change (price, closing window, EMD) still produces a new immutable version
//   with explicit supersession. A seller counter is never conflated with our
//   own proposal.

const OPP = "11111111-1111-4111-8111-111111111111";
const THREAD = "+15550100999";

function makeSupabase() {
  const state = { offers: [], opportunities: [{ id: OPP }] };
  function from(name) {
    const q = { f: {}, order: null };
    const api = {
      select: () => api,
      eq(c, v) { q.f[c] = v; return api; },
      order(c, o) { q.order = { c, asc: o?.ascending !== false }; return api; },
      limit: async () => ({ data: rows(), error: null }),
      async maybeSingle() { return { data: rows()[0] || null, error: null }; },
      insert(row) {
        if (name === "seller_offers") {
          if (row.status === OFFER_STATUS.ACTIVE && state.offers.some((o) => o.opportunity_id === row.opportunity_id && o.status === OFFER_STATUS.ACTIVE))
            return sel({ error: { code: "23505", message: "one active" } });
          const created = { created_at: "2026-08-01T00:00:00.000Z", ...row };
          state.offers.push(created);
          return sel({ data: created });
        }
        return Promise.resolve({ error: null });
      },
      update(patch) {
        const u = {
          _f: {},
          eq(c, v) { this._f[c] = v; return this; },
          select() { return this; },
          async maybeSingle() { return { data: apply(this._f)[0] || null, error: null }; },
          then(res) { apply(this._f); return Promise.resolve({ error: null }).then(res); },
        };
        function apply(f) {
          const src = name === "seller_offers" ? state.offers : state.opportunities;
          const hits = src.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v));
          hits.forEach((r) => Object.assign(r, patch));
          return hits;
        }
        return u;
      },
    };
    function sel({ data = null, error = null }) {
      return { select: () => ({ maybeSingle: async () => ({ data, error }) }) };
    }
    function rows() {
      const src = name === "seller_offers" ? state.offers : state.opportunities;
      let out = src.filter((r) => Object.entries(q.f).every(([k, v]) => r[k] === v));
      if (q.order) out = [...out].sort((a, b) => (q.order.asc ? 1 : -1) * ((a[q.order.c] ?? 0) - (b[q.order.c] ?? 0)));
      return out;
    }
    return api;
  }
  return { from, _state: state };
}

const offer = (supabase, over = {}) =>
  persistActiveOffer({
    opportunity_id: OPP, thread_key: THREAD, property_id: "prop-1",
    purchase_price: 250000, offer_type: "initial_offer", supabase, ...over,
  });

// ── identical terms -> reuse, no churn ───────────────────────────────────────

test("a re-persist with IDENTICAL terms reuses the active version (no new row)", async () => {
  const supabase = makeSupabase();
  const first = await offer(supabase);
  assert.equal(first.ok, true);
  assert.equal(first.offer_version, 1);
  assert.notEqual(first.reused, true);

  const second = await offer(supabase, { recommended_offer: 240000, ade_snapshot_id: "ade:rerun:2" });
  assert.equal(second.ok, true);
  assert.equal(second.reused, true, "identical terms must reuse, not churn");
  assert.equal(second.offer_version, 1, "same version");
  assert.equal(second.offer_id, first.offer_id);
  assert.equal(supabase._state.offers.length, 1, "no second row was written");
  assert.equal(supabase._state.offers[0].status, OFFER_STATUS.ACTIVE, "still active, not superseded");
});

test("a fresh valuation ALONE (same terms) does not create a seller-visible version", async () => {
  const supabase = makeSupabase();
  await offer(supabase, { valuation_mid: 300000, ade_snapshot_id: "ade:v1" });
  const rerun = await offer(supabase, { valuation_mid: 285000, ade_snapshot_id: "ade:v2" });
  assert.equal(rerun.reused, true);
  assert.equal(supabase._state.offers.length, 1);
});

// ── real term change -> new version with supersession ────────────────────────

test("a changed PRICE creates a new version and supersedes the prior one", async () => {
  const supabase = makeSupabase();
  const v1 = await offer(supabase);
  const v2 = await offer(supabase, { purchase_price: 260000, offer_type: "counter_offer" });
  assert.notEqual(v2.reused, true);
  assert.equal(v2.offer_version, 2);
  assert.equal(supabase._state.offers.length, 2);
  assert.equal(supabase._state.offers.find((o) => o.offer_version === 1).status, OFFER_STATUS.SUPERSEDED);
  assert.equal(supabase._state.offers.find((o) => o.offer_version === 2).status, OFFER_STATUS.ACTIVE);
});

test("a changed CLOSING WINDOW creates a new version (terms differ, hash differs)", async () => {
  const supabase = makeSupabase();
  await offer(supabase);
  const v2 = await offer(supabase, { closing_window_days: 30, offer_type: "counter_offer" });
  assert.notEqual(v2.reused, true);
  assert.equal(v2.offer_version, 2);
  assert.equal(supabase._state.offers.length, 2);
});

// ── a seller counter is never conflated with our proposal ────────────────────

test("a seller counter at a different price is a new inbound version, never a reuse", async () => {
  const supabase = makeSupabase();
  await offer(supabase);
  const counter = await recordSellerCounter({
    opportunity_id: OPP, thread_key: THREAD, counter_price: 265000, supabase,
  });
  assert.notEqual(counter.reused, true);
  assert.equal(counter.offer_version, 2);
  assert.equal(supabase._state.offers.find((o) => o.offer_version === 2).direction, "inbound");
});

// ── reuse preserves history integrity ────────────────────────────────────────

test("reuse never supersedes or mutates the active offer's terms_hash", async () => {
  const supabase = makeSupabase();
  const first = await offer(supabase);
  const before = supabase._state.offers[0].terms_hash;
  await offer(supabase);
  const activeAfter = await loadActiveOffer({ opportunity_id: OPP, supabase });
  assert.equal(activeAfter.offer_id, first.offer_id);
  assert.equal(activeAfter.terms_hash, before, "the active terms hash is unchanged");
  assert.equal(activeAfter.superseded_at ?? null, null, "reuse never supersedes");
});
