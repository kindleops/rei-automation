import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIDENCE,
  PRICE_CODE_MAP,
  PRICE_SOURCES,
  SOURCE_PRIORITY,
  isLoanDerived,
  isReliablePrice,
  jurisdictionClass,
  normalizeTransactionPrice,
} from "../../src/lib/domain/intelligence/transactions/price-taxonomy.js";

const OUTPUT_KEYS = ["transaction_price", "source", "confidence", "verified", "is_estimated", "source_record_id", "source_provider", "source_observed_at"];

test("output contract carries every brief field plus reasons", () => {
  const n = normalizeTransactionPrice({ kind: "deed", price: 250000, price_code: "Full amount stated on Document.", state: "MN", source_record_id: "D:1", source_provider: "p", source_observed_at: "2026-08-08" });
  for (const k of OUTPUT_KEYS) assert.ok(k in n, k);
  assert.equal(n.source_record_id, "D:1");
  assert.ok(Array.isArray(n.reasons));
});

test("disclosure-state recorded deed price is HIGH and verified", () => {
  const stated = normalizeTransactionPrice({ price: 250000, price_code: "Full amount stated on Document.", state: "MN" });
  assert.equal(stated.source, PRICE_SOURCES.DEED_CONSIDERATION);
  assert.equal(stated.confidence, CONFIDENCE.HIGH);
  assert.equal(stated.verified, true);
  assert.equal(stated.is_estimated, false);
  const uncoded = normalizeTransactionPrice({ price: 385000, price_code: null, price_source: "recorded_full", state: "FL" });
  assert.equal(uncoded.source, PRICE_SOURCES.RECORDED_PUBLIC);
  assert.equal(uncoded.confidence, CONFIDENCE.HIGH);
});

test("Texas vendor 'Estimated Sales Price' is a LOW estimate and the loan back-calculation is recognised", () => {
  const n = normalizeTransactionPrice({ price: 332500, price_code: "Estimated Sales Price", state: "TX", concurrent_loan_amount: 250000 });
  assert.equal(n.source, PRICE_SOURCES.VENDOR_ESTIMATE);
  assert.equal(n.confidence, CONFIDENCE.LOW);
  assert.equal(n.is_estimated, true);
  assert.equal(n.verified, false);
  assert.ok(n.reasons.includes("LOAN_DERIVED_ESTIMATE"));
  assert.equal(n.transaction_price, 332500, "the weak price is kept, never dropped");
  assert.equal(isLoanDerived(312500, 250000), true);
  assert.equal(isLoanDerived(300000, 250000), false);
});

test("uncoded recorded_full prices in IN/MO are LOW (non-disclosure signature), never HIGH", () => {
  for (const state of ["IN", "MO", "TX"]) {
    const nonRound = normalizeTransactionPrice({ price: 187346, price_code: null, price_source: "recorded_full", state });
    assert.equal(nonRound.source, PRICE_SOURCES.PROVIDER_UNCODED_NONDISCLOSURE, state);
    assert.equal(nonRound.confidence, CONFIDENCE.LOW);
    assert.equal(nonRound.is_estimated, true);
    assert.ok(nonRound.reasons.includes("PRICE_NOT_ROUND_IN_NONDISCLOSURE"));
    const round = normalizeTransactionPrice({ price: 187000, price_code: null, price_source: "recorded_full", state });
    assert.equal(round.confidence, CONFIDENCE.LOW);
    assert.equal(round.is_estimated, null, "a round price is not proof of a real price");
  }
});

test("Texas doc-stated amounts are MEDIUM unverified; equal to the loan they drop to LOW", () => {
  const stated = normalizeTransactionPrice({ price: 196000, price_code: "Full amount stated on Document.", state: "TX" });
  assert.equal(stated.confidence, CONFIDENCE.MEDIUM);
  assert.equal(stated.verified, false);
  assert.ok(stated.reasons.includes("NONDISCLOSURE_STATED_AMOUNT"));
  const loan = normalizeTransactionPrice({ price: 235000, price_code: "Full amount stated on Document.", state: "TX", concurrent_loan_amount: 235000 });
  assert.equal(loan.confidence, CONFIDENCE.LOW);
  assert.ok(loan.reasons.includes("PRICE_EQUALS_LOAN"));
});

test("pool MLS and public-record prices: HIGH in disclosure states, LOW in non-disclosure states", () => {
  assert.equal(normalizeTransactionPrice({ kind: "pool_mls", price: 315000, state: "MN" }).confidence, CONFIDENCE.HIGH);
  assert.equal(normalizeTransactionPrice({ kind: "pool_public_record", price: 315000, state: "GA" }).confidence, CONFIDENCE.HIGH);
  const txMls = normalizeTransactionPrice({ kind: "pool_mls", price: 219696, state: "TX" });
  assert.equal(txMls.source, PRICE_SOURCES.MLS);
  assert.equal(txMls.confidence, CONFIDENCE.LOW);
  assert.equal(txMls.is_estimated, true);
  const txPub = normalizeTransactionPrice({ kind: "pool_public_record", price: 195782, state: "TX" });
  assert.equal(txPub.source, PRICE_SOURCES.PROVIDER_UNCODED_NONDISCLOSURE);
});

