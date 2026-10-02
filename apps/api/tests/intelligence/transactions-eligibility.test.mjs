import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTransactionPrice } from "../../src/lib/domain/intelligence/transactions/price-taxonomy.js";
import { canonicalSalePrice, isEligiblePricedSale } from "../../src/lib/domain/intelligence/transactions/eligibility.js";
import { LABEL_WEIGHTS, priceDiagnosticOf } from "../../src/lib/domain/intelligence/transactions/price-diagnostics.js";
import { canonicalizeTransactions } from "../../src/lib/domain/intelligence/transactions/dedupe.js";

const txn = (priceRecord, over = {}) => ({ price: normalizeTransactionPrice(priceRecord), package_n: 0, doc_type: "Warranty Deed", arms_length: null, nominal_flag: false, usable: true, price_conflict: false, ...over });

test("THE rule: eligible iff the canonical deduped price is > 0; 0 and NULL are not", () => {
  assert.equal(isEligiblePricedSale(txn({ price: 300000, price_code: null, state: "FL" })), true);
  assert.equal(isEligiblePricedSale(txn({ price: 0, state: "FL" })), false);
  assert.equal(isEligiblePricedSale(txn({ price: null, state: "TX" })), false);
  assert.equal(isEligiblePricedSale({ sale_price: 125000 }), true);
  assert.equal(isEligiblePricedSale({ price: 1 }), true, "a recorded price > 0 is used as-is");
  assert.equal(isEligiblePricedSale(null), false);
  assert.equal(canonicalSalePrice({ price: { transaction_price: 5 } }), 5);
});

test("confidence never excludes: TX vendor estimates, IN/MO uncoded, LOW, placeholder and non-market prices > 0 are all eligible", () => {
  const cases = [
    { price: 327246, price_code: "Estimated Sales Price", state: "TX", concurrent_loan_amount: 246050 },
    { price: 187346, price_code: null, price_source: "recorded_full", state: "IN" },
    { price: 187346, price_code: null, price_source: "recorded_full", state: "MO" },
    { price: 196000, price_code: "Full amount stated on Document.", state: "TX", concurrent_loan_amount: 196000 },
    { kind: "pool_public_record", price: 500, state: "MO" },
    { price: 7468, price_code: "Sold for Taxes.", state: "FL" },
    { price: 100000, price_code: "Some new vendor code", state: "CA" },
  ];
  for (const c of cases) {
    const t = txn(c);
    assert.equal(isEligiblePricedSale(t), true, JSON.stringify(c));
    const d = priceDiagnosticOf(t);
    assert.equal(d.eligible, true);
    assert.notEqual(d.diagnostic_class, "no_price");
    assert.ok(d.label_weight > 0, "a positive price is never weighted to zero");
  }
  for (const over of [{ package_n: 3 }, { doc_type: "Trustee’s Deed" }, { arms_length: false }, { nominal_flag: true }]) {
    assert.equal(isEligiblePricedSale(txn({ price: 300000, price_code: null, state: "FL" }, over)), true, JSON.stringify(over));
  }
});

test("diagnostics describe, never gate", () => {
  const high = priceDiagnosticOf(txn({ price: 300000, price_code: null, state: "FL" }));
  assert.deepEqual([high.diagnostic_class, high.diagnostic_strict, high.label_weight], ["reliable_actual", true, 1]);
  const medium = priceDiagnosticOf(txn({ price: 285000, price_code: "Sales price from Transfer Tax.", state: "MN" }));
  assert.deepEqual([medium.diagnostic_class, medium.diagnostic_strict, medium.label_weight], ["reliable_actual", false, LABEL_WEIGHTS.MEDIUM]);
  const tx = priceDiagnosticOf(txn({ price: 327246, price_code: "Estimated Sales Price", state: "TX" }));
  assert.equal(tx.diagnostic_class, "weak_price");
  assert.ok(tx.diagnostic_reasons.includes("price_estimated"));
  const pkg = priceDiagnosticOf(txn({ price: 300000, price_code: null, state: "FL" }, { package_n: 3 }));
  assert.equal(pkg.diagnostic_class, "market_context");
  assert.ok(pkg.diagnostic_reasons.includes("package_deed"));
  assert.equal(priceDiagnosticOf(txn({ price: null, state: "TX" })).diagnostic_class, "no_price");
});

test("dedupe: the canonical price is positive whenever any observation has a positive price", () => {
  const rec = (id, over) => {
    const r = { id, src: id.startsWith("P:") ? "pool" : "deeds", pid: "p1", sale_date: "2026-03-10", market: "HOU", ...over };
    r.price_norm = normalizeTransactionPrice({ kind: r.kind ?? "deed", price: r.price, price_code: r.price_code ?? null, state: "TX" });
    return r;
  };
  const out = canonicalizeTransactions([rec("D:1", { price: null }), rec("P:a", { kind: "pool_public_record", price: 400 })]);
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0].price.transaction_price, 400);
  assert.equal(isEligiblePricedSale(out.transactions[0]), true);
});
