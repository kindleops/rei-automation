import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTransactionPrice } from "../../src/lib/domain/intelligence/transactions/price-taxonomy.js";
import { LABEL_WEIGHTS, truthSetOf } from "../../src/lib/domain/intelligence/transactions/truth-sets.js";

const txn = (priceRecord, over = {}) => ({ price: normalizeTransactionPrice(priceRecord), package_n: 0, doc_type: "Warranty Deed", arms_length: null, nominal_flag: false, usable: true, price_conflict: false, ...over });

test("a HIGH recorded market sale is primary_strict; a MEDIUM transfer-tax price is primary but not strict", () => {
  const high = truthSetOf(txn({ price: 300000, price_code: null, state: "FL" }));
  assert.deepEqual([high.truth_set, high.primary_strict, high.label_weight], ["primary", true, 1]);
  const medium = truthSetOf(txn({ price: 285000, price_code: "Sales price from Transfer Tax.", state: "MN" }));
  assert.deepEqual([medium.truth_set, medium.primary_strict, medium.label_weight], ["primary", false, LABEL_WEIGHTS.MEDIUM]);
});

test("Texas vendor estimates and IN/MO uncoded prices are secondary (weak labels), never primary", () => {
  const tx = truthSetOf(txn({ price: 327246, price_code: "Estimated Sales Price", state: "TX", concurrent_loan_amount: 246050 }));
  assert.equal(tx.truth_set, "secondary");
  assert.ok(tx.reasons.includes("price_estimated"));
  assert.equal(tx.label_weight, LABEL_WEIGHTS.LOW);
  const ind = truthSetOf(txn({ price: 187346, price_code: null, price_source: "recorded_full", state: "IN" }));
  assert.equal(ind.truth_set, "secondary");
  const txStated = truthSetOf(txn({ price: 196000, price_code: "Full amount stated on Document.", state: "TX" }));
  assert.equal(txStated.truth_set, "secondary", "unverified stated amount in a non-disclosure state");
});

test("packages, distress deeds, non-market amounts, nominal and unpriced transactions are excluded from valuation truth", () => {
  const base = { price: 300000, price_code: null, state: "FL" };
  assert.ok(truthSetOf(txn(base, { package_n: 3 })).reasons.includes("package_deed"));
  assert.ok(truthSetOf(txn(base, { doc_type: "Trustee’s Deed" })).reasons.includes("distress_or_transfer_deed"));
  assert.ok(truthSetOf(txn(base, { arms_length: false })).reasons.includes("not_arms_length"));
  assert.ok(truthSetOf(txn(base, { nominal_flag: true })).reasons.includes("nominal_price"));
  assert.ok(truthSetOf(txn({ price: 7468, price_code: "Sold for Taxes.", state: "FL" })).reasons.includes("non_market_amount"));
  assert.equal(truthSetOf(txn({ price: null, state: "TX" })).truth_set, "excluded");
  assert.equal(truthSetOf(txn({ price: 300000, price_code: null, state: "FL" }, { price_conflict: true })).truth_set, "secondary");
});