test("no price, $0 and non-disclosure placeholders are UNKNOWN; a $10 disclosure deed keeps its class", () => {
  assert.equal(normalizeTransactionPrice({ price: null, state: "TX" }).confidence, CONFIDENCE.UNKNOWN);
  assert.equal(normalizeTransactionPrice({ kind: "pool_public_record", price: 0, state: "TX" }).confidence, CONFIDENCE.UNKNOWN);
  const placeholder = normalizeTransactionPrice({ kind: "pool_public_record", price: 500, state: "MO" });
  assert.equal(placeholder.confidence, CONFIDENCE.UNKNOWN);
  assert.ok(placeholder.reasons.includes("PLACEHOLDER_PRICE_NONDISCLOSURE"));
  const tenDollars = normalizeTransactionPrice({ price: 10, price_code: "Full amount stated on Document.", state: "GA" });
  assert.equal(tenDollars.confidence, CONFIDENCE.HIGH);
  assert.equal(tenDollars.transaction_price, 10);
});

test("transfer-tax, affidavit, assessment and non-market codes map to their classes", () => {
  const tt = normalizeTransactionPrice({ price: 285000, price_code: "Sales Price or Transfer Tax rounded by county prior to computation.", state: "MN" });
  assert.deepEqual([tt.source, tt.confidence, tt.verified], [PRICE_SOURCES.TRANSFER_TAX_DERIVED, CONFIDENCE.MEDIUM, true]);
  const partial = normalizeTransactionPrice({ price: 103136, price_code: "Partial amount computed from Transfer Tax.", state: "CA" });
  assert.equal(partial.confidence, CONFIDENCE.LOW);
  const aff = normalizeTransactionPrice({ price: 225000, price_code: "From recorded Affidavit of Value or Verified.", state: "MN" });
  assert.deepEqual([aff.source, aff.confidence], [PRICE_SOURCES.AFFIDAVIT_OF_VALUE, CONFIDENCE.MEDIUM]);
  const assess = normalizeTransactionPrice({ price: 25000, price_code: "Full amount from assessment file, when available.", state: "OH" });
  assert.deepEqual([assess.source, assess.is_estimated], [PRICE_SOURCES.DERIVED_ESTIMATE, true]);
  const tax = normalizeTransactionPrice({ price: 7468, price_code: "Sold for Taxes.", state: "FL" });
  assert.deepEqual([tax.source, tax.confidence, tax.verified], [PRICE_SOURCES.NON_MARKET_AMOUNT, CONFIDENCE.LOW, true]);
  const contra = normalizeTransactionPrice({ price: 16200, price_code: "Transfer Tax on document indicated as EXEMPT.", state: "CA" });
  assert.ok(contra.reasons.includes("CODE_CONTRADICTS_PRICE"));
  const unmapped = normalizeTransactionPrice({ price: 100000, price_code: "Some new vendor code", state: "CA" });
  assert.ok(unmapped.reasons.includes("UNMAPPED_PRICE_CODE"));
  assert.equal(unmapped.confidence, CONFIDENCE.LOW);
});

test("canonical price_source 'unknown' with a price, statutory states and price conflicts cap confidence", () => {
  const unk = normalizeTransactionPrice({ price: 370000, price_code: null, price_source: "unknown", state: "MN" });
  assert.equal(unk.confidence, CONFIDENCE.LOW);
  const la = normalizeTransactionPrice({ price: 150000, price_code: "Full amount stated on Document.", state: "LA" });
  assert.equal(la.confidence, CONFIDENCE.MEDIUM);
  const conflict = normalizeTransactionPrice({ price: 300000, price_code: null, price_source: "recorded_full", state: "FL", conflict_flags: ["price_mismatch"] });
  assert.equal(conflict.confidence, CONFIDENCE.MEDIUM);
});

test("taxonomy tables are internally consistent", () => {
  for (const [code, entry] of Object.entries(PRICE_CODE_MAP)) {
    assert.ok(SOURCE_PRIORITY.includes(entry.source), code);
    assert.ok(Object.values(CONFIDENCE).includes(entry.confidence), code);
    if (entry.is_estimated === true) assert.equal(entry.verified, false, `${code}: an estimate is never verified`);
  }
  assert.equal(jurisdictionClass("tx"), "nondisclosure_signature");
  assert.equal(jurisdictionClass("FL"), "disclosure");
  assert.equal(jurisdictionClass(null), "unknown");
  assert.equal(isReliablePrice(normalizeTransactionPrice({ price: 300000, price_code: "Estimated Sales Price", state: "TX" })), false);
  assert.equal(isReliablePrice(normalizeTransactionPrice({ price: 300000, price_code: null, state: "FL" })), true);
});
