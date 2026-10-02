import test from "node:test";
import assert from "node:assert/strict";

import { canonicalizeTransactions, pairDecision } from "../../src/lib/domain/intelligence/transactions/dedupe.js";
import { normalizeTransactionPrice } from "../../src/lib/domain/intelligence/transactions/price-taxonomy.js";

function rec(id, over = {}) {
  const r = { id, src: id.startsWith("P:") ? "pool" : "deeds", pid: "p1", parcel_key: null, addr_key: null, unit_designator: false, sale_date: "2026-03-10", deed_date: null, mls_date: null, market: "MSP", zip: "55412", lat: 45, lng: -93.3, ...over };
  const kind = r.kind ?? (r.src === "pool" ? (r.mls_date ? "pool_mls" : "pool_public_record") : "deed");
  r.price_norm = normalizeTransactionPrice({ kind, price: r.price ?? 300000, price_code: r.price_code ?? null, price_source: "recorded_full", state: r.state ?? "MN", source_record_id: id });
  return r;
}

test("the same sale seen in the pool (MLS) and the deeds collapses to one transaction with both provenance records", () => {
  const out = canonicalizeTransactions([
    rec("P:a", { mls_date: "2026-03-08", sale_date: "2026-03-08", price: 300000 }),
    rec("D:1", { sale_date: "2026-03-12", price: 300000, price_code: "Full amount stated on Document." }),
  ]);
  assert.equal(out.transactions.length, 1);
  const t = out.transactions[0];
  assert.equal(t.members.length, 2);
  assert.equal(t.price_record_id, "P:a", "MLS wins over a deed at equal confidence (explicit ladder, not recency)");
  assert.deepEqual(t.sources, ["deeds", "pool"]);
  assert.equal(out.stats.dedupe_rate, 0.5);
});

test("source priority is by quality, never latest-wins: a HIGH deed beats a later LOW vendor estimate", () => {
  const out = canonicalizeTransactions([
    rec("D:1", { state: "TX", sale_date: "2026-05-01", price: 250000, price_code: "Full amount stated on Document." }),
    rec("D:2", { src: "seller_sale", state: "TX", sale_date: "2026-05-03", price: 332500, price_code: "Estimated Sales Price" }),
  ]);
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0].price_record_id, "D:1");
  assert.equal(out.transactions[0].price.source, "DEED_CONSIDERATION");
});

test("a weak (estimated) price never blocks the identity match: a TX estimate and an MLS row on the same week merge", () => {
  const out = canonicalizeTransactions([
    rec("P:a", { state: "TX", mls_date: "2026-05-02", sale_date: "2026-05-02", price: 219000 }),
    rec("D:9", { state: "TX", sale_date: "2026-05-06", price: 327246, price_code: "Estimated Sales Price" }),
  ]);
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0].members.length, 2);
});

test("TRAP: repeat sales of the same property months apart are NOT duplicates", () => {
  const out = canonicalizeTransactions([
    rec("D:1", { sale_date: "2025-11-03", price: 120000 }),
    rec("D:2", { sale_date: "2026-04-20", price: 245000 }),
    rec("P:a", { mls_date: "2026-04-18", sale_date: "2026-04-18", price: 245000 }),
  ]);
  assert.equal(out.transactions.length, 2, "flip purchase and resale stay two transactions");
  assert.equal(out.ambiguous.length, 0);
});

test("TRAP: two reliable, different prices on the same parcel in the window are not merged (double close) and are reported", () => {
  const out = canonicalizeTransactions([
    rec("P:a", { sale_date: "2026-02-10", price: 100000 }),
    rec("D:1", { sale_date: "2026-02-10", price: 165000 }),
  ]);
  assert.equal(out.transactions.length, 2);
  assert.equal(out.ambiguous[0].kind, "reliable_price_conflict_in_window");
});

test("TRAP: same-source distinct provider transactions on one parcel stay distinct; an exact redelivery merges", () => {
  const distinct = canonicalizeTransactions([
    rec("D:1", { provider_txn_id: "x1", sale_date: "2026-02-10", price: 100000 }),
    rec("D:2", { provider_txn_id: "x2", sale_date: "2026-02-10", price: 165000 }),
  ]);
  assert.equal(distinct.transactions.length, 2);
  assert.equal(distinct.ambiguous[0].kind, "same_source_distinct_txn_in_window");
  const redelivered = canonicalizeTransactions([
    rec("D:1", { sale_date: "2026-02-10", price: 100000 }),
    rec("D:2", { sale_date: "2026-02-10", price: 100000 }),
  ]);
  assert.equal(redelivered.transactions.length, 1);
});

