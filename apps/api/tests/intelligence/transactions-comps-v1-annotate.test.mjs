import test from "node:test";
import assert from "node:assert/strict";

import { annotateRecords } from "../../scripts/intelligence/transactions/build-comps-v1.mjs";

const base = { region: "DFW", market: "DAL", pid: "p1", parcel_key: null, addr_key: "a1", unit_designator: false, lat: 32.7, lng: -96.8, zip: "75216", state: "TX", usable_comp: true, arms_length: null, nominal_flag: false, doc_type: "Warranty Deed", package_n: 0, dedup: null, ingested_at: "2026-08-08" };

test("comps-v1 annotation: a TX MLS pool row and the vendor-estimate deed of the same sale become one eligible transaction (confidence is diagnostic)", () => {
  const records = [
    { ...base, id: "P:x", src: "pool", sale_type: "mls", sale_date: "2026-05-02", mls_date: "2026-05-02", deed_date: "2026-05-06", price: 219696 },
    { ...base, id: "D:9", src: "deeds", sale_type: "deed", sale_date: "2026-05-06", deed_date: "2026-05-06", price: 327246, price_code: "Estimated Sales Price", corpus: "comp_corpus" },
    { ...base, id: "D:10", src: "deeds", sale_type: "deed", pid: "p2", addr_key: "a2", sale_date: "2026-05-06", deed_date: "2026-05-06", price: 150000, price_code: "Full amount stated on Document.", doc_type: "Trustee’s Deed", corpus: "comp_corpus" },
  ];
  const { transactions, stats } = annotateRecords(records);
  assert.equal(transactions.length, 2);
  assert.equal(stats.merged_records, 1);
  const [mls, deed, trustee] = records;
  assert.equal(mls.txn_id, deed.txn_id);
  assert.equal(mls.txn_role, "price_source", "both LOW; MLS ranks above the vendor estimate on the ladder");
  assert.equal(deed.txn_role, "provenance");
  assert.equal(deed.dedup.role, "loser");
  assert.equal(mls.price_eligible, true, "price > 0: eligible regardless of LOW confidence");
  assert.equal(mls.price_diagnostic_class, "weak_price");
  assert.equal(deed.price_eligible, false, "provenance records are never extra labels");
  assert.equal(deed.price_diagnostic_class, "provenance_duplicate");
  assert.equal(mls.price_confidence, "LOW");
  assert.equal(deed.price_estimated, true);
  assert.equal(trustee.price_eligible, true, "a distress deed with a price > 0 is still eligible");
  assert.equal(trustee.price_diagnostic_class, "market_context");
  assert.ok(trustee.price_diagnostic_reasons.includes("distress_or_transfer_deed"));
});