test("TRAP: portfolio/package deeds stay one transaction per parcel and are flagged package_n", () => {
  const out = canonicalizeTransactions([
    rec("D:1", { pid: "a", sale_date: "2026-01-15", price: 1200000 }),
    rec("D:2", { pid: "b", sale_date: "2026-01-15", price: 1200000 }),
    rec("D:3", { pid: "c", sale_date: "2026-01-15", price: 1200000 }),
    rec("D:4", { pid: "d", sale_date: "2026-01-16", price: 310000 }),
  ]);
  assert.equal(out.transactions.length, 4);
  assert.deepEqual(out.transactions.map((t) => t.package_n), [3, 3, 3, 0]);
  assert.deepEqual(out.stats.packages, { clusters: 1, members: 3 });
});

test("date drift: 11-45 days merges only on an identical reliable price, otherwise ambiguous", () => {
  const exact = canonicalizeTransactions([rec("P:a", { mls_date: "2026-03-01", sale_date: "2026-03-01", price: 280000 }), rec("D:1", { sale_date: "2026-03-25", price: 280000 })]);
  assert.equal(exact.transactions.length, 1);
  assert.ok(exact.transactions[0].merge_basis[0].endsWith("date_drift_exact_price"));
  const drift = canonicalizeTransactions([rec("P:a", { mls_date: "2026-03-01", sale_date: "2026-03-01", price: 280000 }), rec("D:1", { sale_date: "2026-03-25", price: 291000 })]);
  assert.equal(drift.transactions.length, 2);
  assert.equal(drift.ambiguous[0].kind, "date_drift_within_45d");
});

test("different parcels and unit addresses never merge; a transitive chain cannot join two conflicting records", () => {
  assert.equal(pairDecision(rec("D:1", { pid: "a" }), rec("D:2", { pid: "b" })).merge, false);
  const units = pairDecision(rec("D:1", { pid: null, addr_key: "k", unit_designator: true }), rec("P:a", { pid: null, addr_key: "k", unit_designator: true }));
  assert.equal(units.merge, false);
  const out = canonicalizeTransactions([
    rec("P:a", { sale_date: "2026-02-10", price: 100000 }),
    rec("D:1", { sale_date: "2026-02-10", price: 165000 }),
    rec("D:2", { src: "seller_sale", sale_date: "2026-02-11", price: 200000, price_code: "Estimated Sales Price", state: "MN" }),
  ]);
  // D:2 (weak price) may join either side but never both: P:a and D:1 conflict.
  assert.equal(out.transactions.length, 2);
  assert.ok(out.ambiguous.some((a) => a.kind === "transitive_merge_refused" || a.kind === "reliable_price_conflict_in_window"));
});

test("dedupe is deterministic and input-order independent", () => {
  const rows = [
    rec("P:a", { mls_date: "2026-03-08", sale_date: "2026-03-08" }),
    rec("D:1", { sale_date: "2026-03-12" }),
    rec("D:5", { pid: "z", sale_date: "2026-01-01" }),
  ];
  const a = canonicalizeTransactions(rows);
  const b = canonicalizeTransactions([...rows].reverse());
  assert.deepEqual(a.transactions, b.transactions);
  assert.deepEqual(a.stats, b.stats);
});

test("TRAP: identical ROUND prices on one day in different ZIPs are coincidences, not a package", () => {
  const out = canonicalizeTransactions([
    rec("D:1", { pid: "a", zip: "32209", lat: 30.35, lng: -81.70, sale_date: "2026-01-15", price: 250000 }),
    rec("D:2", { pid: "b", zip: "32257", lat: 30.20, lng: -81.60, sale_date: "2026-01-15", price: 250000 }),
    rec("D:3", { pid: "c", zip: "32210", lat: 30.26, lng: -81.75, sale_date: "2026-01-15", price: 250000 }),
  ]);
  assert.deepEqual(out.transactions.map((t) => t.package_n), [0, 0, 0]);
  const odd = canonicalizeTransactions([
    rec("D:1", { pid: "a", zip: "32209", lat: 30.35, lng: -81.70, sale_date: "2026-01-15", price: 1234567 }),
    rec("D:2", { pid: "b", zip: "32257", lat: 30.20, lng: -81.60, sale_date: "2026-01-15", price: 1234567 }),
    rec("D:3", { pid: "c", zip: "32210", lat: 30.26, lng: -81.75, sale_date: "2026-01-15", price: 1234567 }),
  ]);
  assert.deepEqual(odd.transactions.map((t) => t.package_n), [3, 3, 3], "a non-round shared consideration across 3 parcels is a portfolio deed");
});
